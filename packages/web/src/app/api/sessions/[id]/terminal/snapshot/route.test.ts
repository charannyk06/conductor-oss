import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { clearRemoteAccessRuntimeState } from "@/lib/remoteAccessRuntime";
import { GET } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalFetch = global.fetch;

function resetEnv(): void {
  delete process.env.CONDUCTOR_BACKEND_URL;
  process.env.CO_CONFIG_PATH = "/tmp/conductor-terminal-snapshot-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  clearRemoteAccessRuntimeState();
}

test.afterEach(() => {
  resetEnv();
  global.fetch = originalFetch;
});

test.after(() => {
  if (originalBackendUrl === undefined) {
    delete process.env.CONDUCTOR_BACKEND_URL;
  } else {
    process.env.CONDUCTOR_BACKEND_URL = originalBackendUrl;
  }

  if (originalConfigPath === undefined) {
    delete process.env.CO_CONFIG_PATH;
  } else {
    process.env.CO_CONFIG_PATH = originalConfigPath;
  }

  if (originalWorkspace === undefined) {
    delete process.env.CONDUCTOR_WORKSPACE;
  } else {
    process.env.CONDUCTOR_WORKSPACE = originalWorkspace;
  }

  if (originalRequireAuth === undefined) {
    delete process.env.CONDUCTOR_REQUIRE_AUTH;
  } else {
    process.env.CONDUCTOR_REQUIRE_AUTH = originalRequireAuth;
  }

  global.fetch = originalFetch;
  clearRemoteAccessRuntimeState();
});

test("GET preserves terminal snapshot observability headers through the dashboard proxy", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  let targetUrl = "";
  let forwardedHost = "";
  let forwardedRole = "";

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    targetUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const headers = new Headers(init?.headers);
    forwardedHost = headers.get("x-forwarded-host") ?? "";
    forwardedRole = headers.get("x-conductor-access-role") ?? "";

    return new Response(JSON.stringify({
      snapshot: "restored prompt",
      source: "terminal_state",
      live: true,
      restored: true,
      format: "restore-frame",
      sequence: 42,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Server-Timing": "terminal_snapshot;dur=63.1",
        "x-conductor-terminal-snapshot-source": "terminal_state",
        "x-conductor-terminal-snapshot-live": "true",
        "x-conductor-terminal-snapshot-restored": "true",
        "x-conductor-terminal-snapshot-format": "restore-frame",
      },
    });
  }) as typeof fetch;

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/snapshot?lines=1200&live=1"),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(
    targetUrl,
    "http://127.0.0.1:4749/api/sessions/session-1/terminal/snapshot?lines=1200&live=1",
  );
  assert.match(forwardedHost, /^(127\.0\.0\.1|localhost):3000$/);
  assert.equal(forwardedRole, "admin");
  assert.equal(response.headers.get("server-timing"), "terminal_snapshot;dur=63.1");
  assert.equal(response.headers.get("x-conductor-terminal-snapshot-source"), "terminal_state");
  assert.equal(response.headers.get("x-conductor-terminal-snapshot-live"), "true");
  assert.equal(response.headers.get("x-conductor-terminal-snapshot-restored"), "true");
  assert.equal(response.headers.get("x-conductor-terminal-snapshot-format"), "restore-frame");

  const payload = await response.json() as {
    snapshot: string;
    source: string;
    restored: boolean;
  };

  assert.equal(payload.snapshot, "restored prompt");
  assert.equal(payload.source, "terminal_state");
  assert.equal(payload.restored, true);
});
