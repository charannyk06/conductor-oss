import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  clearRemoteAccessRuntimeState,
  writeRemoteAccessRuntimeState,
} from "@/lib/remoteAccessRuntime";
import { GET } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalDefaultRole = process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
const originalRemoteAccessRuntimePath = process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH;
const originalFetch = global.fetch;

type TerminalConnectionPayload = {
  transport: string;
  wsUrl: string | null;
  pollIntervalMs: number;
  interactive: boolean;
  requiresToken: boolean;
  tokenExpiresInSeconds: number | null;
  fallbackReason: string | null;
  stream: {
    transport: string;
    wsUrl: string | null;
    pollIntervalMs: number;
  };
  control: {
    transport: string;
    wsUrl: string | null;
    interactive: boolean;
    requiresToken: boolean;
    tokenExpiresInSeconds: number | null;
    fallbackReason: string | null;
    sendPath: string;
    keysPath: string;
    resizePath: string;
  };
};

function resetEnv(): void {
  delete process.env.CONDUCTOR_BACKEND_URL;
  process.env.CO_CONFIG_PATH = "/tmp/conductor-terminal-connection-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "terminal-connection-route-test-workspace";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  delete process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
  process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH = join(
    tmpdir(),
    "conductor-terminal-connection-route-runtime.json",
  );
  clearRemoteAccessRuntimeState();
}

test.afterEach(() => {
  resetEnv();
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
  clearRemoteAccessRuntimeState();
});

test("GET returns a websocket transport for loopback dashboard requests", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  global.fetch = (async () => new Response(JSON.stringify({ token: "signed-token" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  try {
    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/connection"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-conductor-terminal-transport"), "websocket");
    assert.equal(response.headers.get("x-conductor-terminal-interactive"), "true");
    assert.equal(response.headers.get("x-conductor-terminal-connection-path"), "direct");
    assert.match(response.headers.get("server-timing") ?? "", /terminal_connection;dur=/);
    assert.match(response.headers.get("server-timing") ?? "", /terminal_token;dur=/);
    const payload = await response.json() as TerminalConnectionPayload;

    assert.equal(payload.transport, "websocket");
    assert.equal(payload.wsUrl, "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, true);
    assert.equal(payload.tokenExpiresInSeconds, 60);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.deepEqual(payload.stream, {
      transport: "websocket",
      wsUrl: "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?token=signed-token",
      pollIntervalMs: payload.pollIntervalMs,
    });
    assert.deepEqual(payload.control, {
      transport: "websocket",
      wsUrl: "ws://127.0.0.1:4749/api/sessions/session-1/terminal/control/ws?token=signed-token",
      interactive: true,
      requiresToken: true,
      tokenExpiresInSeconds: 60,
      fallbackReason: null,
      sendPath: "/api/sessions/session-1/send",
      keysPath: "/api/sessions/session-1/keys",
      resizePath: "/api/sessions/session-1/terminal/resize",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET returns a tailscale websocket transport for authenticated remote requests", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  writeRemoteAccessRuntimeState({
    status: "ready",
    provider: "tailscale",
    publicUrl: "https://laptop.tailnet.ts.net",
    localUrl: "http://127.0.0.1:3000",
    accessToken: null,
    sessionSecret: null,
    tunnelPid: null,
    logPath: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  });

  global.fetch = (async () => new Response(JSON.stringify({
    token: "signed-token",
    required: true,
    expiresInSeconds: 60,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  try {
    const request = new NextRequest("https://laptop.tailnet.ts.net/api/sessions/session-1/terminal/connection", {
      headers: {
        "Tailscale-User-Login": "dev@example.com",
      },
    });
    const response = await GET(
      request,
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as TerminalConnectionPayload;

    assert.equal(payload.transport, "websocket");
    assert.equal(payload.wsUrl, "wss://laptop.tailnet.ts.net:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, true);
    assert.equal(payload.tokenExpiresInSeconds, 60);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.equal(payload.stream.transport, "websocket");
    assert.equal(payload.stream.wsUrl, "wss://laptop.tailnet.ts.net:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.control.transport, "websocket");
    assert.equal(payload.control.wsUrl, "wss://laptop.tailnet.ts.net:4749/api/sessions/session-1/terminal/control/ws?token=signed-token");
    assert.equal(payload.control.sendPath, "/api/sessions/session-1/send");
    assert.equal(payload.control.keysPath, "/api/sessions/session-1/keys");
    assert.equal(payload.control.resizePath, "/api/sessions/session-1/terminal/resize");
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET uses a direct websocket when the backend URL is already browser-reachable", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "https://backend.example.com:4749";
  writeRemoteAccessRuntimeState({
    status: "ready",
    provider: "tailscale",
    publicUrl: "https://laptop.tailnet.ts.net",
    localUrl: "http://127.0.0.1:3000",
    accessToken: null,
    sessionSecret: null,
    tunnelPid: null,
    logPath: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  });

  global.fetch = (async () => new Response(JSON.stringify({
    token: "signed-token",
    required: true,
    expiresInSeconds: 60,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  try {
    const request = new NextRequest("https://dashboard.example.com/api/sessions/session-1/terminal/connection", {
      headers: {
        "Tailscale-User-Login": "dev@example.com",
      },
    });
    const response = await GET(
      request,
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as TerminalConnectionPayload;

    assert.equal(payload.transport, "websocket");
    assert.equal(payload.wsUrl, "wss://backend.example.com:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, true);
    assert.equal(payload.tokenExpiresInSeconds, 60);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.equal(payload.stream.transport, "websocket");
    assert.equal(payload.stream.wsUrl, "wss://backend.example.com:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.control.transport, "websocket");
    assert.equal(payload.control.wsUrl, "wss://backend.example.com:4749/api/sessions/session-1/terminal/control/ws?token=signed-token");
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET uses a live dashboard-proxied stream when no browser-reachable websocket endpoint is available", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  global.fetch = (async () => {
    throw new Error("terminal token lookup should not run for dashboard-proxied streaming");
  }) as typeof fetch;

  try {
    const request = new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/connection", {
      headers: {
        "x-forwarded-host": "example.com",
      },
    });
    const response = await GET(
      request,
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-conductor-terminal-transport"), "eventstream");
    assert.equal(response.headers.get("x-conductor-terminal-interactive"), "true");
    assert.equal(response.headers.get("x-conductor-terminal-connection-path"), "dashboard_proxy");
    assert.match(response.headers.get("server-timing") ?? "", /terminal_connection;dur=/);
    const payload = await response.json() as TerminalConnectionPayload;

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.match(payload.fallbackReason ?? "", /proxied through the dashboard/i);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.deepEqual(payload.stream, {
      transport: "eventstream",
      wsUrl: "/api/sessions/session-1/terminal/stream",
      pollIntervalMs: payload.pollIntervalMs,
    });
    assert.deepEqual(payload.control, {
      transport: "http",
      wsUrl: null,
      interactive: true,
      requiresToken: false,
      tokenExpiresInSeconds: null,
      fallbackReason: payload.fallbackReason,
      sendPath: "/api/sessions/session-1/send",
      keysPath: "/api/sessions/session-1/keys",
      resizePath: "/api/sessions/session-1/terminal/resize",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET keeps a live read-only stream for viewers without operator access", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE = "viewer";

  writeRemoteAccessRuntimeState({
    status: "ready",
    provider: "tailscale",
    publicUrl: "https://laptop.tailnet.ts.net",
    localUrl: "http://127.0.0.1:3000",
    accessToken: null,
    sessionSecret: null,
    tunnelPid: null,
    logPath: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  });

  global.fetch = (async () => {
    throw new Error("terminal token lookup should not run for viewer live stream fallback");
  }) as typeof fetch;

  try {
    const request = new NextRequest("https://laptop.tailnet.ts.net/api/sessions/session-1/terminal/connection", {
      headers: {
        "Tailscale-User-Login": "viewer@example.com",
      },
    });
    const response = await GET(
      request,
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-conductor-terminal-transport"), "eventstream");
    assert.equal(response.headers.get("x-conductor-terminal-interactive"), "false");
    assert.equal(response.headers.get("x-conductor-terminal-connection-path"), "auth_limited");
    assert.match(response.headers.get("server-timing") ?? "", /terminal_connection;dur=/);
    const payload = await response.json() as TerminalConnectionPayload;

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(payload.interactive, false);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.match(payload.fallbackReason ?? "", /read-only mode/i);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.equal(payload.stream.transport, "eventstream");
    assert.equal(payload.stream.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(payload.control.transport, "http");
    assert.equal(payload.control.wsUrl, null);
    assert.equal(payload.control.interactive, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET rejects remote requests without operator access while remote runtime is not ready", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  writeRemoteAccessRuntimeState({
    status: "starting",
    provider: "tailscale",
    publicUrl: "https://laptop.tailnet.ts.net",
    localUrl: "http://127.0.0.1:3000",
    accessToken: null,
    sessionSecret: null,
    tunnelPid: null,
    logPath: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  });

  global.fetch = (async () => {
    throw new Error("terminal token lookup should not run before the remote runtime is ready");
  }) as typeof fetch;

  try {
    const request = new NextRequest("https://laptop.tailnet.ts.net/api/sessions/session-1/terminal/connection", {
      headers: {
        "Tailscale-User-Login": "dev@example.com",
      },
    });
    const response = await GET(
      request,
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 403);
  } finally {
    global.fetch = originalFetch;
  }
});
