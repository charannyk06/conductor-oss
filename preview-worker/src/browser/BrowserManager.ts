import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import puppeteer, {
  type Browser,
  type CDPSession,
  type ConsoleMessage,
  type Frame,
  type HTTPRequest,
  type HTTPResponse,
} from "puppeteer-core";
import {
  Browser as PuppeteerBrowser,
  ChromeReleaseChannel,
  computeSystemExecutablePath,
} from "@puppeteer/browsers";
import { inspectDom } from "./dom.js";
import { handleWorkerCommand } from "./commands.js";
import { rewriteLoopbackUrl, startTunnel, stopTunnel } from "./tunnel.js";
import { SessionStore } from "../sessions/SessionStore.js";
import {
  PreviewWorkerError,
  type CreatePreviewSessionRequest,
  type PreviewDomResponse,
  type PreviewFrameInfo,
  type PreviewLogEntry,
  type PreviewSession,
  type PreviewStatusResponse,
  type PreviewWorkerConfig,
  type WorkerCommandRequest,
  type WorkerCommandResponse,
} from "../lib/types.js";
import {
  buildPreviewNavigationCandidates,
  isLocalHost,
  normalizeNavigationHostname,
  requestSafeDirectNavigation,
  resolvePreviewNavigationMode,
} from "../lib/security.js";

const VIEWPORT = { width: 1440, height: 960 };
const LOG_LIMIT = 150;
const DOM_NODE_LIMIT = 250;
const CLEANUP_INTERVAL_MS = 30_000;
const MAX_DIRECT_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_INTERCEPTED_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE_PAYLOAD_BYTES = 36 * 1024 * 1024;
const MAX_BROWSER_TEARDOWN_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_PREVIEW_REQUESTS = 32;
export const MAX_BUFFERED_PREVIEW_BYTES = 64 * 1024 * 1024;
export const BLOCKED_BROWSER_NETWORK_URL_PATTERNS = [
  "ws://*",
  "wss://*",
  "file://*",
  "ftp://*",
  "gopher://*",
] as const;
const RETRYABLE_TUNNEL_ERROR_MARKERS = [
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_QUIC_PROTOCOL_ERROR",
  "ERR_HTTP2_PROTOCOL_ERROR",
  "ERR_SSL_PROTOCOL_ERROR",
  "ERR_TUNNEL_CONNECTION_FAILED",
] as const;

export interface PreviewInterceptionBudget {
  activeRequests: number;
  bufferedBytes: number;
}

export interface PreviewInterceptionReservation {
  reserve(bytes: number): void;
  finish(): void;
}

export function beginPreviewInterception(
  budget: PreviewInterceptionBudget,
): PreviewInterceptionReservation {
  if (budget.activeRequests >= MAX_CONCURRENT_PREVIEW_REQUESTS) {
    throw new Error(
      `Preview request blocked: the session exceeded ${MAX_CONCURRENT_PREVIEW_REQUESTS} concurrent network requests.`,
    );
  }

  budget.activeRequests += 1;
  let heldBytes = 0;
  let finished = false;
  return {
    reserve(bytes: number): void {
      if (finished) {
        throw new Error("Preview request accounting reservation is already closed.");
      }
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Preview request accounting received an invalid byte count.");
      }
      if (bytes === 0) return;
      if (budget.bufferedBytes + bytes > MAX_BUFFERED_PREVIEW_BYTES) {
        throw new Error(
          "Preview request blocked: the session exceeded the 64 MiB buffered network-data limit.",
        );
      }
      budget.bufferedBytes += bytes;
      heldBytes += bytes;
    },
    finish(): void {
      if (finished) return;
      finished = true;
      budget.activeRequests = Math.max(0, budget.activeRequests - 1);
      budget.bufferedBytes = Math.max(0, budget.bufferedBytes - heldBytes);
    },
  };
}

export function retainDirectLoopbackOrigin(
  authorizedOrigin: string | null,
  nextUrl: string,
  navigationMode: "direct" | "bridge",
): string | null {
  if (!authorizedOrigin || navigationMode !== "direct") return null;
  try {
    const parsed = new URL(nextUrl);
    return isLocalHost(parsed.hostname) && parsed.origin === authorizedOrigin
      ? authorizedOrigin
      : null;
  } catch {
    return null;
  }
}

export async function installPreviewBrowserNetworkGuard(
  page: PreviewSession["page"],
  onBlockedWebSocket?: (url: string) => void,
): Promise<CDPSession> {
  const cdpSession = await page.createCDPSession();
  try {
    // Puppeteer's HTTP interception does not cover WebSocket handshakes, and the
    // Node-side DNS pinning below cannot be applied to Chromium's socket stack.
    // Fail closed for every WebSocket/non-HTTP network scheme at the CDP layer.
    await cdpSession.send("Network.enable");
    await cdpSession.send("Network.setBlockedURLs", {
      urls: [...BLOCKED_BROWSER_NETWORK_URL_PATTERNS],
    });
    cdpSession.on("Network.webSocketCreated", ({ url }) => {
      onBlockedWebSocket?.(url);
    });
    return cdpSession;
  } catch (error) {
    await cdpSession.detach().catch(() => {});
    throw new Error(
      `Failed to install the preview browser network guard: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sandboxDisabled(): boolean {
  return process.env.CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX?.trim().toLowerCase() === "true";
}

export function buildChromeArgs(): string[] {
  const args = [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--hide-scrollbars",
    "--mute-audio",
  ];
  if (sandboxDisabled()) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  return args;
}

function commandExists(command: string): string | null {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    const stdout = execFileSync(checker, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean);
    return match || null;
  } catch {
    return null;
  }
}

function commonBrowserPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }

  if (process.platform === "win32") {
    const programFiles = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value?.trim()));
    return programFiles.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
  }

  return [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium",
    "microsoft-edge",
    "brave-browser",
  ];
}

function resolveCommonBrowserExecutable(): string | null {
  for (const candidate of commonBrowserPaths()) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    const resolved = commandExists(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function resolveChromePath(): string {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (envPath) return envPath;

  const channels = [
    ChromeReleaseChannel.STABLE,
    ChromeReleaseChannel.CANARY,
    ChromeReleaseChannel.BETA,
    ChromeReleaseChannel.DEV,
  ] as const;

  for (const channel of channels) {
    try {
      return computeSystemExecutablePath({
        browser: PuppeteerBrowser.CHROME,
        channel,
      });
    } catch {
      // Keep looking for an installed browser.
    }
  }

  const commonExecutable = resolveCommonBrowserExecutable();
  if (commonExecutable) {
    return commonExecutable;
  }

  throw new Error(
    "Chrome/Chromium not found. Install a supported browser or set PUPPETEER_EXECUTABLE_PATH.",
  );
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function buildLogId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pushLog(target: PreviewLogEntry[], entry: PreviewLogEntry) {
  target.push(entry);
  if (target.length > LOG_LIMIT) {
    target.splice(0, target.length - LOG_LIMIT);
  }
}

function isAbortNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("net::err_aborted");
}

function urlsShareOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin;
  } catch {
    return left === right;
  }
}

type BridgePreviewResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string | null;
};

function previewAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Paired device preview response was aborted.");
}

async function readPreviewChunk<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw previewAbortError(signal);

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(previewAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedBridgePreviewJson(
  response: Response,
  reservation: PreviewInterceptionReservation,
  signal: AbortSignal,
): Promise<
  | { status?: number; headers?: Record<string, string>; body_base64?: string | null }
  | { error?: string }
  | null
> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BRIDGE_RESPONSE_PAYLOAD_BYTES) {
    throw new Error("Paired device preview response exceeded its buffered-data safety limit.");
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await readPreviewChunk(() => reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BRIDGE_RESPONSE_PAYLOAD_BYTES) {
        throw new Error("Paired device preview response exceeded its buffered-data safety limit.");
      }
      reservation.reserve(value.byteLength);
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }

  try {
    return JSON.parse(chunks.join("")) as
      | { status?: number; headers?: Record<string, string>; body_base64?: string | null }
      | { error?: string };
  } catch {
    return null;
  }
}

function sanitizeBridgePreviewRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) continue;
    if (
      normalized === "host"
      || normalized === "connection"
      || normalized === "proxy-connection"
      || normalized === "keep-alive"
      || normalized === "transfer-encoding"
      || normalized === "content-length"
      || normalized === "accept-encoding"
    ) {
      continue;
    }
    sanitized[normalized] = value;
  }
  return sanitized;
}

export async function requestBridgePreview(
  session: PreviewSession,
  reservation: PreviewInterceptionReservation,
  timeoutMs: number,
  payload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyBase64: string | null;
  },
): Promise<BridgePreviewResponse> {
  const bridgePreview = session.bridgePreview;
  if (!bridgePreview) {
    throw new Error("Bridge preview is not configured for this session.");
  }

  const target = new URL(`/api/devices/${encodeURIComponent(bridgePreview.bridgeId)}/preview`, bridgePreview.relayUrl);
  const headers = new Headers(bridgePreview.forwardedHeaders);
  headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new Error("Paired device preview request timed out."));
  }, timeoutMs);
  deadline.unref();

  let response: Response;
  let body:
    | { status?: number; headers?: Record<string, string>; body_base64?: string | null }
    | { error?: string }
    | null;
  try {
    response = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: bridgePreview.sessionId,
        method: payload.method,
        url: payload.url,
        headers: payload.headers,
        body_base64: payload.bodyBase64,
      }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });

    body = await readBoundedBridgePreviewJson(response, reservation, controller.signal);
  } finally {
    clearTimeout(deadline);
  }

  if (!response.ok) {
    throw new Error(
      body && typeof body === "object" && "error" in body && body.error
        ? body.error
        : "Failed to reach paired device preview",
    );
  }

  const previewBody = body && typeof body === "object"
    ? body as { status?: number; headers?: Record<string, string>; body_base64?: string | null }
    : null;

  return {
    status: typeof previewBody?.status === "number" ? previewBody.status : 502,
    headers: previewBody?.headers && typeof previewBody.headers === "object"
      ? previewBody.headers as Record<string, string>
      : {},
    bodyBase64: typeof previewBody?.body_base64 === "string" || previewBody?.body_base64 === null
      ? previewBody.body_base64 as string | null
      : undefined,
  };
}

export class BrowserManager {
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly pendingCreations = new Map<string, Promise<PreviewSession>>();
  private readonly activeCreations = new Set<Promise<PreviewSession>>();
  private readonly sessionDestructions = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly config: PreviewWorkerConfig,
    private readonly sessionStore: SessionStore,
    private readonly launchBrowser: (
      options: Parameters<typeof puppeteer.launch>[0],
    ) => Promise<Browser> = async (options) => await puppeteer.launch(options),
  ) {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  error(statusCode: number, message: string): PreviewWorkerError {
    return new PreviewWorkerError(statusCode, message);
  }

  async createSession(apiKey: string, options: CreatePreviewSessionRequest = {}): Promise<PreviewSession> {
    if (this.closed) {
      throw this.error(503, "Preview worker is shutting down.");
    }

    const clientSessionId = options.clientSessionId?.trim() || null;
    const creationKey = clientSessionId
      ? JSON.stringify([apiKey, clientSessionId])
      : null;

    if (creationKey) {
      const pending = this.pendingCreations.get(creationKey);
      if (pending) {
        return this.refreshReusedSession(await pending, options);
      }
    }

    const creation = this.createSessionWithReservation(apiKey, clientSessionId, options);
    this.activeCreations.add(creation);
    if (creationKey) {
      this.pendingCreations.set(creationKey, creation);
    }

    try {
      return this.refreshReusedSession(await creation, options);
    } finally {
      this.activeCreations.delete(creation);
      if (creationKey && this.pendingCreations.get(creationKey) === creation) {
        this.pendingCreations.delete(creationKey);
      }
    }
  }

  private refreshReusedSession(
    session: PreviewSession,
    options: CreatePreviewSessionRequest,
  ): PreviewSession {
    session.lastActivityAt = Date.now();
    session.bridgePreview = options.bridgePreview ?? session.bridgePreview;
    return session;
  }

  private async createSessionWithReservation(
    apiKey: string,
    clientSessionId: string | null,
    options: CreatePreviewSessionRequest,
  ): Promise<PreviewSession> {
    const existing = await this.sessionStore.runCreationExclusive(apiKey, async () => {
      const expiredSessions = this.sessionStore
        .listByApiKey(apiKey)
        .filter((session) => this.sessionStore.isExpired(session));
      await Promise.all(expiredSessions.map((session) => this.destroySessionInternal(session)));

      if (clientSessionId) {
        const current = this.sessionStore.findByApiKeyAndClientSessionId(apiKey, clientSessionId);
        if (current) {
          return current;
        }

        const legacySessions = this.sessionStore
          .listByApiKey(apiKey)
          .filter((session) => !session.clientSessionId)
          .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
        for (const legacySession of legacySessions) {
          await this.destroySessionInternal(legacySession);
          if (this.sessionStore.countByApiKey(apiKey) < this.config.maxSessions) {
            break;
          }
        }
      }

      if (!this.sessionStore.tryReserveCreation(apiKey, this.config.maxSessions)) {
        throw this.error(429, "Preview session limit exceeded for this API key.");
      }
      return null;
    });

    if (existing) {
      return existing;
    }

    let browser: Browser | null = null;
    let page: PreviewSession["page"] | null = null;
    try {
      browser = await this.launchBrowser({
        headless: true,
        executablePath: this.config.chromePath,
        defaultViewport: VIEWPORT,
        args: buildChromeArgs(),
      });

      page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      page.setDefaultNavigationTimeout(this.config.chromeCommandTimeoutMs);
      page.setDefaultTimeout(15_000);

      const session: PreviewSession = {
        id: randomUUID(),
        apiKey,
        clientSessionId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        browser,
        page,
        tunnelUrl: null,
        tunnelProcess: null,
        tunnelLocalOrigin: null,
        bridgePreview: options.bridgePreview ?? null,
        status: "active",
        activeFrameId: null,
        selectedElement: null,
        consoleLogs: [],
        networkLogs: [],
        lastError: null,
        frameIds: new WeakMap(),
        frameSequence: 0,
        requestStarts: new WeakMap(),
        requestInterceptionEnabled: false,
        navigationMode: "direct",
        directLoopbackOrigin: null,
        networkGuardSession: null,
        interceptionBudget: { activeRequests: 0, bufferedBytes: 0 },
        lastRequestedUrl: null,
      };

      session.networkGuardSession = await installPreviewBrowserNetworkGuard(page, (url) => {
        pushLog(session.networkLogs, {
          id: buildLogId("blocked-websocket"),
          kind: "network",
          level: "error",
          message: "Blocked WebSocket connection: preview sessions only permit controlled HTTP(S) network requests.",
          timestamp: new Date().toISOString(),
          url,
          method: "GET",
          status: null,
          resourceType: "websocket",
        });
      });
      this.attachListeners(session);
      session.activeFrameId = this.ensureFrameId(session, page.mainFrame());
      this.sessionStore.set(session);
      return session;
    } catch (error) {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      await browser?.close().catch(() => {});
      throw error;
    } finally {
      this.sessionStore.releaseCreation(apiKey);
    }
  }

  getSession(sessionId: string): PreviewSession | null {
    const session = this.sessionStore.get(sessionId);
    return session ?? null;
  }

  async executeCommand(
    sessionId: string,
    command: WorkerCommandRequest,
  ): Promise<WorkerCommandResponse> {
    return await this.sessionStore.runExclusive(sessionId, async () => {
      const session = await this.requireActiveSession(sessionId);
      this.sessionStore.touch(sessionId);
      const operation = handleWorkerCommand(this, session, command);
      try {
        return await this.withTimeout(operation, this.config.chromeCommandTimeoutMs);
      } catch (error) {
        const timedOut = error instanceof PreviewWorkerError && error.statusCode === 408;
        const browserTargetClosed = session.page.isClosed() || session.browser.connected === false;
        if (timedOut) {
          session.lastError = error.message;
        }
        if (timedOut || browserTargetClosed) {
          await this.destroySessionInternal(session);
        }
        throw error;
      }
    });
  }

  async buildStatus(
    session: PreviewSession,
    candidateUrls: string[],
  ): Promise<PreviewStatusResponse> {
    const frames = this.collectFrames(session);
    let title: string | null = null;
    if (session.page.url() !== "about:blank") {
      try {
        title = await session.page.title();
      } catch {
        title = null;
      }
    }

    const { canGoBack, canGoForward } = await this.getNavigationCapabilities(session);

    return {
      connected: session.page.url() !== "about:blank",
      candidateUrls,
      currentUrl: session.page.url() !== "about:blank"
        ? this.toDisplayUrl(session, session.page.url())
        : null,
      title,
      tunnelUrl: session.tunnelUrl,
      tunnelLocalOrigin: session.tunnelLocalOrigin,
      canGoBack,
      canGoForward,
      frames,
      activeFrameId: session.activeFrameId,
      selectedElement: session.selectedElement,
      consoleLogs: [...session.consoleLogs],
      networkLogs: [...session.networkLogs],
      lastError: session.lastError,
      screenshotKey: `${Date.now()}`,
    };
  }

  private toDisplayUrl(session: PreviewSession, url: string): string {
    if (session.tunnelUrl && session.tunnelLocalOrigin && url.startsWith(session.tunnelUrl)) {
      return `${session.tunnelLocalOrigin}${url.slice(session.tunnelUrl.length)}`;
    }
    return url;
  }

  private async getNavigationCapabilities(session: PreviewSession): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    if (session.page.url() === "about:blank") {
      return { canGoBack: false, canGoForward: false };
    }

    let cdpSession: Awaited<ReturnType<PreviewSession["page"]["createCDPSession"]>> | null = null;
    try {
      cdpSession = await session.page.createCDPSession();
      const history = await cdpSession.send("Page.getNavigationHistory") as {
        currentIndex: number;
        entries: Array<unknown>;
      };
      return {
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
      };
    } catch {
      return {
        canGoBack: false,
        canGoForward: false,
      };
    } finally {
      await cdpSession?.detach().catch(() => null);
    }
  }

  async inspectDom(
    session: PreviewSession,
    frameId: string | null,
    interactiveOnly: boolean,
  ): Promise<PreviewDomResponse> {
    const frame = this.resolveFrame(session, frameId);
    const result = await inspectDom(frame, interactiveOnly, DOM_NODE_LIMIT);
    return {
      frameId: this.ensureFrameId(session, frame),
      nodes: result.nodes,
      truncated: result.truncated,
    };
  }

  async takeScreenshot(session: PreviewSession): Promise<Uint8Array | null> {
    if (session.page.url() === "about:blank") {
      return null;
    }

    return await session.page.screenshot({ type: "png" }) as Uint8Array;
  }

  async connect(session: PreviewSession, url: string): Promise<void> {
    const candidates = buildPreviewNavigationCandidates(url);
    let lastError: unknown = null;

    for (const candidate of candidates) {
      const navigationMode = resolvePreviewNavigationMode(candidate, session.bridgePreview);
      if (navigationMode === "blocked") {
        lastError = new Error("Bridge preview only allows navigation to the session's reported local dev server origin.");
        continue;
      }

      const previousUrl = session.page.url();
      const previousNavigationMode = session.navigationMode;
      const previousDirectLoopbackOrigin = session.directLoopbackOrigin;
      let targetUrl = candidate;

      try {
        targetUrl = navigationMode === "bridge"
          ? candidate
          : await this.resolveNavigationTarget(session, candidate);
        session.navigationMode = navigationMode;
        session.directLoopbackOrigin = navigationMode === "direct" && isLocalHost(new URL(targetUrl).hostname)
          ? new URL(targetUrl).origin
          : null;
        await this.syncRequestInterception(session, true);
        await session.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await this.syncRequestInterception(session, true);

        session.selectedElement = null;
        session.lastError = null;
        session.activeFrameId = this.ensureFrameId(session, session.page.mainFrame());
        session.lastRequestedUrl = candidate;
        return;
      } catch (error) {
        if (navigationMode !== "bridge" && this.shouldResetTunnel(targetUrl, error)) {
          await this.resetTunnel(session);
        }

        if (await this.navigationProducedUsablePage(session.page, targetUrl, previousUrl, error)) {
          await this.syncRequestInterception(session, navigationMode === "bridge");
          session.selectedElement = null;
          session.lastError = null;
          session.activeFrameId = this.ensureFrameId(session, session.page.mainFrame());
          session.lastRequestedUrl = candidate;
          return;
        }

        session.navigationMode = previousNavigationMode;
        session.directLoopbackOrigin = retainDirectLoopbackOrigin(
          previousDirectLoopbackOrigin,
          session.page.url(),
          previousNavigationMode,
        );
        lastError = error;
      }
    }

    session.lastError = lastError instanceof Error ? lastError.message : "Failed to connect preview";
    throw lastError ?? this.error(500, "Failed to connect preview");
  }

  ensureFrameId(session: PreviewSession, frame: Frame): string {
    const current = session.frameIds.get(frame);
    if (current) return current;
    const next = `frame-${++session.frameSequence}`;
    session.frameIds.set(frame, next);
    return next;
  }

  resolveFrame(session: PreviewSession, frameId?: string | null): Frame {
    const targetId = frameId ?? session.activeFrameId;
    const frames = session.page.frames();
    if (!targetId) {
      return session.page.mainFrame();
    }

    return frames.find((frame) => this.ensureFrameId(session, frame) === targetId) ?? session.page.mainFrame();
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw this.error(404, `Preview session ${sessionId} was not found.`);
    }
    await this.destroySessionInternal(session);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.activeCreations]);
    await Promise.all(this.sessionStore.list().map((session) => this.destroySessionInternal(session)));
  }

  private async requireActiveSession(sessionId: string): Promise<PreviewSession> {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw this.error(404, `Preview session ${sessionId} was not found or expired.`);
    }

    if (session.status === "closing") {
      throw this.error(404, `Preview session ${sessionId} is closing.`);
    }

    if (session.page.isClosed() || session.browser.connected === false) {
      await this.destroySessionInternal(session);
      throw this.error(404, `Preview session ${sessionId} browser target is unavailable.`);
    }

    if (this.sessionStore.isExpired(session)) {
      await this.destroySessionInternal(session);
      throw this.error(404, `Preview session ${sessionId} expired due to inactivity.`);
    }

    return session;
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const expiredSessions = this.sessionStore.getExpiredSessions();
    await Promise.all(expiredSessions.map((session) => this.destroySessionInternal(session)));
  }

  private shouldResetTunnel(targetUrl: string, error: unknown): boolean {
    try {
      const hostname = new URL(targetUrl).hostname.toLowerCase();
      if (!hostname.endsWith(".trycloudflare.com")) {
        return false;
      }
    } catch {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return RETRYABLE_TUNNEL_ERROR_MARKERS.some((marker) => message.includes(marker));
  }

  private async resetTunnel(session: PreviewSession): Promise<void> {
    await stopTunnel(session.tunnelProcess);
    session.tunnelUrl = null;
    session.tunnelProcess = null;
    session.tunnelLocalOrigin = null;
  }

  private async resolveNavigationTarget(
    session: PreviewSession,
    candidate: string,
  ): Promise<string> {
    const parsed = new URL(candidate);
    if (!isLocalHost(normalizeNavigationHostname(parsed.hostname))) {
      return candidate;
    }

    const localOrigin = new URL(candidate);
    localOrigin.pathname = "";
    localOrigin.search = "";
    localOrigin.hash = "";
    const normalizedOrigin = localOrigin.toString();

    if (!session.tunnelUrl || session.tunnelLocalOrigin !== normalizedOrigin) {
      await this.resetTunnel(session);

      let lastTunnelError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const tunnel = await startTunnel(normalizedOrigin, this.config.cloudflaredBin);
          if (session.status === "closing") {
            await stopTunnel(tunnel.process);
            throw this.error(410, "Preview session closed while its tunnel was starting.");
          }
          session.tunnelUrl = tunnel.url;
          session.tunnelProcess = tunnel.process;
          session.tunnelLocalOrigin = tunnel.localOrigin;
          lastTunnelError = null;
          break;
        } catch (error) {
          lastTunnelError = error;
          session.tunnelUrl = null;
          session.tunnelProcess = null;
          session.tunnelLocalOrigin = null;
          if (session.status === "closing") {
            throw error;
          }
        }
      }

      if (lastTunnelError) {
        throw lastTunnelError;
      }
    }

    const tunnelUrl = session.tunnelUrl;
    if (!tunnelUrl) {
      throw this.error(500, "Failed to establish a localhost preview tunnel.");
    }

    const rewritten = rewriteLoopbackUrl(candidate, tunnelUrl);
    if (!rewritten) {
      throw this.error(500, "Failed to rewrite localhost preview URL through the tunnel.");
    }

    return rewritten;
  }

  private attachListeners(session: PreviewSession): void {
    const { page } = session;

    page.on("console", (message) => {
      this.captureConsole(session, message);
    });
    page.on("pageerror", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(session.consoleLogs, {
        id: buildLogId("pageerror"),
        kind: "pageerror",
        level: "error",
        message,
        timestamp: new Date().toISOString(),
      });
      session.lastError = message;
    });
    page.on("request", (request) => {
      session.requestStarts.set(request, Date.now());
      if (!session.requestInterceptionEnabled) {
        return;
      }

      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        session.directLoopbackOrigin = retainDirectLoopbackOrigin(
          session.directLoopbackOrigin,
          request.url(),
          session.navigationMode,
        );
      }

      let reservation: PreviewInterceptionReservation;
      try {
        reservation = beginPreviewInterception(session.interceptionBudget);
      } catch (error) {
        session.lastError = error instanceof Error ? error.message : "Preview request capacity exceeded";
        pushLog(session.networkLogs, {
          id: buildLogId("preview-capacity"),
          kind: "network",
          level: "error",
          message: session.lastError,
          timestamp: new Date().toISOString(),
          url: request.url(),
          method: request.method(),
          status: null,
          resourceType: request.resourceType(),
        });
        void request.abort("blockedbyclient").catch(() => {});
        return;
      }

      void this.handleInterceptedRequest(session, request, reservation).catch(async (error) => {
        session.lastError = error instanceof Error ? error.message : "Preview request interception failed";
        pushLog(session.networkLogs, {
          id: buildLogId("preview-request"),
          kind: "network",
          level: "error",
          message: session.lastError,
          timestamp: new Date().toISOString(),
          url: request.url(),
          method: request.method(),
          status: null,
          resourceType: request.resourceType(),
        });
        try {
          await request.abort("failed");
        } catch {
          // Ignore duplicate request resolution failures.
        }
      }).finally(() => {
        reservation.finish();
      });
    });
    page.on("response", (response) => {
      this.captureResponse(session, response);
    });
    page.on("requestfailed", (request) => {
      pushLog(session.networkLogs, {
        id: buildLogId("requestfailed"),
        kind: "network",
        level: "error",
        message: request.failure()?.errorText ?? "Request failed",
        timestamp: new Date().toISOString(),
        url: request.url(),
        method: request.method(),
        status: null,
        resourceType: request.resourceType(),
      });
    });
    page.on("framenavigated", (frame) => {
      const frameId = this.ensureFrameId(session, frame);
      if (frame === page.mainFrame()) {
        session.activeFrameId ??= frameId;
        session.directLoopbackOrigin = retainDirectLoopbackOrigin(
          session.directLoopbackOrigin,
          frame.url(),
          session.navigationMode,
        );
      }
      if (session.selectedElement?.frameId === frameId) {
        session.selectedElement = null;
      }
    });
  }

  private async handleInterceptedRequest(
    session: PreviewSession,
    request: HTTPRequest,
    reservation: PreviewInterceptionReservation,
  ): Promise<void> {
    const bridgePreview = session.bridgePreview;
    if (session.navigationMode === "direct") {
      let parsed: URL;
      try {
        parsed = new URL(request.url());
      } catch {
        await request.abort("blockedbyclient");
        return;
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Preview request blocked: only controlled HTTP(S) requests are allowed.");
      }

      const postData = request.hasPostData() ? request.postData() : null;
      if (request.hasPostData() && postData === undefined) {
        throw new Error("Preview request blocked: its request body was unavailable for bounded inspection.");
      }
      const postDataBytes = postData === null || postData === undefined
        ? 0
        : Buffer.byteLength(postData);
      if (postDataBytes > MAX_INTERCEPTED_REQUEST_BODY_BYTES) {
        throw new Error("Preview request blocked: its body exceeded the 8 MiB safety limit.");
      }
      reservation.reserve(postDataBytes);
      const requestBody = postData === null || postData === undefined ? null : Buffer.from(postData);
      reservation.reserve(requestBody?.length ?? 0);
      const previewResponse = await requestSafeDirectNavigation({
        method: request.method(),
        url: parsed.toString(),
        headers: request.headers(),
        body: requestBody,
        timeoutMs: this.config.chromeCommandTimeoutMs,
        allowLoopback: session.directLoopbackOrigin === parsed.origin,
        reserveBufferedBytes: (bytes) => reservation.reserve(bytes),
      });
      await request.respond({
        status: previewResponse.status,
        headers: previewResponse.headers,
        body: previewResponse.body,
      });
      return;
    }

    if (!bridgePreview) {
      await request.abort("blockedbyclient");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(request.url());
    } catch {
      await request.abort("blockedbyclient");
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol != "https:") {
      await request.abort("blockedbyclient");
      return;
    }

    if (!bridgePreview.allowedOrigins.includes(parsed.origin)) {
      await request.abort("blockedbyclient");
      return;
    }

    const postData = request.method() === "GET" || request.method() === "HEAD"
      ? null
      : request.postData() ?? null;
    const postDataBytes = postData ? Buffer.byteLength(postData) : 0;
    if (postDataBytes > MAX_INTERCEPTED_REQUEST_BODY_BYTES) {
      throw new Error("Preview request blocked: its body exceeded the 8 MiB safety limit.");
    }
    reservation.reserve(postDataBytes);
    const bodyBase64 = postData ? Buffer.from(postData).toString("base64") : null;
    reservation.reserve(bodyBase64 ? Buffer.byteLength(bodyBase64) : 0);

    const previewResponse = await requestBridgePreview(
      session,
      reservation,
      this.config.chromeCommandTimeoutMs,
      {
        method: request.method(),
        url: parsed.toString(),
        headers: sanitizeBridgePreviewRequestHeaders(request.headers()),
        bodyBase64,
      },
    );

    const responseBodyBytes = previewResponse.bodyBase64
      ? Math.floor((previewResponse.bodyBase64.length * 3) / 4)
      : 0;
    if (responseBodyBytes > MAX_DIRECT_RESPONSE_BYTES) {
      throw new Error("Preview response exceeded the 25 MiB safety limit.");
    }
    reservation.reserve(responseBodyBytes);
    const responseBody = previewResponse.bodyBase64
      ? Buffer.from(previewResponse.bodyBase64, "base64")
      : Buffer.alloc(0);

    await request.respond({
      status: previewResponse.status,
      headers: previewResponse.headers,
      body: responseBody,
    });
  }

  private async syncRequestInterception(session: PreviewSession, _enabled: boolean): Promise<void> {
    // Direct mode relies on the pinned HTTP client and bridge mode relies on relay fulfillment.
    // Letting either mode fall through to Chromium would bypass its network boundary.
    const shouldIntercept = true;
    if (session.requestInterceptionEnabled === shouldIntercept) {
      return;
    }

    await session.page.setRequestInterception(shouldIntercept);
    session.requestInterceptionEnabled = shouldIntercept;
  }

  private collectFrames(session: PreviewSession): PreviewFrameInfo[] {
    const frames = session.page.frames().map((frame) => {
      const id = this.ensureFrameId(session, frame);
      const parent = frame.parentFrame();
      return {
        id,
        name: frame.name() || (frame === session.page.mainFrame() ? "Main frame" : "Untitled frame"),
        url: frame.url(),
        parentId: parent ? this.ensureFrameId(session, parent) : null,
        isMain: frame === session.page.mainFrame(),
      };
    });

    const activeFrameExists = frames.some((frame) => frame.id === session.activeFrameId);
    if (!activeFrameExists) {
      session.activeFrameId = frames.find((frame) => frame.isMain)?.id ?? frames[0]?.id ?? null;
    }
    if (session.selectedElement && !frames.some((frame) => frame.id === session.selectedElement?.frameId)) {
      session.selectedElement = null;
    }

    return frames;
  }

  private async navigationProducedUsablePage(
    page: PreviewSession["page"],
    targetUrl: string,
    previousUrl: string,
    error: unknown,
  ): Promise<boolean> {
    if (!isAbortNavigationError(error)) {
      return false;
    }

    const currentUrl = page.url();
    if (currentUrl === "about:blank") {
      return false;
    }

    if (currentUrl === previousUrl && !urlsShareOrigin(currentUrl, targetUrl)) {
      return false;
    }

    if (!urlsShareOrigin(currentUrl, targetUrl)) {
      return false;
    }

    try {
      const readyState = await page.evaluate(() => document.readyState);
      return readyState === "interactive" || readyState === "complete";
    } catch {
      return false;
    }
  }

  private captureConsole(session: PreviewSession, message: ConsoleMessage): void {
    const location = message.location();
    pushLog(session.consoleLogs, {
      id: buildLogId("console"),
      kind: "console",
      level: message.type(),
      message: normalizeText(message.text()),
      timestamp: new Date().toISOString(),
      url: location.url ?? null,
    });
  }

  private captureResponse(session: PreviewSession, response: HTTPResponse): void {
    const request = response.request();
    pushLog(session.networkLogs, {
      id: buildLogId("network"),
      kind: "network",
      level: response.ok() ? "info" : "error",
      message: `${request.method()} ${response.status()} ${normalizeText(response.statusText())}`.trim(),
      timestamp: new Date().toISOString(),
      url: response.url(),
      method: request.method(),
      status: response.status(),
      resourceType: request.resourceType(),
    });
  }

  private async destroySessionInternal(session: PreviewSession): Promise<void> {
    const current = this.sessionDestructions.get(session.id);
    if (current) {
      return await current;
    }

    const destruction = (async () => {
      session.status = "closing";
      const gracefulTeardown = (async () => {
        await stopTunnel(session.tunnelProcess).catch(() => {});
        await session.networkGuardSession?.detach().catch(() => {});
        session.networkGuardSession = null;
        if (!session.page.isClosed()) {
          await session.page.close().catch(() => {});
        }
        await session.browser.close().catch(() => {});
      })();
      const teardownTimeoutMs = Math.max(
        1,
        Math.min(this.config.chromeCommandTimeoutMs, MAX_BROWSER_TEARDOWN_TIMEOUT_MS),
      );
      let timeoutId: NodeJS.Timeout | null = null;
      const timedOut = await Promise.race([
        gracefulTeardown.then(() => false),
        new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => resolve(true), teardownTimeoutMs);
          timeoutId.unref();
        }),
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (timedOut || session.browser.connected) {
        try {
          session.browser.process()?.kill("SIGKILL");
        } catch {
          // The browser may already have exited while teardown was timing out.
        }
        try {
          session.browser.disconnect();
        } catch {
          // The browser may already be disconnected after a forced process exit.
        }
      }
      this.sessionStore.delete(session.id);
    })();
    this.sessionDestructions.set(session.id, destruction);

    try {
      await destruction;
    } finally {
      if (this.sessionDestructions.get(session.id) === destruction) {
        this.sessionDestructions.delete(session.id);
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(this.error(408, "Preview command timed out."));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
