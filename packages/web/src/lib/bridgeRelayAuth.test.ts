import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLegacyBridgeRelayAuthHeaders,
  buildBridgeRelayWebSocketUrl,
  resolveBridgeRelayUserId,
} from "./bridgeRelayAuth";

test("resolveBridgeRelayUserId prefers the normalized dashboard email", () => {
  assert.equal(
    resolveBridgeRelayUserId({
      ok: true,
      authenticated: true,
      email: " Dev@Example.com ",
      provider: "clerk",
      role: "viewer",
    }),
    "dev@example.com",
  );
});

test("resolveBridgeRelayUserId falls back to the local admin id", () => {
  assert.equal(
    resolveBridgeRelayUserId({
      ok: true,
      authenticated: false,
      email: "local",
      provider: "local",
      role: "admin",
    }),
    "local",
  );

  assert.equal(
    resolveBridgeRelayUserId({
      ok: true,
      authenticated: false,
      provider: "local",
      role: "admin",
    }),
    "local-admin",
  );
});

test("appendLegacyBridgeRelayAuthHeaders includes legacy email headers for remote users", () => {
  const headers = appendLegacyBridgeRelayAuthHeaders(
    new Headers(),
    {
      ok: true,
      authenticated: true,
      email: "dev@example.com",
      provider: "clerk",
      role: "viewer",
    },
    "dev@example.com",
  );

  assert.equal(headers.get("x-conductor-proxy-authorized"), "true");
  assert.equal(headers.get("x-conductor-access-email"), "dev@example.com");
  assert.equal(headers.get("x-bridge-user-id"), null);
});

test("appendLegacyBridgeRelayAuthHeaders includes the legacy local user header for local access", () => {
  const headers = appendLegacyBridgeRelayAuthHeaders(
    new Headers(),
    {
      ok: true,
      authenticated: false,
      email: "local",
      provider: "local",
      role: "admin",
    },
    "local-admin",
  );

  assert.equal(headers.get("x-conductor-proxy-authorized"), "true");
  assert.equal(headers.get("x-conductor-access-email"), null);
  assert.equal(headers.get("x-bridge-user-id"), "local-admin");
});

test("buildBridgeRelayWebSocketUrl keeps websocket auth material out of the url", () => {
  const previousRelayUrl = process.env.CONDUCTOR_BRIDGE_RELAY_URL;
  process.env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com/base/";

  try {
    assert.equal(
      buildBridgeRelayWebSocketUrl("/terminal/terminal-123/browser", "jwt-placeholder"),
      "wss://relay.example.com/terminal/terminal-123/browser",
    );
  } finally {
    if (previousRelayUrl === undefined) {
      delete process.env.CONDUCTOR_BRIDGE_RELAY_URL;
    } else {
      process.env.CONDUCTOR_BRIDGE_RELAY_URL = previousRelayUrl;
    }
  }
});
