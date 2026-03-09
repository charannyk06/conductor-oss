import puppeteer, {
  type Browser,
  type ConsoleMessage,
  type Frame,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
} from "puppeteer";
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
      return { state, page: state.page };
    }

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);
    this.attachListeners(state, page);
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
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      state.selectedElement = null;
      state.lastError = null;
      state.activeFrameId = this.ensureFrameId(state, page.mainFrame());
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : "Failed to connect preview";
      throw error;
    }
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
