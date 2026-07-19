import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { Browser, Frame, Page } from "puppeteer-core";
import {
  MAX_BUFFERED_PREVIEW_BYTES,
  MAX_CONCURRENT_PREVIEW_REQUESTS,
  BrowserManager,
  beginPreviewInterception,
  buildChromeArgs,
  requestBridgePreview,
  retainDirectLoopbackOrigin,
} from "./BrowserManager.js";
import {
  PreviewWorkerError,
  type PreviewSession,
  type PreviewWorkerConfig,
} from "../lib/types.js";
import { SessionStore } from "../sessions/SessionStore.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function config(overrides: Partial<PreviewWorkerConfig> = {}): PreviewWorkerConfig {
  return {
    port: 3099,
    apiKey: "worker-key",
    maxSessions: 2,
    sessionTimeoutMs: 60_000,
    chromeCommandTimeoutMs: 25,
    chromePath: "/fake/chrome",
    cloudflaredBin: "cloudflared",
    ...overrides,
  };
}

function fakeBrowser(options: {
  url?: string;
  title?: () => Promise<string>;
  screenshotError?: Error;
  newPageError?: Error;
  pageClose?: () => Promise<void>;
  browserClose?: () => Promise<void>;
} = {}) {
  const pageEvents = new EventEmitter();
  const cdpEvents = new EventEmitter();
  const cdpCommands: Array<{ method: string; params?: unknown }> = [];
  let pageClosed = false;
  let browserClosed = false;
  let browserConnected = true;
  let browserDisconnected = false;
  let browserProcessKilled = false;
  const frame = {
    name: () => "",
    url: () => options.url ?? "about:blank",
    parentFrame: () => null,
  } as unknown as Frame;
  const page = {
    setViewport: async () => {},
    setDefaultNavigationTimeout: () => {},
    setDefaultTimeout: () => {},
    setRequestInterception: async () => {},
    on: (name: string, listener: (...args: unknown[]) => void) => {
      pageEvents.on(name, listener);
      return page;
    },
    mainFrame: () => frame,
    frames: () => [frame],
    url: () => options.url ?? "about:blank",
    title: options.title ?? (async () => ""),
    createCDPSession: async () => ({
      send: async (method: string, params?: unknown) => {
        cdpCommands.push({ method, params });
        return method === "Page.getNavigationHistory"
          ? { currentIndex: 0, entries: [{}] }
          : {};
      },
      on: (name: string, listener: (...args: unknown[]) => void) => {
        cdpEvents.on(name, listener);
      },
      detach: async () => {},
    }),
    isClosed: () => pageClosed,
    screenshot: async () => {
      if (options.screenshotError) {
        pageClosed = true;
        pageEvents.emit("close");
        throw options.screenshotError;
      }
      return Buffer.from("png");
    },
    close: async () => {
      if (options.pageClose) {
        await options.pageClose();
      }
      pageClosed = true;
      pageEvents.emit("close");
    },
  } as unknown as Page;
  const browser = {
    get connected() {
      return browserConnected;
    },
    newPage: async () => {
      if (options.newPageError) throw options.newPageError;
      return page;
    },
    close: async () => {
      if (options.browserClose) {
        await options.browserClose();
      }
      browserClosed = true;
      browserConnected = false;
    },
    process: () => ({
      kill: () => {
        browserProcessKilled = true;
        browserClosed = true;
        browserConnected = false;
        return true;
      },
    }),
    disconnect: () => {
      browserDisconnected = true;
      browserConnected = false;
    },
  } as unknown as Browser;

  return {
    browser,
    page,
    pageClosed: () => pageClosed,
    browserClosed: () => browserClosed,
    browserDisconnected: () => browserDisconnected,
    browserProcessKilled: () => browserProcessKilled,
    cdpCommands,
    emitCdp: (name: string, payload: unknown) => cdpEvents.emit(name, payload),
  };
}

const env = process.env as Record<string, string | undefined>;
const previousDisableSandbox = env.CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX;

test.afterEach(() => {
  if (previousDisableSandbox === undefined) {
    delete env.CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX;
  } else {
    env.CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX = previousDisableSandbox;
  }
});

test("Chrome sandbox remains enabled unless explicitly disabled", () => {
  delete env.CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX;
  assert.equal(buildChromeArgs().includes("--no-sandbox"), false);

  env.CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX = "true";
  assert.equal(buildChromeArgs().includes("--no-sandbox"), true);
});

test("preview interception budget bounds concurrency and aggregate buffered bytes", () => {
  const budget = { activeRequests: 0, bufferedBytes: 0 };
  const reservations = Array.from(
    { length: MAX_CONCURRENT_PREVIEW_REQUESTS },
    () => beginPreviewInterception(budget),
  );
  assert.throws(() => beginPreviewInterception(budget), /concurrent network requests/);
  reservations.forEach((reservation) => reservation.finish());

  const reservation = beginPreviewInterception(budget);
  reservation.reserve(MAX_BUFFERED_PREVIEW_BYTES);
  assert.throws(() => reservation.reserve(1), /64 MiB buffered network-data limit/);
  reservation.finish();
  assert.deepEqual(budget, { activeRequests: 0, bufferedBytes: 0 });
  assert.throws(() => reservation.reserve(1), /already closed/);
});

test("paired-device preview reads are cancelled by their absolute deadline", async () => {
  const intervals = new Set<NodeJS.Timeout>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":200,"body_base64":"');
    const interval = setInterval(() => response.write("YQ=="), 20);
    intervals.add(interval);
    response.once("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const reservation = beginPreviewInterception({ activeRequests: 0, bufferedBytes: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const session = {
      bridgePreview: {
        bridgeId: "device-1",
        sessionId: "session-1",
        relayUrl: `http://127.0.0.1:${address.port}`,
        allowedOrigins: ["http://127.0.0.1:3000"],
        forwardedHeaders: { authorization: "Bearer test-token" },
      },
    } as PreviewSession;
    await assert.rejects(
      requestBridgePreview(session, reservation, 100, {
        method: "GET",
        url: "http://127.0.0.1:3000/",
        headers: {},
        bodyBase64: null,
      }),
      /timed out/,
    );
  } finally {
    reservation.finish();
    for (const interval of intervals) clearInterval(interval);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("public main-frame navigation clears and cannot recreate loopback authorization", () => {
  assert.equal(
    retainDirectLoopbackOrigin("http://localhost:3000", "https://public.example/app", "direct"),
    null,
  );
  assert.equal(
    retainDirectLoopbackOrigin(null, "http://localhost:3000/private", "direct"),
    null,
  );
  assert.equal(
    retainDirectLoopbackOrigin("http://localhost:3000", "http://localhost:3000/next", "direct"),
    "http://localhost:3000",
  );
});

test("session creation installs a fail-closed browser guard for WebSocket and non-HTTP schemes", async () => {
  const fake = fakeBrowser();
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config(), store, async () => fake.browser);

  const session = await manager.createSession("key-a", { clientSessionId: "client-1" });
  const blocked = fake.cdpCommands.find((command) => command.method === "Network.setBlockedURLs");
  assert.deepEqual(blocked?.params, {
    urls: ["ws://*", "wss://*", "file://*", "ftp://*", "gopher://*"],
  });

  fake.emitCdp("Network.webSocketCreated", { url: "ws://127.0.0.1:9000/private" });
  assert.match(session.networkLogs.at(-1)?.message ?? "", /Blocked WebSocket connection/);
  await manager.close();
});

test("concurrent creates for the same client session are single-flight", async () => {
  const launchGate = deferred<Browser>();
  const fake = fakeBrowser();
  let launches = 0;
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config(), store, async () => {
    launches += 1;
    return await launchGate.promise;
  });

  const first = manager.createSession("key-a", { clientSessionId: "client-1" });
  const second = manager.createSession("key-a", { clientSessionId: "client-1" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(launches, 1);

  launchGate.resolve(fake.browser);
  const [firstSession, secondSession] = await Promise.all([first, second]);
  assert.equal(firstSession.id, secondSession.id);
  assert.equal(launches, 1);
  assert.equal(store.countByApiKey("key-a"), 1);

  await manager.close();
});

test("capacity is reserved before Chrome launch completes", async () => {
  const launchGate = deferred<Browser>();
  const fake = fakeBrowser();
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config({ maxSessions: 1 }), store, async () => await launchGate.promise);

  const first = manager.createSession("key-a", { clientSessionId: "client-1" });
  await assert.rejects(
    manager.createSession("key-a", { clientSessionId: "client-2" }),
    (error: unknown) => error instanceof PreviewWorkerError && error.statusCode === 429,
  );

  launchGate.resolve(fake.browser);
  await first;
  await manager.close();
});

test("failed page initialization closes Chrome and releases the capacity reservation", async () => {
  const failed = fakeBrowser({ newPageError: new Error("page init failed") });
  const replacement = fakeBrowser();
  const browsers = [failed.browser, replacement.browser];
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config({ maxSessions: 1 }), store, async () => {
    const browser = browsers.shift();
    assert.ok(browser);
    return browser;
  });

  await assert.rejects(
    manager.createSession("key-a", { clientSessionId: "client-1" }),
    /page init failed/,
  );
  assert.equal(failed.browserClosed(), true);

  const session = await manager.createSession("key-a", { clientSessionId: "client-2" });
  assert.equal(store.get(session.id)?.id, session.id);
  await manager.close();
});

test("expired sessions are removed before capacity is allocated or a client ID is reused", async () => {
  const expired = fakeBrowser();
  const replacement = fakeBrowser();
  const browsers = [expired.browser, replacement.browser];
  const store = new SessionStore(1);
  const manager = new BrowserManager(
    config({ maxSessions: 1, sessionTimeoutMs: 1 }),
    store,
    async () => {
      const browser = browsers.shift();
      assert.ok(browser);
      return browser;
    },
  );

  const first = await manager.createSession("key-a", { clientSessionId: "client-1" });
  first.lastActivityAt = Date.now() - 100;
  const second = await manager.createSession("key-a", { clientSessionId: "client-1" });

  assert.notEqual(first.id, second.id);
  assert.equal(expired.browserClosed(), true);
  assert.equal(store.countByApiKey("key-a"), 1);
  await manager.close();
});

test("worker shutdown waits for in-flight creation and closes the resulting Chrome instance", async () => {
  const launchGate = deferred<Browser>();
  const fake = fakeBrowser();
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config(), store, async () => await launchGate.promise);

  const creation = manager.createSession("key-a", { clientSessionId: "client-1" });
  const closing = manager.close();
  launchGate.resolve(fake.browser);

  await creation;
  await closing;
  assert.equal(fake.pageClosed(), true);
  assert.equal(fake.browserClosed(), true);
  assert.equal(store.count(), 0);
  await assert.rejects(
    manager.createSession("key-a", { clientSessionId: "client-2" }),
    (error: unknown) => error instanceof PreviewWorkerError && error.statusCode === 503,
  );
});

test("a timed-out command poisons and closes its session before queued work can run", async () => {
  const titleGate = deferred<string>();
  const fake = fakeBrowser({
    url: "https://preview.example/",
    title: async () => await titleGate.promise,
  });
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(
    config({ chromeCommandTimeoutMs: 10 }),
    store,
    async () => fake.browser,
  );
  const session = await manager.createSession("key-a", { clientSessionId: "client-1" });

  const timedOut = manager.executeCommand(session.id, { command: "status", candidateUrls: [] });
  const queued = manager.executeCommand(session.id, { command: "status", candidateUrls: [] });

  await assert.rejects(
    timedOut,
    (error: unknown) => error instanceof PreviewWorkerError && error.statusCode === 408,
  );
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof PreviewWorkerError && error.statusCode === 404,
  );
  assert.equal(fake.pageClosed(), true);
  assert.equal(fake.browserClosed(), true);
  assert.equal(store.get(session.id), undefined);

  titleGate.resolve("late result");
  await manager.close();
});

test("a command that loses its browser target releases the preview session", async () => {
  const fake = fakeBrowser({
    url: "https://preview.example/",
    screenshotError: new Error("Protocol error (Page.captureScreenshot): Target closed"),
  });
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config(), store, async () => fake.browser);
  const session = await manager.createSession("key-a", { clientSessionId: "client-1" });

  await assert.rejects(
    manager.executeCommand(session.id, { command: "screenshot" }),
    /Target closed/,
  );
  assert.equal(fake.pageClosed(), true);
  assert.equal(fake.browserClosed(), true);
  assert.equal(store.get(session.id), undefined);

  await manager.close();
});

test("browser teardown is bounded when Chromium does not close gracefully", async () => {
  const never = new Promise<void>(() => {});
  const fake = fakeBrowser({ pageClose: async () => await never });
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(
    config({ chromeCommandTimeoutMs: 20 }),
    store,
    async () => fake.browser,
  );
  const session = await manager.createSession("key-a", { clientSessionId: "client-1" });

  const startedAt = Date.now();
  await manager.destroySession(session.id);

  assert.ok(Date.now() - startedAt < 500);
  assert.equal(store.get(session.id), undefined);
  assert.equal(fake.browserProcessKilled(), true);
  assert.equal(fake.browserDisconnected(), true);

  await manager.close();
});

test("browser teardown forces a still-connected process after close rejects", async () => {
  const fake = fakeBrowser({
    browserClose: async () => {
      throw new Error("browser close failed");
    },
  });
  const store = new SessionStore(60_000);
  const manager = new BrowserManager(config(), store, async () => fake.browser);
  const session = await manager.createSession("key-a", { clientSessionId: "client-1" });

  await manager.destroySession(session.id);

  assert.equal(store.get(session.id), undefined);
  assert.equal(fake.browserProcessKilled(), true);
  assert.equal(fake.browserDisconnected(), true);

  await manager.close();
});
