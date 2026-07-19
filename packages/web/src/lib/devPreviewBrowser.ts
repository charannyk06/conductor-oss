import { lookup } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import puppeteer, {
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Frame,
  type HTTPRequest,
  type HTTPResponse,
  type KeyInput,
  type Page,
} from "puppeteer-core";
import {
  Browser as PuppeteerBrowser,
  ChromeReleaseChannel,
  computeSystemExecutablePath,
} from "@puppeteer/browsers";
import { resolveRustBackendUrl } from "@/lib/backendUrl";
import { requestBridgePreview } from "@/lib/bridgeApiProxy";
import type { BridgePreviewConfig } from "@/lib/previewSession";
import type {
  PreviewCommandRequest,
  PreviewDomNode,
  PreviewElementSelection,
  PreviewFrameInfo,
  PreviewLogEntry,
  PreviewStatusResponse,
} from "@/lib/previewTypes";
import { getPreviewWorkerClient } from "@/lib/previewWorkerClient";

const VIEWPORT = { width: 1440, height: 960 };
const LOG_LIMIT = 150;
const DOM_NODE_LIMIT = 250;
const LOCAL_NAVIGATION_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"] as const;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const BARE_LOCAL_NAVIGATION_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/.*)?$/i;
const MAX_DIRECT_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_INTERCEPTED_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_RESPONSE_PAYLOAD_BYTES = 36 * 1024 * 1024;
export const MAX_CONCURRENT_PREVIEW_REQUESTS = 32;
export const MAX_BUFFERED_PREVIEW_BYTES = 64 * 1024 * 1024;
export const BLOCKED_BROWSER_NETWORK_URL_PATTERNS = [
  "ws://*",
  "wss://*",
  "file://*",
  "ftp://*",
  "gopher://*",
] as const;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface NavigationAddress {
  address: string;
  family: number;
}

export interface ResolvedDirectNavigationTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface DirectNavigationResolveOptions {
  allowLoopback?: boolean;
  resolver?: (hostname: string) => Promise<NavigationAddress[]>;
}

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
  page: Page,
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
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      process.env["LOCALAPPDATA"],
    ].filter((value): value is string => Boolean(value?.trim()));
    return programFiles.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
  }

  return [
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

function resolveChromePath(): string {
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
      // Channel not installed, try next
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

function normalizeNavigationHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function normalizeNavigationInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (URL_SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (BARE_LOCAL_NAVIGATION_PATTERN.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function isLocalHost(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  return LOCAL_NAVIGATION_HOSTS.includes(normalized as (typeof LOCAL_NAVIGATION_HOSTS)[number]);
}

function unsafePreviewHostsAllowed(): boolean {
  return process.env.CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS?.trim().toLowerCase() === "true";
}

function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split(".").map((segment) => Number.parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

export function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  const lower = normalized.toLowerCase();
  const mappedIpv4 = lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : null;
  return lower === "::"
    || lower === "::1"
    || lower.startsWith("fe8")
    || lower.startsWith("fe9")
    || lower.startsWith("fea")
    || lower.startsWith("feb")
    || lower.startsWith("fc")
    || lower.startsWith("fd")
    || lower.startsWith("ff")
    || (mappedIpv4 ? isPrivateIpv4Address(mappedIpv4) : false);
}

function hostnameResolvesToPrivateAddress(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4Address(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateNetworkHostname(normalized);
  }
  return false;
}

function isLoopbackAddress(hostname: string): boolean {
  const normalized = normalizeNavigationHostname(hostname);
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  const mappedIpv4 = normalized.toLowerCase().startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  return mappedIpv4 === "0.0.0.0" || mappedIpv4.startsWith("127.");
}

async function defaultResolver(hostname: string): Promise<NavigationAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true });
}

export async function resolveSafeDirectNavigationTarget(
  value: string,
  options: DirectNavigationResolveOptions = {},
): Promise<ResolvedDirectNavigationTarget> {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Preview navigation only supports HTTP and HTTPS targets.");
  }

  const hostname = normalizeNavigationHostname(parsed.hostname);
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await (options.resolver ?? defaultResolver)(hostname);
  if (resolved.length === 0) {
    throw new Error(`Preview navigation could not resolve ${hostname}.`);
  }

  const normalized = resolved.map((entry) => ({
    address: normalizeNavigationHostname(entry.address),
    family: entry.family === 6 ? 6 as const : 4 as const,
  }));
  const localHostAllowed = options.allowLoopback !== false && isLocalHost(hostname);
  if (localHostAllowed && normalized.some((entry) => !isLoopbackAddress(entry.address))) {
    throw new Error("Preview loopback navigation resolved outside the loopback interface and was blocked.");
  }
  if (
    !unsafePreviewHostsAllowed()
    && !localHostAllowed
    && normalized.some((entry) => hostnameResolvesToPrivateAddress(entry.address))
  ) {
    throw new Error(
      "Preview navigation resolved to a private network address and was blocked. Set CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS=true only if you intentionally trust that target.",
    );
  }

  const selected = normalized.find((entry) => entry.family === 4) ?? normalized[0];
  if (!selected) {
    throw new Error(`Preview navigation could not resolve ${hostname}.`);
  }
  return { url: parsed, address: selected.address, family: selected.family };
}

export async function assertSafeDirectNavigationTarget(
  value: string,
  options: DirectNavigationResolveOptions = {},
): Promise<void> {
  await resolveSafeDirectNavigationTarget(value, options);
}

function sanitizeDirectRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || normalized === "host" || normalized === "content-length") continue;
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    sanitized[normalized] = value;
  }
  return sanitized;
}

function sanitizeDirectResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    sanitized[normalized] = value;
  }
  return sanitized;
}

export function buildPinnedRequestOptions(
  target: ResolvedDirectNavigationTarget,
  method: string,
  headers: Record<string, string>,
  bodyLength = 0,
): HttpsRequestOptions {
  const forwardedHeaders = sanitizeDirectRequestHeaders(headers);
  forwardedHeaders.host = target.url.host;
  if (bodyLength > 0) {
    forwardedHeaders["content-length"] = String(bodyLength);
  }

  return {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
    method,
    path: `${target.url.pathname}${target.url.search}`,
    headers: forwardedHeaders,
    ...(target.url.protocol === "https:" && isIP(target.url.hostname) === 0
      ? { servername: target.url.hostname }
      : {}),
  };
}

export async function requestSafeDirectNavigation(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  timeoutMs: number;
  allowLoopback: boolean;
  reserveBufferedBytes?: (bytes: number) => void;
}): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  const target = await resolveSafeDirectNavigationTarget(input.url, {
    allowLoopback: input.allowLoopback,
  });
  const body = input.body ? Buffer.from(input.body) : Buffer.alloc(0);
  const requestOptions = buildPinnedRequestOptions(target, input.method, input.headers, body.length);
  const requestImpl = target.url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      callback();
    };
    const outgoing = requestImpl(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_DIRECT_RESPONSE_BYTES) {
          response.destroy(new Error("Preview response exceeded the 25 MiB safety limit."));
          return;
        }
        try {
          input.reserveBufferedBytes?.(buffer.length);
        } catch (error) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", (error) => settle(() => reject(error)));
      response.once("end", () => {
        try {
          if (received > 0) {
            input.reserveBufferedBytes?.(received);
          }
          const result = {
            status: response.statusCode ?? 502,
            headers: sanitizeDirectResponseHeaders(response.headers),
            body: Buffer.concat(chunks),
          };
          settle(() => resolve(result));
        } catch (error) {
          settle(() => reject(error));
        }
      });
    });
    deadline = setTimeout(() => {
      outgoing.destroy(new Error("Preview network request timed out."));
    }, input.timeoutMs);
    deadline.unref();
    outgoing.once("error", (error) => settle(() => reject(error)));
    if (body.length > 0) {
      outgoing.write(body);
    }
    outgoing.end();
  });
}

export type PreviewNavigationMode = "bridge" | "direct" | "blocked";

export function resolvePreviewNavigationMode(
  value: string,
  bridgePreview: BridgePreviewConfig | null,
): PreviewNavigationMode {
  if (!bridgePreview) {
    return "direct";
  }

  try {
    const parsed = new URL(value);
    const isLocal = isLocalHost(normalizeNavigationHostname(parsed.hostname));
    if (bridgePreview.allowedOrigins.includes(parsed.origin)) {
      return "bridge";
    }
    return isLocal ? "blocked" : "direct";
  } catch {
    return "direct";
  }
}

export function buildPreviewNavigationCandidates(value: string): string[] {
  const normalizedInput = normalizeNavigationInput(value);
  try {
    const parsed = new URL(normalizedInput);
    const normalized = parsed.toString();
    const hostname = normalizeNavigationHostname(parsed.hostname);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(
        `Navigation blocked: only http and https URLs are allowed. Got protocol "${parsed.protocol}".`,
      );
    }

    if (isLocalHost(hostname)) {
      const variants = new Set<string>([normalized]);
      for (const hostname of LOCAL_NAVIGATION_HOSTS) {
        const candidate = new URL(normalized);
        candidate.hostname = hostname;
        variants.add(candidate.toString());
      }
      return [...variants];
    }

    return [normalized];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Navigation blocked:")) {
      throw error;
    }
    throw new Error(
      `Navigation blocked: could not parse "${normalizedInput}" as a valid URL.`,
    );
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

type BridgePreviewRuntimeConfig = BridgePreviewConfig & {
  forwardedHeaders: Record<string, string>;
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

type PreviewState = {
  sessionId: string;
  context: BrowserContext | null;
  page: Page | null;
  destroying: boolean;
  activeFrameId: string | null;
  selectedElement: PreviewElementSelection | null;
  consoleLogs: PreviewLogEntry[];
  networkLogs: PreviewLogEntry[];
  lastError: string | null;
  frameIds: WeakMap<Frame, string>;
  requestStarts: WeakMap<HTTPRequest, number>;
  frameSequence: number;
  bridgePreview: BridgePreviewRuntimeConfig | null;
  requestInterceptionEnabled: boolean;
  navigationMode: "direct" | "bridge";
  directLoopbackOrigin: string | null;
  networkGuardSession: CDPSession | null;
  interceptionBudget: PreviewInterceptionBudget;
};

type ElementSnapshot = Omit<PreviewElementSelection, "frameId" | "frameName" | "frameUrl">;

const globalForPreviewBrowser = globalThis as typeof globalThis & {
  _conductorPreviewBrowserManager?: PreviewBrowserManager;
};

function pushLog(target: PreviewLogEntry[], entry: PreviewLogEntry) {
  target.push(entry);
  if (target.length > LOG_LIMIT) {
    target.splice(0, target.length - LOG_LIMIT);
  }
}

function buildLogId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export interface PreviewNavigationHistoryEntry {
  url?: string | null;
}

export function resolvePreviewNavigationCapabilities(
  currentIndex: number,
  entries: PreviewNavigationHistoryEntry[],
): { canGoBack: boolean; canGoForward: boolean } {
  const isUsableEntry = (entry: PreviewNavigationHistoryEntry | undefined): boolean => {
    const url = entry?.url?.trim();
    return Boolean(url && url !== "about:blank");
  };

  return {
    canGoBack: currentIndex > 0 && isUsableEntry(entries[currentIndex - 1]),
    canGoForward: currentIndex >= 0
      && currentIndex < entries.length - 1
      && isUsableEntry(entries[currentIndex + 1]),
  };
}

export type PreviewBrowserLauncher = () => Promise<Browser>;

function launchSystemPreviewBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: resolveChromePath(),
    defaultViewport: VIEWPORT,
    args: [
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

export class PreviewBrowserManager {
  private browserPromise: Promise<Browser> | null = null;
  private states = new Map<string, PreviewState>();

  constructor(private readonly launchBrowser: PreviewBrowserLauncher = launchSystemPreviewBrowser) {}

  private resetDisconnectedBrowserStates(): void {
    for (const state of this.states.values()) {
      state.context = null;
      state.page = null;
      state.networkGuardSession = null;
      state.requestInterceptionEnabled = false;
      state.activeFrameId = null;
      state.selectedElement = null;
      state.navigationMode = "direct";
      state.directLoopbackOrigin = null;
      state.interceptionBudget = { activeRequests: 0, bufferedBytes: 0 };
      state.lastError = "Preview browser disconnected. Connect again to relaunch it.";
    }
  }

  private beginBrowserLaunch(): Promise<Browser> {
    const launchPromise = this.launchBrowser();
    this.browserPromise = launchPromise;

    void launchPromise.then((browser) => {
      browser.once("disconnected", () => {
        if (this.browserPromise !== launchPromise) return;
        this.browserPromise = null;
        this.resetDisconnectedBrowserStates();
      });

      if (!browser.connected) {
        if (this.browserPromise === launchPromise) {
          this.browserPromise = null;
        }
        this.resetDisconnectedBrowserStates();
      }
    }).catch(() => {
      if (this.browserPromise === launchPromise) {
        this.browserPromise = null;
      }
    });

    return launchPromise;
  }

  private async getBrowser(): Promise<Browser> {
    while (true) {
      const browserPromise = this.browserPromise ?? this.beginBrowserLaunch();
      const browser = await browserPromise;
      if (browser.connected) {
        return browser;
      }
      if (this.browserPromise === browserPromise) {
        this.browserPromise = null;
        this.resetDisconnectedBrowserStates();
      }
    }
  }

  private getState(sessionId: string): PreviewState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        context: null,
        page: null,
        destroying: false,
        activeFrameId: null,
        selectedElement: null,
        consoleLogs: [],
        networkLogs: [],
        lastError: null,
        frameIds: new WeakMap(),
        requestStarts: new WeakMap(),
        frameSequence: 0,
        bridgePreview: null,
        requestInterceptionEnabled: false,
        navigationMode: "direct",
        directLoopbackOrigin: null,
        networkGuardSession: null,
        interceptionBudget: { activeRequests: 0, bufferedBytes: 0 },
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private async ensureContext(state: PreviewState, browser: Browser): Promise<BrowserContext> {
    if (state.context && !state.context.closed) {
      return state.context;
    }

    state.context = await browser.createBrowserContext();
    return state.context;
  }

  async destroySession(
    sessionId: string,
    options: { closePage?: boolean } = {},
  ): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state || state.destroying) {
      return;
    }

    state.destroying = true;
    const page = state.page;
    const context = state.context;

    try {
      if (state.networkGuardSession) {
        await state.networkGuardSession.detach().catch(() => {});
        state.networkGuardSession = null;
      }
      if (options.closePage !== false && page && !page.isClosed()) {
        await page.close().catch(() => {});
      }

      if (context && !context.closed) {
        await context.close().catch(() => {});
      }
    } finally {
      this.states.delete(sessionId);
    }
  }

  private ensureFrameId(state: PreviewState, frame: Frame): string {
    const current = state.frameIds.get(frame);
    if (current) return current;
    const next = `frame-${++state.frameSequence}`;
    state.frameIds.set(frame, next);
    return next;
  }

  async configureBridgePreview(
    sessionId: string,
    config: BridgePreviewConfig | null,
    forwardedHeaders?: HeadersInit,
  ): Promise<void> {
    const state = this.getState(sessionId);
    state.bridgePreview = config && forwardedHeaders
      ? {
          ...config,
          forwardedHeaders: Object.fromEntries(new Headers(forwardedHeaders).entries()),
        }
      : null;

    if (state.page && !state.page.isClosed()) {
      await this.syncRequestInterception(state, state.page);
    }
  }

  private async syncRequestInterception(
    state: PreviewState,
    page: Page,
    _targetUrl?: string,
  ): Promise<void> {
    const shouldIntercept = true;
    if (state.requestInterceptionEnabled === shouldIntercept) {
      return;
    }

    await page.setRequestInterception(shouldIntercept);
    state.requestInterceptionEnabled = shouldIntercept;
  }

  private async handlePreviewRequest(
    state: PreviewState,
    request: HTTPRequest,
    reservation: PreviewInterceptionReservation,
  ): Promise<void> {
    const bridgePreview = state.bridgePreview;
    if (state.navigationMode === "direct") {
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
        timeoutMs: 30_000,
        allowLoopback: state.directLoopbackOrigin === parsed.origin,
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

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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
      bridgePreview.bridgeId,
      bridgePreview.forwardedHeaders,
      {
        sessionId: bridgePreview.sessionId,
        method: request.method(),
        url: parsed.toString(),
        headers: sanitizeBridgePreviewRequestHeaders(request.headers()),
        bodyBase64,
      },
      {
        maxResponseBytes: MAX_BRIDGE_RESPONSE_PAYLOAD_BYTES,
        onResponseChunk: (bytes) => reservation.reserve(bytes),
        signal: AbortSignal.timeout(30_000),
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

  private attachListeners(state: PreviewState, page: Page) {
    page.on("console", (message) => {
      this.captureConsole(state, message);
    });
    page.on("pageerror", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(state.consoleLogs, {
        id: buildLogId("pageerror"),
        kind: "pageerror",
        level: "error",
        message,
        timestamp: new Date().toISOString(),
      });
      state.lastError = message;
    });
    page.on("request", (request) => {
      state.requestStarts.set(request, Date.now());
      if (!state.requestInterceptionEnabled) {
        return;
      }

      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        state.directLoopbackOrigin = retainDirectLoopbackOrigin(
          state.directLoopbackOrigin,
          request.url(),
          state.navigationMode,
        );
      }

      let reservation: PreviewInterceptionReservation;
      try {
        reservation = beginPreviewInterception(state.interceptionBudget);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : "Preview request capacity exceeded";
        pushLog(state.networkLogs, {
          id: buildLogId("preview-capacity"),
          kind: "network",
          level: "error",
          message: state.lastError,
          timestamp: new Date().toISOString(),
          url: request.url(),
          method: request.method(),
          status: null,
          resourceType: request.resourceType(),
        });
        void request.abort("blockedbyclient").catch(() => {});
        return;
      }

      void this.handlePreviewRequest(state, request, reservation).catch(async (error) => {
        state.lastError = error instanceof Error ? error.message : "Bridge preview request failed";
        pushLog(state.networkLogs, {
          id: buildLogId("preview-request"),
          kind: "network",
          level: "error",
          message: state.lastError,
          timestamp: new Date().toISOString(),
          url: request.url(),
          method: request.method(),
          status: null,
          resourceType: request.resourceType(),
        });
        try {
          await request.abort("failed");
        } catch {
          // Ignore duplicate resolution failures.
        }
      }).finally(() => {
        reservation.finish();
      });
    });
    page.on("response", (response) => {
      this.captureResponse(state, response);
    });
    page.on("requestfailed", (request) => {
      pushLog(state.networkLogs, {
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
      const frameId = this.ensureFrameId(state, frame);
      if (frame === page.mainFrame()) {
        state.activeFrameId ??= frameId;
        state.directLoopbackOrigin = retainDirectLoopbackOrigin(
          state.directLoopbackOrigin,
          frame.url(),
          state.navigationMode,
        );
      }
      if (state.selectedElement?.frameId === frameId) {
        state.selectedElement = null;
      }
    });
    page.on("close", () => {
      if (this.states.get(state.sessionId)?.page !== page) return;
      void this.destroySession(state.sessionId, { closePage: false });
    });
  }

  private captureConsole(state: PreviewState, message: ConsoleMessage) {
    const location = message.location();
    pushLog(state.consoleLogs, {
      id: buildLogId("console"),
      kind: "console",
      level: message.type(),
      message: normalizeText(message.text()),
      timestamp: new Date().toISOString(),
      url: location.url ?? null,
    });
  }

  private captureResponse(state: PreviewState, response: HTTPResponse) {
    const request = response.request();
    pushLog(state.networkLogs, {
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

  private async ensurePage(sessionId: string): Promise<{ state: PreviewState; page: Page }> {
    const browser = await this.getBrowser();
    const state = this.getState(sessionId);

    if (state.page && !state.page.isClosed()) {
      await this.syncRequestInterception(state, state.page);
      return { state, page: state.page };
    }

    const context = await this.ensureContext(state, browser);
    const page = await context.newPage();
    try {
      await page.setViewport(VIEWPORT);
      page.setDefaultNavigationTimeout(30_000);
      page.setDefaultTimeout(15_000);
      state.networkGuardSession = await installPreviewBrowserNetworkGuard(page, (url) => {
        pushLog(state.networkLogs, {
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
      this.attachListeners(state, page);
      await this.syncRequestInterception(state, page);
      state.page = page;
      state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
      state.selectedElement = null;
      state.lastError = null;
      return { state, page };
    } catch (error) {
      await state.networkGuardSession?.detach().catch(() => {});
      state.networkGuardSession = null;
      await page.close().catch(() => {});
      throw error;
    }
  }

  private collectFrames(state: PreviewState, page: Page): PreviewFrameInfo[] {
    const frames = page.frames().map((frame) => {
      const id = this.ensureFrameId(state, frame);
      const parent = frame.parentFrame();
      return {
        id,
        name: frame.name() || (frame === page.mainFrame() ? "Main frame" : "Untitled frame"),
        url: frame.url(),
        parentId: parent ? this.ensureFrameId(state, parent) : null,
        isMain: frame === page.mainFrame(),
      };
    });

    const activeFrameExists = frames.some((frame) => frame.id === state.activeFrameId);
    if (!activeFrameExists) {
      state.activeFrameId = frames.find((frame) => frame.isMain)?.id ?? frames[0]?.id ?? null;
    }
    if (state.selectedElement && !frames.some((frame) => frame.id === state.selectedElement?.frameId)) {
      state.selectedElement = null;
    }

    return frames;
  }

  private resolveFrame(state: PreviewState, page: Page, frameId?: string | null): Frame {
    const targetId = frameId ?? state.activeFrameId;
    const frames = page.frames();
    if (!targetId) return page.mainFrame();
    return frames.find((frame) => this.ensureFrameId(state, frame) === targetId) ?? page.mainFrame();
  }

  private async navigationProducedUsablePage(
    page: Page,
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

  private async snapshotElement(frame: Frame, selector?: string, point?: { x: number; y: number }): Promise<ElementSnapshot | null> {
    return frame.evaluate(({ selector: inputSelector, point: inputPoint }) => {
      function normalize(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function isInteractive(element: Element): boolean {
        if (!(element instanceof HTMLElement)) return false;
        const tag = element.tagName.toLowerCase();
        if (["button", "input", "select", "textarea", "summary"].includes(tag)) return true;
        if (tag === "a" && element.hasAttribute("href")) return true;
        if (element.hasAttribute("contenteditable")) return true;
        if (element.hasAttribute("onclick")) return true;
        if ((element.getAttribute("role") ?? "").match(/button|link|tab|checkbox|radio|switch|textbox|menuitem/i)) {
          return true;
        }
        return element.tabIndex >= 0;
      }

      function getRole(element: Element): string | null {
        const explicit = normalize(element.getAttribute("role"));
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a" && element.hasAttribute("href")) return "link";
        if (tag === "input") return (element.getAttribute("type") ?? "textbox").toLowerCase();
        return null;
      }

      function getName(element: Element, text: string): string | null {
        const candidate = normalize(
          element.getAttribute("aria-label")
            ?? element.getAttribute("title")
            ?? element.getAttribute("placeholder")
            ?? element.getAttribute("alt")
            ?? text,
        );
        return candidate || null;
      }

      function selectorPart(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const id = normalize(element.getAttribute("id"));
        if (id) {
          return `#${CSS.escape(id)}`;
        }

        const classes = [...element.classList]
          .slice(0, 2)
          .map((name) => `.${CSS.escape(name)}`)
          .join("");

        let nth = "";
        const parent = element.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
          if (siblings.length > 1) {
            nth = `:nth-of-type(${siblings.indexOf(element) + 1})`;
          }
        }

        return `${tag}${classes}${nth}`;
      }

      function buildSelector(element: Element): string {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && parts.length < 5) {
          const part = selectorPart(current);
          parts.unshift(part);
          if (part.startsWith("#")) break;
          current = current.parentElement;
        }
        return parts.join(" > ");
      }

      function serializeElement(element: Element) {
        const html = normalize(element.outerHTML).slice(0, 400);
        const text = normalize(element.textContent);
        const rect = element.getBoundingClientRect();
        const attributes = [...element.attributes].reduce<Record<string, string>>((acc, attribute) => {
          if (acc && Object.keys(acc).length >= 12) return acc;
          acc[attribute.name] = attribute.value;
          return acc;
        }, {});

        return {
          selector: buildSelector(element),
          tag: element.tagName.toLowerCase(),
          text: text.slice(0, 220),
          role: getRole(element),
          name: getName(element, text.slice(0, 220)),
          interactive: isInteractive(element),
          id: normalize(element.getAttribute("id")) || null,
          classes: [...element.classList].slice(0, 6),
          htmlPreview: html,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          attributes,
        };
      }

      let element: Element | null = null;
      if (typeof inputSelector === "string" && inputSelector.trim()) {
        element = document.querySelector(inputSelector);
      } else if (inputPoint) {
        element = document.elementFromPoint(inputPoint.x, inputPoint.y);
      }

      if (!element) return null;
      return serializeElement(element);
    }, { selector, point });
  }

  async connect(sessionId: string, url: string): Promise<void> {
    const { state, page } = await this.ensurePage(sessionId);
    const candidates = buildPreviewNavigationCandidates(url);
    let lastError: unknown = null;

    for (const candidate of candidates) {
      const navigationMode = resolvePreviewNavigationMode(candidate, state.bridgePreview);
      if (navigationMode === "blocked") {
        lastError = new Error("Bridge preview only allows navigation to the session's reported local dev server origin.");
        continue;
      }

      const previousUrl = page.url();
      const previousNavigationMode = state.navigationMode;
      const previousDirectLoopbackOrigin = state.directLoopbackOrigin;
      try {
        state.navigationMode = navigationMode;
        state.directLoopbackOrigin = navigationMode === "direct" && isLocalHost(new URL(candidate).hostname)
          ? new URL(candidate).origin
          : null;
        await this.syncRequestInterception(state, page, candidate);
        await page.goto(candidate, { waitUntil: "domcontentloaded" });
        await this.syncRequestInterception(state, page);
        state.selectedElement = null;
        state.lastError = null;
        state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
        return;
      } catch (error) {
        if (await this.navigationProducedUsablePage(page, candidate, previousUrl, error)) {
          await this.syncRequestInterception(state, page);
          state.selectedElement = null;
          state.lastError = null;
          state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
          return;
        }
        state.navigationMode = previousNavigationMode;
        state.directLoopbackOrigin = retainDirectLoopbackOrigin(
          previousDirectLoopbackOrigin,
          page.url(),
          previousNavigationMode,
        );
        lastError = error;
      }
    }

    state.lastError = lastError instanceof Error ? lastError.message : "Failed to connect preview";
    throw (lastError ?? new Error("Failed to connect preview"));
  }

  async runCommand(sessionId: string, command: PreviewCommandRequest): Promise<void> {
    switch (command.command) {
      case "connect":
      case "navigate":
        await this.connect(sessionId, command.url);
        return;
      case "reload": {
        const { state, page } = await this.ensurePage(sessionId);
        try {
          await page.reload({ waitUntil: "domcontentloaded" });
          state.lastError = null;
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : "Failed to reload preview";
          throw error;
        }
        return;
      }
      case "goBack": {
        const { state, page } = await this.ensurePage(sessionId);
        try {
          await this.syncRequestInterception(state, page);
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 1_500 });
          await this.syncRequestInterception(state, page);
          state.selectedElement = null;
          state.lastError = null;
          state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : "Failed to go back";
          throw error;
        }
        return;
      }
      case "goForward": {
        const { state, page } = await this.ensurePage(sessionId);
        try {
          await this.syncRequestInterception(state, page);
          await page.goForward({ waitUntil: "domcontentloaded", timeout: 1_500 });
          await this.syncRequestInterception(state, page);
          state.selectedElement = null;
          state.lastError = null;
          state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : "Failed to go forward";
          throw error;
        }
        return;
      }
      case "selectFrame": {
        const { state, page } = await this.ensurePage(sessionId);
        const frame = this.resolveFrame(state, page, command.frameId);
        state.activeFrameId = this.ensureFrameId(state, frame);
        state.selectedElement = null;
        state.lastError = null;
        return;
      }
      case "clickAtPoint": {
        const { state, page } = await this.ensurePage(sessionId);
        state.selectedElement = null;
        state.lastError = null;

        const navigation = page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1_500 })
          .catch(() => null);

        await page.mouse.click(command.x, command.y);
        await navigation;
        await page.waitForNetworkIdle({ idleTime: 250, timeout: 1_000 }).catch(() => null);
        return;
      }
      case "typeText": {
        const { state, page } = await this.ensurePage(sessionId);
        if (!command.text) {
          return;
        }
        await page.keyboard.type(command.text);
        state.lastError = null;
        return;
      }
      case "pressKey": {
        const { state, page } = await this.ensurePage(sessionId);
        state.lastError = null;

        const navigation = page
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1_500 })
          .catch(() => null);

        await page.keyboard.press(command.key as KeyInput);
        await navigation;
        await page.waitForNetworkIdle({ idleTime: 250, timeout: 1_000 }).catch(() => null);
        return;
      }
      case "selectAtPoint": {
        const { state, page } = await this.ensurePage(sessionId);
        const frame = this.resolveFrame(state, page, state.activeFrameId);
        if (frame !== page.mainFrame()) {
          throw new Error("Point selection is only available for the main frame. Pick nested frame elements from the DOM list.");
        }
        const snapshot = await this.snapshotElement(frame, undefined, { x: command.x, y: command.y });
        if (!snapshot) {
          throw new Error("No element found at the selected point");
        }
        state.selectedElement = {
          ...snapshot,
          frameId: this.ensureFrameId(state, frame),
          frameName: frame.name() || "Main frame",
          frameUrl: frame.url(),
        };
        state.lastError = null;
        return;
      }
      case "selectBySelector": {
        const { state, page } = await this.ensurePage(sessionId);
        const frame = this.resolveFrame(state, page, command.frameId);
        const snapshot = await this.snapshotElement(frame, command.selector);
        if (!snapshot) {
          throw new Error(`Element not found for selector: ${command.selector}`);
        }
        state.selectedElement = {
          ...snapshot,
          frameId: this.ensureFrameId(state, frame),
          frameName: frame.name() || (frame === page.mainFrame() ? "Main frame" : "Frame"),
          frameUrl: frame.url(),
        };
        state.activeFrameId = this.ensureFrameId(state, frame);
        state.lastError = null;
        return;
      }
      default:
        return;
    }
  }

  async inspectDom(sessionId: string, frameId?: string | null, interactiveOnly = false): Promise<{ frameId: string | null; nodes: PreviewDomNode[]; truncated: boolean }> {
    const { state, page } = await this.ensurePage(sessionId);
    const frame = this.resolveFrame(state, page, frameId);
    const result = await frame.evaluate(({ interactiveOnly: onlyInteractive, limit }) => {
      function normalize(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function isInteractive(element: Element): boolean {
        if (!(element instanceof HTMLElement)) return false;
        const tag = element.tagName.toLowerCase();
        if (["button", "input", "select", "textarea", "summary"].includes(tag)) return true;
        if (tag === "a" && element.hasAttribute("href")) return true;
        if (element.hasAttribute("contenteditable")) return true;
        if ((element.getAttribute("role") ?? "").match(/button|link|tab|checkbox|radio|switch|textbox|menuitem/i)) return true;
        return element.tabIndex >= 0;
      }

      function getRole(element: Element): string | null {
        const explicit = normalize(element.getAttribute("role"));
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a" && element.hasAttribute("href")) return "link";
        if (tag === "input") return (element.getAttribute("type") ?? "textbox").toLowerCase();
        return null;
      }

      function getName(element: Element, text: string): string | null {
        const candidate = normalize(
          element.getAttribute("aria-label")
            ?? element.getAttribute("title")
            ?? element.getAttribute("placeholder")
            ?? element.getAttribute("alt")
            ?? text,
        );
        return candidate || null;
      }

      function selectorPart(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const id = normalize(element.getAttribute("id"));
        if (id) return `#${CSS.escape(id)}`;

        const classes = [...element.classList]
          .slice(0, 2)
          .map((name) => `.${CSS.escape(name)}`)
          .join("");

        let nth = "";
        const parent = element.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
          if (siblings.length > 1) {
            nth = `:nth-of-type(${siblings.indexOf(element) + 1})`;
          }
        }

        return `${tag}${classes}${nth}`;
      }

      function buildSelector(element: Element): string {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && parts.length < 5) {
          const part = selectorPart(current);
          parts.unshift(part);
          if (part.startsWith("#")) break;
          current = current.parentElement;
        }
        return parts.join(" > ");
      }

      const root = document.body ?? document.documentElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      const results = [];
      let truncated = false;

      while (walker.nextNode()) {
        const element = walker.currentNode;
        if (!(element instanceof Element)) continue;
        const interactive = isInteractive(element);
        if (onlyInteractive && !interactive) continue;

        if (results.length >= limit) {
          truncated = true;
          break;
        }

        const text = normalize(element.textContent).slice(0, 220);
        const rect = element.getBoundingClientRect();
        results.push({
          selector: buildSelector(element),
          tag: element.tagName.toLowerCase(),
          text,
          role: getRole(element),
          name: getName(element, text),
          interactive,
          id: normalize(element.getAttribute("id")) || null,
          classes: [...element.classList].slice(0, 6),
          htmlPreview: normalize(element.outerHTML).slice(0, 320),
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        });
      }

      return {
        nodes: results,
        truncated,
      };
    }, { interactiveOnly, limit: DOM_NODE_LIMIT });

    return {
      frameId: this.ensureFrameId(state, frame),
      nodes: result.nodes,
      truncated: result.truncated,
    };
  }

  async takeScreenshot(sessionId: string): Promise<Uint8Array | null> {
    const { page } = await this.ensurePage(sessionId);
    if (page.url() === "about:blank") {
      return null;
    }
    return page.screenshot({ type: "png" }) as Promise<Uint8Array>;
  }


  private async getNavigationCapabilities(page: Page | null): Promise<{
    canGoBack: boolean;
    canGoForward: boolean;
  }> {
    if (!page || page.isClosed() || page.url() === "about:blank") {
      return { canGoBack: false, canGoForward: false };
    }

    let cdpSession: Awaited<ReturnType<Page["createCDPSession"]>> | null = null;
    try {
      cdpSession = await page.createCDPSession();
      const history = await cdpSession.send("Page.getNavigationHistory") as {
        currentIndex: number;
        entries: PreviewNavigationHistoryEntry[];
      };
      return resolvePreviewNavigationCapabilities(history.currentIndex, history.entries);
    } catch {
      return {
        canGoBack: false,
        canGoForward: false,
      };
    } finally {
      await cdpSession?.detach().catch(() => null);
    }
  }

  async getStatus(sessionId: string, candidateUrls: string[]): Promise<PreviewStatusResponse> {
    const state = this.states.get(sessionId) ?? null;
    const page = state?.page && !state.page.isClosed() ? state.page : null;
    const frames = state && page ? this.collectFrames(state, page) : [];
    const { canGoBack, canGoForward } = await this.getNavigationCapabilities(page);

    let title: string | null = null;
    if (page && page.url() !== "about:blank") {
      try {
        title = await page.title();
      } catch {
        title = null;
      }
    }

    return {
      connected: Boolean(page && page.url() !== "about:blank"),
      candidateUrls,
      currentUrl: page && page.url() !== "about:blank" ? page.url() : null,
      title,
      tunnelUrl: null,
      tunnelLocalOrigin: null,
      canGoBack,
      canGoForward,
      frames,
      activeFrameId: state?.activeFrameId ?? null,
      selectedElement: state?.selectedElement ?? null,
      consoleLogs: state?.consoleLogs ?? [],
      networkLogs: state?.networkLogs ?? [],
      lastError: state?.lastError ?? null,
      screenshotKey: `${Date.now()}`,
    };
  }
}

export interface PreviewBrowserManagerClient {
  configureBridgePreview(
    sessionId: string,
    config: BridgePreviewConfig | null,
    forwardedHeaders?: HeadersInit,
  ): Promise<void>;
  destroySession(sessionId: string, options?: { closePage?: boolean }): Promise<void>;
  runCommand(sessionId: string, command: PreviewCommandRequest): Promise<void>;
  inspectDom(
    sessionId: string,
    frameId?: string | null,
    interactiveOnly?: boolean,
  ): Promise<{ frameId: string | null; nodes: PreviewDomNode[]; truncated: boolean }>;
  takeScreenshot(sessionId: string): Promise<Uint8Array | null>;
  getStatus(sessionId: string, candidateUrls: string[]): Promise<PreviewStatusResponse>;
}

export function getLocalPreviewBrowserManager(): PreviewBrowserManager {
  if (!globalForPreviewBrowser._conductorPreviewBrowserManager) {
    globalForPreviewBrowser._conductorPreviewBrowserManager = new PreviewBrowserManager();
  }
  return globalForPreviewBrowser._conductorPreviewBrowserManager;
}

function shouldUseLocalPreviewBrowser(): boolean {
  const backendUrl = resolveRustBackendUrl();
  if (!backendUrl) {
    return false;
  }

  try {
    const hostname = new URL(backendUrl).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "0.0.0.0"
      || hostname === "::1"
      || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function getPreviewBrowserManager(): PreviewBrowserManagerClient {
  return shouldUseLocalPreviewBrowser()
    ? getLocalPreviewBrowserManager()
    : getPreviewWorkerClient();
}
