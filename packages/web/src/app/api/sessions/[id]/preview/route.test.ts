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
  process.env.CO_CONFIG_PATH = "/tmp/conductor-preview-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
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

  global.fetch = originalFetch;

  clearRemoteAccessRuntimeState();
});

test("GET returns disconnected preview state when backend lookup is unavailable", async () => {
  resetEnv();

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/preview"),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 200);

  const payload = await response.json() as {
    connected: boolean;
    candidateUrls: string[];
    currentUrl: string | null;
    lastError: string | null;
  };

  assert.equal(payload.connected, false);
  assert.deepEqual(payload.candidateUrls, []);
  assert.equal(payload.currentUrl, null);
  assert.equal(payload.lastError, "Rust backend URL is not configured");
});

test("GET forwards dashboard access headers to backend preview lookups", async () => {
  resetEnv();
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  const seenAuthHeaders: string[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    const headers = new Headers(init?.headers);
    seenAuthHeaders.push(headers.get("x-conductor-proxy-authorized") ?? "missing");

    if (url.endsWith("/api/sessions/session-1")) {
      return new Response(JSON.stringify({
        id: "session-1",
        projectId: "demo",
        status: "working",
        activity: "active",
        branch: "feature/demo",
        issueId: null,
        summary: null,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pr: null,
        metadata: {},
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/sessions/session-1/output?lines=400")) {
      return new Response(JSON.stringify({
        output: "ready on http://localhost:3000",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/preview"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenAuthHeaders, ["true", "true"]);

    const payload = await response.json() as {
      connected: boolean;
      candidateUrls: string[];
      currentUrl: string | null;
      lastError: string | null;
    };

    assert.equal(payload.connected, false);
    assert.deepEqual(payload.candidateUrls, ["http://localhost:3000/"]);
    assert.equal(payload.currentUrl, null);
    assert.equal(payload.lastError, null);
  } finally {
    global.fetch = originalFetch;
  }
});
