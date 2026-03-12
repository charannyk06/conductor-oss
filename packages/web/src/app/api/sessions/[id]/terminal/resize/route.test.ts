import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { clearRemoteAccessRuntimeState } from "@/lib/remoteAccessRuntime";
import { POST } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalFetch = global.fetch;

function resetEnv(): void {
  delete process.env.CONDUCTOR_BACKEND_URL;
  process.env.CO_CONFIG_PATH = "/tmp/conductor-terminal-resize-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  clearRemoteAccessRuntimeState();
}

async function decodeBody(body: BodyInit | null): Promise<string> {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return String(body);
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

test("POST preserves resize benchmark headers through the dashboard proxy", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  let targetUrl = "";
  let forwardedBody = "";

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    targetUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    forwardedBody = await decodeBody(init?.body ?? null);

    return new Response(JSON.stringify({
      ok: true,
      sessionId: "session-1",
      cols: 120,
      rows: 32,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Server-Timing": "terminal_resize;dur=41.6",
        "x-conductor-terminal-resize-cols": "120",
        "x-conductor-terminal-resize-rows": "32",
      },
    });
  }) as typeof fetch;

  const response = await POST(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/resize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify({ cols: 120, rows: 32 }),
    }),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(targetUrl, "http://127.0.0.1:4749/api/sessions/session-1/terminal/resize");
  assert.equal(forwardedBody, "{\"cols\":120,\"rows\":32}");
  assert.equal(response.headers.get("server-timing"), "terminal_resize;dur=41.6");
  assert.equal(response.headers.get("x-conductor-terminal-resize-cols"), "120");
  assert.equal(response.headers.get("x-conductor-terminal-resize-rows"), "32");

  const payload = await response.json() as {
    ok: boolean;
    cols: number;
    rows: number;
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.cols, 120);
  assert.equal(payload.rows, 32);
});

test("POST rejects cross-origin resize requests before proxying terminal control", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  let fetchCalled = false;
  global.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
    fetchCalled = true;
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const response = await POST(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/resize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    }),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 403);
  assert.equal(fetchCalled, false);

  const payload = await response.json() as { error: string; reason: string };
  assert.equal(payload.error, "Invalid request context");
  assert.match(payload.reason, /Cross-site requests are not allowed/);
});
