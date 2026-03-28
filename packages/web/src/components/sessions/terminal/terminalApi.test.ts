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
  assert.equal(connection.websocketUrl, "ws://127.0.0.1:41000/ws");
});

test("resolveTerminalConnection derives websocket urls from http-only direct ttyd endpoints", async () => {
  setWindowLocation("http://127.0.0.1:3000/sessions/session-1");
  setFetchResponse({
    required: true,
    ttydHttpUrl: "http://127.0.0.1:41000/",
    ttydWsUrl: null,
  });

  const connection = await resolveTerminalConnection("session-1");

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(connection.terminalUrl, "http://127.0.0.1:41000/");
  assert.equal(connection.websocketUrl, "ws://127.0.0.1:41000/ws");
});

test("resolveTerminalConnection keeps proxied ttyd routes on the dashboard origin even with backend metadata", async () => {
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
    "https://dashboard.example.com/api/sessions/session-1/terminal/ttyd?token=test-token",
  );
  assert.equal(
    connection.websocketUrl,
    "wss://dashboard.example.com/api/sessions/session-1/terminal/ttyd/ws?token=test-token",
  );
});

test("resolveTerminalConnection keeps proxied ttyd routes on the current host when backend metadata points to loopback", async () => {
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
    "https://tailnet.example.ts.net/api/sessions/session-1/terminal/ttyd?token=test-token",
  );
  assert.equal(
    connection.websocketUrl,
    "wss://tailnet.example.ts.net/api/sessions/session-1/terminal/ttyd/ws?token=test-token",
  );
});

test("resolveTerminalConnection resolves proxy ttyd paths against the current dashboard origin", async () => {
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
  assert.equal(
    connection.websocketUrl,
    "wss://dashboard.example.com/api/sessions/session-2/terminal/ttyd/ws?token=test-token",
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
  assert.equal(
    connection.websocketUrl,
    "wss://dashboard.example.com/api/sessions/session-3/terminal/ttyd/ws?token=test-token",
  );
});

test("resolveTerminalConnection preserves bridge scope on proxied ttyd routes", async () => {
  setWindowLocation("https://app.conductross.com/sessions/bridge-session");
  setBackendOriginMeta("https://api.conductross.com");
  setFetchResponse({
    required: true,
    ttydHttpUrl: "/api/sessions/session-bridge/terminal/ttyd?token=test-token",
    ttydWsUrl: "/api/sessions/session-bridge/terminal/ttyd/ws?token=test-token",
  });

  const connection = await resolveTerminalConnection("bridge-session", { bridgeId: "bridge-prod" });

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(
    connection.terminalUrl,
    "https://app.conductross.com/api/sessions/session-bridge/terminal/ttyd?token=test-token&bridgeId=bridge-prod",
  );
  assert.equal(
    connection.websocketUrl,
    "wss://app.conductross.com/api/sessions/session-bridge/terminal/ttyd/ws?token=test-token&bridgeId=bridge-prod",
  );
});

test("resolveTerminalConnection keeps direct relay websocket urls intact for bridge terminals", async () => {
  setWindowLocation("https://app.conductross.com/sessions/bridge-session");
  setBackendOriginMeta("https://api.conductross.com");
  setFetchResponse({
    required: false,
    ttydHttpUrl: "/api/sessions/session-bridge/terminal/ttyd?bridgeId=bridge-prod",
    ttydWsUrl: "wss://relay.example.com/terminal/abc/browser?jwt=test",
  });

  const connection = await resolveTerminalConnection("bridge-session", { bridgeId: "bridge-prod" });

  assert.equal(connection.interactive, true);
  assert.equal(connection.reason, null);
  assert.equal(
    connection.terminalUrl,
    "https://app.conductross.com/api/sessions/session-bridge/terminal/ttyd?bridgeId=bridge-prod",
  );
  assert.equal(
    connection.websocketUrl,
    "wss://relay.example.com/terminal/abc/browser?jwt=test",
  );
});
