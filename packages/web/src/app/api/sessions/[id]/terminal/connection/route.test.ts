import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalDefaultRole = process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
const originalRemoteAccessRuntimePath =
  process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH;
const originalFetch = global.fetch;

function resetEnv(): void {
  process.env.CO_CONFIG_PATH =
    "/tmp/conductor-terminal-connection-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "terminal-connection-route-test-workspace";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  delete process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
  process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH = "";
}

function resetBackend(): void {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
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

  if (originalDefaultRole === undefined) {
    delete process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
  } else {
    process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE = originalDefaultRole;
  }

  if (originalRemoteAccessRuntimePath === undefined) {
    delete process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH;
  } else {
    process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH = originalRemoteAccessRuntimePath;
  }

  global.fetch = originalFetch;
});

test("GET proxies backend terminal connection payload", async () => {
  resetBackend();

  const requests: string[] = [];
  global.fetch = (async (input: string | Request | URL) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/sessions/session-1/terminal/connection") {
      return new Response(JSON.stringify({
        transport: "eventstream",
        wsUrl: "/api/sessions/session-1/terminal/stream",
        pollIntervalMs: 700,
        interactive: true,
        requiresToken: false,
        tokenExpiresInSeconds: null,
        fallbackReason: null,
        stream: {
          transport: "eventstream",
          wsUrl: "/api/sessions/session-1/terminal/stream",
          pollIntervalMs: 700,
        },
        control: {
          transport: "http",
          wsUrl: null,
          interactive: true,
          requiresToken: false,
          tokenExpiresInSeconds: null,
          fallbackReason: null,
          sendPath: "/api/sessions/session-1/send",
          keysPath: "/api/sessions/session-1/keys",
          resizePath: "/api/sessions/session-1/terminal/resize",
        },
        connectionPath: "dashboard_proxy",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-conductor-terminal-transport": "eventstream",
          "x-conductor-terminal-interactive": "true",
          "x-conductor-terminal-connection-path": "dashboard_proxy",
        },
      });
    }

    throw new Error(`Unexpected fetch in connection test: ${url.pathname}`);
  }) as typeof fetch;

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/connection?lines=4096"),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-conductor-terminal-transport"),
    "eventstream",
  );
  assert.equal(response.headers.get("x-conductor-terminal-connection-path"), "dashboard_proxy");

  const payload = await response.json() as {
    transport?: string;
    wsUrl?: string | null;
    stream?: { wsUrl?: string | null };
  };
  assert.equal(payload.transport, "eventstream");
  assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
  assert.deepEqual(requests, ["/api/sessions/session-1/terminal/connection?lines=4096"]);
  assert.equal(requests.length, 1);
});

test("GET returns 502 when backend is unavailable", async () => {
  resetEnv();
  delete process.env.CONDUCTOR_BACKEND_URL;

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/connection"),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  // currentBackendUrl() falls back to http://127.0.0.1:4747 even when
  // CONDUCTOR_BACKEND_URL is unset, so the request is attempted and fails
  // with 502 Bad Gateway rather than 503 Service Unavailable.
  assert.equal(response.status, 502);
});
