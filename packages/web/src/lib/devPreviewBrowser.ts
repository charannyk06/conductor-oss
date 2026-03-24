import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import puppeteer, {
  type Browser,
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

const VIEWPORT = { width: 1440, height: 960 };
const LOG_LIMIT = 150;
const DOM_NODE_LIMIT = 250;
const LOCAL_NAVIGATION_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"] as const;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const BARE_LOCAL_NAVIGATION_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/.*)?$/i;

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
  page: Page | null;
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

class PreviewBrowserManager {
  private browserPromise: Promise<Browser> | null = null;
  private states = new Map<string, PreviewState>();

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = puppeteer.launch({
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
    return this.browserPromise;
  }

  private getState(sessionId: string): PreviewState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        page: null,
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
      };
      this.states.set(sessionId, state);
    }
    return state;
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
    targetUrl?: string,
  ): Promise<void> {
    const shouldIntercept = resolvePreviewNavigationMode(
      targetUrl ?? page.url(),
      state.bridgePreview,
    ) === "bridge";
    if (state.requestInterceptionEnabled === shouldIntercept) {
      return;
    }

    await page.setRequestInterception(shouldIntercept);
    state.requestInterceptionEnabled = shouldIntercept;
  }

  private async handleBridgePreviewRequest(
    state: PreviewState,
    request: HTTPRequest,
  ): Promise<void> {
    const bridgePreview = state.bridgePreview;
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

    const previewResponse = await requestBridgePreview(
      bridgePreview.bridgeId,
      bridgePreview.forwardedHeaders,
      {
        sessionId: bridgePreview.sessionId,
        method: request.method(),
        url: parsed.toString(),
        headers: sanitizeBridgePreviewRequestHeaders(request.headers()),
        bodyBase64: postData ? Buffer.from(postData).toString("base64") : null,
      },
    );

    await request.respond({
      status: previewResponse.status,
      headers: previewResponse.headers,
      body: previewResponse.bodyBase64
        ? Buffer.from(previewResponse.bodyBase64, "base64")
        : Buffer.alloc(0),
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

      void this.handleBridgePreviewRequest(state, request).catch(async (error) => {
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
      }
      if (state.selectedElement?.frameId === frameId) {
        state.selectedElement = null;
      }
    });
    page.on("close", () => {
      state.page = null;
      state.selectedElement = null;
      state.activeFrameId = null;
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

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);
    this.attachListeners(state, page);
    await this.syncRequestInterception(state, page);
    state.page = page;
    state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
    state.selectedElement = null;
    state.lastError = null;
    return { state, page };
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
      try {
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
      let visited = 0;

      while (walker.nextNode()) {
        visited += 1;
        const element = walker.currentNode;
        if (!(element instanceof Element)) continue;
        const interactive = isInteractive(element);
        if (onlyInteractive && !interactive) continue;

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
        if (results.length >= limit) {
          break;
        }
      }

      return {
        nodes: results,
        truncated: results.length >= limit || visited > results.length,
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

  async getStatus(sessionId: string, candidateUrls: string[]): Promise<PreviewStatusResponse> {
    const state = this.getState(sessionId);
    const page = state.page && !state.page.isClosed() ? state.page : null;
    const frames = page ? this.collectFrames(state, page) : [];

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
      frames,
      activeFrameId: state.activeFrameId,
      selectedElement: state.selectedElement,
      consoleLogs: state.consoleLogs,
      networkLogs: state.networkLogs,
      lastError: state.lastError,
      screenshotKey: `${Date.now()}`,
    };
  }
}

export function getPreviewBrowserManager(): PreviewBrowserManager {
  if (!globalForPreviewBrowser._conductorPreviewBrowserManager) {
    globalForPreviewBrowser._conductorPreviewBrowserManager = new PreviewBrowserManager();
  }
  return globalForPreviewBrowser._conductorPreviewBrowserManager;
}
