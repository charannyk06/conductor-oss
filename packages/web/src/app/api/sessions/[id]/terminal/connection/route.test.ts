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
const originalRemoteAccessRuntimePath =
  process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH;
const originalRemoteAccessToken = process.env.CONDUCTOR_REMOTE_ACCESS_TOKEN;
const originalRemoteSessionSecret = process.env.CONDUCTOR_REMOTE_SESSION_SECRET;
const originalFetch = global.fetch;

type TerminalConnectionPayload = {
  transport: string;
  wsUrl: string | null;
  ptyWsUrl?: string | null;
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
  process.env.CO_CONFIG_PATH =
    "/tmp/conductor-terminal-connection-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "terminal-connection-route-test-workspace";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  delete process.env.CONDUCTOR_ACCESS_DEFAULT_ROLE;
  delete process.env.CONDUCTOR_REMOTE_ACCESS_TOKEN;
  delete process.env.CONDUCTOR_REMOTE_SESSION_SECRET;
  process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH = join(
    tmpdir(),
    "conductor-terminal-connection-route-runtime.json"
  );
  clearRemoteAccessRuntimeState();
}

type MockSessionConnectionFetchOptions = {
  id: string;
  metadata?: Record<string, unknown> | null;
  token?: {
    token?: string | null;
    required?: boolean;
    expiresInSeconds?: number | null;
    error?: string;
  };
};

function setMockSessionConnectionFetch({
  id,
  metadata = { runtimeMode: "direct" },
  token,
}: MockSessionConnectionFetchOptions): void {
  const sessionMetadataUrl = `/api/sessions/${encodeURIComponent(id)}`;
  const terminalTokenUrl = `/api/sessions/${encodeURIComponent(
    id
  )}/terminal/token`;
  global.fetch = (async (input: string | Request | URL) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);
    if (url.pathname === sessionMetadataUrl) {
      return new Response(
        JSON.stringify(metadata === null ? null : { metadata }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    if (url.pathname === terminalTokenUrl) {
      if (token === undefined) {
        throw new Error("terminal token lookup should not run for this test");
      }
      return new Response(JSON.stringify(token), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(
      `Unexpected fetch in terminal connection route test: ${url.pathname}`
    );
  }) as typeof fetch;
}

function assertJsonResponse(
  response: Response
): Promise<TerminalConnectionPayload> {
  return response.json() as Promise<TerminalConnectionPayload>;
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
    process.env.CONDUCTOR_REMOTE_ACCESS_RUNTIME_PATH =
      originalRemoteAccessRuntimePath;
  }

  if (originalRemoteAccessToken === undefined) {
    delete process.env.CONDUCTOR_REMOTE_ACCESS_TOKEN;
  } else {
    process.env.CONDUCTOR_REMOTE_ACCESS_TOKEN = originalRemoteAccessToken;
  }

  if (originalRemoteSessionSecret === undefined) {
    delete process.env.CONDUCTOR_REMOTE_SESSION_SECRET;
  } else {
    process.env.CONDUCTOR_REMOTE_SESSION_SECRET = originalRemoteSessionSecret;
  }

  global.fetch = originalFetch;
  clearRemoteAccessRuntimeState();
});

test("GET returns a dashboard-proxied eventstream transport for loopback dashboard requests", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  setMockSessionConnectionFetch({
    id: "session-1",
  });

  try {
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/api/sessions/session-1/terminal/connection"
      ),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-conductor-terminal-transport"),
      "eventstream"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-interactive"),
      "true"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-connection-path"),
      "dashboard_proxy"
    );
    assert.match(
      response.headers.get("server-timing") ?? "",
      /terminal_connection;dur=/
    );
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(
      payload.ptyWsUrl,
      "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?protocol=ttyd"
    );
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.equal(payload.fallbackReason, null);
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
      fallbackReason: null,
      sendPath: "/api/sessions/session-1/send",
      keysPath: "/api/sessions/session-1/keys",
      resizePath: "/api/sessions/session-1/terminal/resize",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET returns the same dashboard-proxied eventstream transport for authenticated remote requests", async () => {
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

  setMockSessionConnectionFetch({
    id: "session-1",
  });

  try {
    const request = new NextRequest(
      "https://laptop.tailnet.ts.net/api/sessions/session-1/terminal/connection",
      {
        headers: {
          "Tailscale-User-Login": "dev@example.com",
        },
      }
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    assert.equal(response.status, 200);
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(
      payload.ptyWsUrl,
      "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?protocol=ttyd"
    );
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.equal(payload.stream.transport, "eventstream");
    assert.equal(
      payload.stream.wsUrl,
      "/api/sessions/session-1/terminal/stream"
    );
    assert.equal(payload.control.transport, "http");
    assert.equal(payload.control.wsUrl, null);
    assert.equal(payload.control.sendPath, "/api/sessions/session-1/send");
    assert.equal(payload.control.keysPath, "/api/sessions/session-1/keys");
    assert.equal(
      payload.control.resizePath,
      "/api/sessions/session-1/terminal/resize"
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET keeps the dashboard-proxied stream even when the backend URL is browser-reachable", async () => {
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

  setMockSessionConnectionFetch({
    id: "session-1",
  });

  try {
    const request = new NextRequest(
      "https://dashboard.example.com/api/sessions/session-1/terminal/connection",
      {
        headers: {
          "Tailscale-User-Login": "dev@example.com",
        },
      }
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    assert.equal(response.status, 200);
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(
      payload.ptyWsUrl,
      "wss://backend.example.com:4749/api/sessions/session-1/terminal/ws?protocol=ttyd"
    );
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.equal(payload.fallbackReason, null);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.equal(payload.stream.transport, "eventstream");
    assert.equal(
      payload.stream.wsUrl,
      "/api/sessions/session-1/terminal/stream"
    );
    assert.equal(payload.control.transport, "http");
    assert.equal(payload.control.wsUrl, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET does not fetch backend runtime metadata before returning the live stream", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  global.fetch = (async () => {
    throw new Error("connection route should not fetch runtime metadata");
  }) as typeof fetch;

  try {
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/api/sessions/session-1/terminal/connection"
      ),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-conductor-terminal-transport"),
      "eventstream"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-interactive"),
      "true"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-connection-path"),
      "dashboard_proxy"
    );
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.interactive, true);
    assert.equal(
      payload.ptyWsUrl,
      "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?protocol=ttyd"
    );
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.fallbackReason, null);
    assert.equal(payload.stream.transport, "eventstream");
    assert.equal(payload.control.transport, "http");
    assert.equal(payload.control.interactive, true);
    assert.equal(payload.control.fallbackReason, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET keeps the live eventstream transport when runtime mode metadata is missing", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  setMockSessionConnectionFetch({
    id: "session-1",
    metadata: {},
  });

  try {
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/api/sessions/session-1/terminal/connection"
      ),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-conductor-terminal-transport"),
      "eventstream"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-interactive"),
      "true"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-connection-path"),
      "dashboard_proxy"
    );
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.interactive, true);
    assert.equal(
      payload.ptyWsUrl,
      "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?protocol=ttyd"
    );
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.fallbackReason, null);
    assert.equal(payload.stream.transport, "eventstream");
    assert.equal(payload.control.transport, "http");
    assert.equal(payload.control.interactive, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET uses the same live dashboard-proxied stream when the dashboard is serving a remote request", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  setMockSessionConnectionFetch({
    id: "session-1",
  });

  try {
    const request = new NextRequest(
      "http://127.0.0.1:3000/api/sessions/session-1/terminal/connection",
      {
        headers: {
          "x-forwarded-host": "example.com",
        },
      }
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-conductor-terminal-transport"),
      "eventstream"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-interactive"),
      "true"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-connection-path"),
      "dashboard_proxy"
    );
    assert.match(
      response.headers.get("server-timing") ?? "",
      /terminal_connection;dur=/
    );
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(
      payload.ptyWsUrl,
      "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?protocol=ttyd"
    );
    assert.equal(payload.interactive, true);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.equal(payload.fallbackReason, null);
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
      fallbackReason: null,
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

  setMockSessionConnectionFetch({
    id: "session-1",
  });

  try {
    const request = new NextRequest(
      "https://laptop.tailnet.ts.net/api/sessions/session-1/terminal/connection",
      {
        headers: {
          "Tailscale-User-Login": "viewer@example.com",
        },
      }
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-conductor-terminal-transport"),
      "eventstream"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-interactive"),
      "false"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-connection-path"),
      "dashboard_proxy"
    );
    assert.match(
      response.headers.get("server-timing") ?? "",
      /terminal_connection;dur=/
    );
    const payload = await assertJsonResponse(response);

    assert.equal(payload.transport, "eventstream");
    assert.equal(payload.wsUrl, "/api/sessions/session-1/terminal/stream");
    assert.equal(payload.ptyWsUrl, undefined);
    assert.equal(payload.interactive, false);
    assert.equal(payload.requiresToken, false);
    assert.equal(payload.tokenExpiresInSeconds, null);
    assert.match(payload.fallbackReason ?? "", /read-only mode/i);
    assert.equal(typeof payload.pollIntervalMs, "number");
    assert.equal(payload.stream.transport, "eventstream");
    assert.equal(
      payload.stream.wsUrl,
      "/api/sessions/session-1/terminal/stream"
    );
    assert.equal(payload.control.transport, "http");
    assert.equal(payload.control.wsUrl, null);
    assert.equal(payload.control.interactive, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET appends a control token to the direct PTY websocket when auth is required", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  process.env.CONDUCTOR_REQUIRE_AUTH = "true";

  setMockSessionConnectionFetch({
    id: "session-1",
    token: {
      required: true,
      token: "signed-terminal-token",
      expiresInSeconds: 60,
    },
  });

  try {
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/api/sessions/session-1/terminal/connection"
      ),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    assert.equal(response.status, 200);
    const payload = await assertJsonResponse(response);
    assert.equal(
      payload.ptyWsUrl,
      "ws://127.0.0.1:4749/api/sessions/session-1/terminal/ws?protocol=ttyd&token=signed-terminal-token"
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET ignores remote runtime readiness because the dashboard owns the stream path", async () => {
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

  setMockSessionConnectionFetch({
    id: "session-1",
  });

  try {
    const request = new NextRequest(
      "https://laptop.tailnet.ts.net/api/sessions/session-1/terminal/connection",
      {
        headers: {
          "Tailscale-User-Login": "dev@example.com",
        },
      }
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "session-1" }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-conductor-terminal-transport"),
      "eventstream"
    );
    assert.equal(
      response.headers.get("x-conductor-terminal-connection-path"),
      "dashboard_proxy"
    );
  } finally {
    global.fetch = originalFetch;
  }
});
