import assert from "node:assert/strict";
import test from "node:test";
import { resolveTerminalConnection } from "./terminalApi";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalBackendUrl = process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL;

function restoreWindow(): void {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
}

function restoreDocument(): void {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
    return;
  }

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: originalDocument,
  });
}

function setWindowLocation(url: string): void {
  const parsed = new URL(url);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        host: parsed.host,
        origin: parsed.origin,
        port: parsed.port,
      },
    },
  });
}

function setBackendOriginMeta(content: string): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      querySelector(selector: string) {
        if (selector === 'meta[name="conductor-backend-url"]') {
          return { content };
        }
        return null;
      },
    },
  });
}

function setFetchResponse(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        "content-type": "application/json",
      },
    })) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWindow();
  restoreDocument();
  if (originalBackendUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL;
  } else {
    process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL = originalBackendUrl;
  }
});

test("resolveTerminalConnection accepts direct ttyd URLs", async () => {
  setWindowLocation("http://127.0.0.1:3000/sessions/session-1");
  setFetchResponse({
    required: true,
    ttydHttpUrl: "http://127.0.0.1:41000/",
    ttydWsUrl: "ws://127.0.0.1:41000/ws",
  });

  const connection = await resolveTerminalConnection("session-1");

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(connection.terminalUrl, "http://127.0.0.1:41000/");
});

test("resolveTerminalConnection prefers the runtime backend origin meta tag", async () => {
  setWindowLocation("https://dashboard.example.com/sessions/session-1");
  setBackendOriginMeta("https://api.example.com/internal");
  setFetchResponse({
    required: true,
    ttydHttpUrl: "/api/sessions/session-1/terminal/ttyd?token=test-token",
    ttydWsUrl: "/api/sessions/session-1/terminal/ttyd/ws?token=test-token",
  });

  const connection = await resolveTerminalConnection("session-1");

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(
    connection.terminalUrl,
    "https://api.example.com/api/sessions/session-1/terminal/ttyd?token=test-token",
  );
});

test("resolveTerminalConnection rewrites loopback backend meta to the current remote host", async () => {
  setWindowLocation("https://tailnet.example.ts.net/sessions/session-1");
  setBackendOriginMeta("http://127.0.0.1:4748");
  setFetchResponse({
    required: true,
    ttydHttpUrl: "/api/sessions/session-1/terminal/ttyd?token=test-token",
    ttydWsUrl: "/api/sessions/session-1/terminal/ttyd/ws?token=test-token",
  });

  const connection = await resolveTerminalConnection("session-1");

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(
    connection.terminalUrl,
    "https://tailnet.example.ts.net:4748/api/sessions/session-1/terminal/ttyd?token=test-token",
  );
});

test("resolveTerminalConnection resolves backend ttyd proxy paths against the backend origin", async () => {
  setWindowLocation("https://dashboard.example.com/sessions/session-2");
  setFetchResponse({
    required: true,
    ttydHttpUrl: "/api/sessions/session-2/terminal/ttyd?token=test-token",
    ttydWsUrl: "/api/sessions/session-2/terminal/ttyd/ws?token=test-token",
  });

  const connection = await resolveTerminalConnection("session-2");

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(
    connection.terminalUrl,
    "https://dashboard.example.com/api/sessions/session-2/terminal/ttyd?token=test-token",
  );
});

test("resolveTerminalConnection normalizes ws-only ttyd urls without adding a trailing slash", async () => {
  setWindowLocation("https://dashboard.example.com/sessions/session-3");
  setFetchResponse({
    required: true,
    ttydHttpUrl: null,
    ttydWsUrl: "/api/sessions/session-3/terminal/ttyd/ws?token=test-token",
  });

  const connection = await resolveTerminalConnection("session-3");

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(
    connection.terminalUrl,
    "https://dashboard.example.com/api/sessions/session-3/terminal/ttyd?token=test-token",
  );
});
