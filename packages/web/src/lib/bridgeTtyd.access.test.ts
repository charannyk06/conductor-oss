import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt } from "jose";

import { createBridgeTtydRelayWebSocketUrl } from "./bridgeTtyd";

const env = process.env as Record<string, string | undefined>;
const TEST_ENV_KEYS = [
  "CO_CONFIG_PATH",
  "CONDUCTOR_WORKSPACE",
  "CONDUCTOR_REQUIRE_AUTH",
  "CONDUCTOR_ALLOW_LOCAL_UNAUTHENTICATED",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CONDUCTOR_BRIDGE_RELAY_URL",
  "RELAY_JWT_SECRET",
  "NODE_ENV",
] as const;
const originalEnv = new Map(TEST_ENV_KEYS.map((key) => [key, env[key]] as const));
const originalFetch = globalThis.fetch;

function resetBridgeTtydEnv(): void {
  env.CO_CONFIG_PATH = "/tmp/conductor-bridge-ttyd-test-config-does-not-exist.yaml";
  env.CONDUCTOR_WORKSPACE = "";
  env.CONDUCTOR_REQUIRE_AUTH = "";
  env.CONDUCTOR_ALLOW_LOCAL_UNAUTHENTICATED = "true";
  env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "";
  env.CLERK_SECRET_KEY = "";
  env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";
  env.RELAY_JWT_SECRET = "bridge-ttyd-test-secret-at-least-32-bytes";
  env.NODE_ENV = "test";
  globalThis.fetch = originalFetch;
}

test.beforeEach(resetBridgeTtydEnv);

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
});

test("bridge ttyd relay creation rejects callers without operator access before relay I/O", { concurrency: false }, async () => {
  env.CONDUCTOR_REQUIRE_AUTH = "true";
  let relayCalled = false;
  globalThis.fetch = (async () => {
    relayCalled = true;
    throw new Error("relay should not be called");
  }) as typeof fetch;

  await assert.rejects(
    createBridgeTtydRelayWebSocketUrl(
      new Request("https://dashboard.example.com/api/sessions/session-1/terminal/ttyd"),
      "bridge-1",
      "session-1",
    ),
    /Operator access is required/,
  );
  assert.equal(relayCalled, false);
});

test("local operator bridge ttyd relay creation keeps working with a short-lived token", { concurrency: false }, async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(
      input.toString(),
      "https://relay.example.com/api/devices/bridge-1/terminals",
    );
    assert.equal(init?.method, "POST");
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
    return Response.json({ terminal_id: "terminal-1" });
  }) as typeof fetch;

  const relayUrl = await createBridgeTtydRelayWebSocketUrl(
    new Request("http://127.0.0.1:3000/api/sessions/session-1/terminal/ttyd"),
    "bridge-1",
    "session-1",
  );
  const parsed = new URL(relayUrl);
  const token = parsed.searchParams.get("jwt");
  assert.ok(token);
  const claims = decodeJwt(token);
  assert.equal(claims.scope, "terminal-browser");
  assert.equal(typeof claims.iat, "number");
  assert.equal(typeof claims.exp, "number");
  assert.ok((claims.exp ?? 0) - (claims.iat ?? 0) <= 5 * 60);
  assert.equal(parsed.pathname, "/terminal/terminal-1/browser");
});
