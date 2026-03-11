import assert from "node:assert/strict";
import test from "node:test";
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
const originalFetch = global.fetch;

function resetEnv(): void {
  delete process.env.CONDUCTOR_BACKEND_URL;
  process.env.CO_CONFIG_PATH = "/tmp/conductor-terminal-connection-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "terminal-connection-route-test-workspace";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  delete process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
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
    const payload = await response.json() as {
      transport: string;
      wsUrl: string | null;
      pollIntervalMs: number;
      interactive: boolean;
      requiresToken: boolean;
      tokenExpiresInSeconds: number | null;
      fallbackReason: string | null;
    };

    assert.equal(payload.transport, "websocket");
    assert.equal(payload.wsUrl, "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, true);
    assert.equal(payload.tokenExpiresInSeconds, 60);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
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
    const payload = await response.json() as {
      transport: string;
      wsUrl: string | null;
      pollIntervalMs: number;
      interactive: boolean;
      requiresToken: boolean;
      tokenExpiresInSeconds: number | null;
      fallbackReason: string | null;
    };

    assert.equal(payload.transport, "websocket");
    assert.equal(payload.wsUrl, "wss://laptop.tailnet.ts.net:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, true);
    assert.equal(payload.tokenExpiresInSeconds, 60);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
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
    const payload = await response.json() as {
      transport: string;
      wsUrl: string | null;
      pollIntervalMs: number;
      interactive: boolean;
      requiresToken: boolean;
      tokenExpiresInSeconds: number | null;
      fallbackReason: string | null;
    };

    assert.equal(payload.transport, "websocket");
    assert.equal(payload.wsUrl, "wss://backend.example.com:4749/api/sessions/session-1/terminal/ws?token=signed-token");
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, true);
    assert.equal(payload.tokenExpiresInSeconds, 60);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET falls back to snapshot mode when no browser-reachable websocket endpoint is available", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  global.fetch = (async () => {
    throw new Error("terminal token lookup should not run for snapshot fallback");
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
    const payload = await response.json() as {
      transport: string;
      wsUrl: string | null;
      pollIntervalMs: number;
      interactive: boolean;
      requiresToken: boolean;
      tokenExpiresInSeconds: number | null;
      fallbackReason: string | null;
    };

    assert.equal(payload.transport, "snapshot");
    assert.equal(payload.wsUrl, null);
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.match(payload.fallbackReason ?? "", /browser-connectable terminal websocket/i);
    assert.equal(typeof payload.pollIntervalMs, "number");
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET falls back to snapshot mode for viewers without operator access", async () => {
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
    throw new Error("terminal token lookup should not run for viewer snapshot fallback");
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
    const payload = await response.json() as {
      transport: string;
      wsUrl: string | null;
      pollIntervalMs: number;
      interactive: boolean;
      requiresToken: boolean;
      tokenExpiresInSeconds: number | null;
      fallbackReason: string | null;
    };

    assert.equal(payload.transport, "snapshot");
    assert.equal(payload.wsUrl, null);
    assert.equal(payload.interactive, false);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.match(payload.fallbackReason ?? "", /operator access/i);
    assert.equal(typeof payload.pollIntervalMs, "number");
  } finally {
    global.fetch = originalFetch;
  }
});
