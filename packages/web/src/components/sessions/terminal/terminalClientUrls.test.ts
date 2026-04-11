import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBrowserBackendOrigin,
  resolveNativeTerminalWebSocketUrl,
} from "./terminalClientUrls";

const env = process.env as Record<string, string | undefined>;
const previousPublicBackendUrl = env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL;
const previousDocument = globalThis.document;

test.afterEach(() => {
  if (previousPublicBackendUrl === undefined) {
    delete env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL;
  } else {
    env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL = previousPublicBackendUrl;
  }
  Object.defineProperty(globalThis, "document", {
    value: previousDocument,
    configurable: true,
    writable: true,
  });
});

test("normalizeBrowserBackendOrigin remaps loopback backend hints onto hosted origins", () => {
  assert.equal(
    normalizeBrowserBackendOrigin("http://127.0.0.1:4749", "https://app.conductross.com"),
    "https://app.conductross.com:4749",
  );
});

test("resolveNativeTerminalWebSocketUrl routes native terminal websocket paths to the backend origin", () => {
  Object.defineProperty(globalThis, "document", {
    value: {
      querySelector: () => ({ content: "http://127.0.0.1:4749" }),
    },
    configurable: true,
    writable: true,
  });

  assert.equal(
    resolveNativeTerminalWebSocketUrl(
      "/api/sessions/demo/terminal/ws?token=abc",
      "https://app.conductross.com",
    ),
    "wss://app.conductross.com:4749/api/sessions/demo/terminal/ws?token=abc",
  );
});

test("resolveNativeTerminalWebSocketUrl keeps non-terminal paths on the current origin", () => {
  Object.defineProperty(globalThis, "document", {
    value: { querySelector: () => null },
    configurable: true,
    writable: true,
  });

  assert.equal(
    resolveNativeTerminalWebSocketUrl("/socket.io/live", "https://app.conductross.com"),
    "wss://app.conductross.com/socket.io/live",
  );
});

test("resolveNativeTerminalWebSocketUrl preserves explicit websocket URLs", () => {
  assert.equal(
    resolveNativeTerminalWebSocketUrl("wss://backend.example.com/terminal", "https://app.conductross.com"),
    "wss://backend.example.com/terminal",
  );
});
