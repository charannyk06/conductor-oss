import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import puppeteer, {
  type Browser,
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
  assertSafeDirectNavigationTarget,
  buildPreviewNavigationCandidates,
  isLocalHost,
  normalizeNavigationHostname,
  resolvePreviewNavigationMode,
} from "../lib/security.js";

const VIEWPORT = { width: 1440, height: 960 };
const LOG_LIMIT = 150;
const DOM_NODE_LIMIT = 250;
const CLEANUP_INTERVAL_MS = 30_000;
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
const CHROME_ARGS = [
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
  "--no-sandbox",
  "--disable-setuid-sandbox",
];

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

async function requestBridgePreview(
  session: PreviewSession,
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

  const response = await fetch(target, {
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
  });

  const body = await response.json().catch(() => null) as
    | { status?: number; headers?: Record<string, string>; body_base64?: string | null }
    | { error?: string }
    | null;

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

  constructor(
    private readonly config: PreviewWorkerConfig,
    private readonly sessionStore: SessionStore,
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
    const clientSessionId = options.clientSessionId?.trim() || null;
    if (clientSessionId) {
      const existing = this.sessionStore.findByApiKeyAndClientSessionId(apiKey, clientSessionId);
      if (existing) {
        existing.lastActivityAt = Date.now();
        existing.bridgePreview = options.bridgePreview ?? existing.bridgePreview;
        return existing;
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

    if (this.sessionStore.countByApiKey(apiKey) >= this.config.maxSessions) {
      throw this.error(429, "Preview session limit exceeded for this API key.");
    }

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: this.config.chromePath,
      defaultViewport: VIEWPORT,
      args: CHROME_ARGS,
    });

    const page = await browser.newPage();
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
      lastRequestedUrl: null,
    };

    this.attachListeners(session);
    session.activeFrameId = this.ensureFrameId(session, page.mainFrame());
    this.sessionStore.set(session);
    return session;
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

      return await this.withTimeout(
        handleWorkerCommand(this, session, command),
        this.config.chromeCommandTimeoutMs,
      );
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
      let targetUrl = candidate;

      try {
        targetUrl = navigationMode === "bridge"
          ? candidate
          : await this.resolveNavigationTarget(session, candidate);
        await this.syncRequestInterception(session, navigationMode === "bridge");
        await session.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await this.syncRequestInterception(session, navigationMode === "bridge");
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
    clearInterval(this.cleanupTimer);
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
    if (!targetUrl.includes(".trycloudflare.com")) {
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
      await assertSafeDirectNavigationTarget(candidate);
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

      void this.handleInterceptedRequest(session, request).catch(async (error) => {
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
      }
      if (session.selectedElement?.frameId === frameId) {
        session.selectedElement = null;
      }
    });
  }

  private async handleInterceptedRequest(
    session: PreviewSession,
    request: HTTPRequest,
  ): Promise<void> {
    const bridgePreview = session.bridgePreview;
    if (!bridgePreview) {
      await request.continue();
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

    const previewResponse = await requestBridgePreview(session, {
      method: request.method(),
      url: parsed.toString(),
      headers: sanitizeBridgePreviewRequestHeaders(request.headers()),
      bodyBase64: postData ? Buffer.from(postData).toString("base64") : null,
    });

    await request.respond({
      status: previewResponse.status,
      headers: previewResponse.headers,
      body: previewResponse.bodyBase64
        ? Buffer.from(previewResponse.bodyBase64, "base64")
        : Buffer.alloc(0),
    });
  }

  private async syncRequestInterception(session: PreviewSession, enabled: boolean): Promise<void> {
    if (session.requestInterceptionEnabled === enabled) {
      return;
    }

    await session.page.setRequestInterception(enabled);
    session.requestInterceptionEnabled = enabled;
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
    if (session.status === "closing") {
      return;
    }

    session.status = "closing";
    await stopTunnel(session.tunnelProcess);

    try {
      if (!session.page.isClosed()) {
        await session.page.close().catch(() => {});
      }
    } finally {
      await session.browser.close().catch(() => {});
      this.sessionStore.delete(session.id);
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
          timeoutId.unref();
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
