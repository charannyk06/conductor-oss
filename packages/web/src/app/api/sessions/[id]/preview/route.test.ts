import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalBridgeRelayUrl = process.env.CONDUCTOR_BRIDGE_RELAY_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalRelayJwtSecret = process.env.RELAY_JWT_SECRET;
const originalFetch = global.fetch;

function resetEnv(): void {
  delete process.env.CONDUCTOR_BACKEND_URL;
  delete process.env.CONDUCTOR_BRIDGE_RELAY_URL;
  process.env.CO_CONFIG_PATH = "/tmp/conductor-preview-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  delete process.env.RELAY_JWT_SECRET;
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

  if (originalBridgeRelayUrl === undefined) {
    delete process.env.CONDUCTOR_BRIDGE_RELAY_URL;
  } else {
    process.env.CONDUCTOR_BRIDGE_RELAY_URL = originalBridgeRelayUrl;
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

  if (originalRelayJwtSecret === undefined) {
    delete process.env.RELAY_JWT_SECRET;
  } else {
    process.env.RELAY_JWT_SECRET = originalRelayJwtSecret;
  }

  global.fetch = originalFetch;
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

test("GET resolves bridge-backed preview session context via the paired device and preserves local bridge candidates", async () => {
  resetEnv();
  process.env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";
  process.env.RELAY_JWT_SECRET = "preview-route-test-secret";
  const seenPaths: string[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;

    assert.equal(url, "https://relay.example.com/api/devices/bridge-1/proxy");
    assert.equal(init?.method, "POST");

    const headers = new Headers(init?.headers);
    assert.match(headers.get("authorization") ?? "", /^Bearer\s.+/);
    assert.match(headers.get("x-forwarded-host") ?? "", /^(?:127\.0\.0\.1|localhost):3000$/);
    assert.equal(headers.get("x-forwarded-proto"), "http");

    const body = JSON.parse(String(init?.body)) as {
      method: string;
      path: string;
      body?: unknown;
    };
    seenPaths.push(body.path);

    if (body.path === "/api/sessions/session-1") {
      return new Response(JSON.stringify({
        id: "session-1",
        projectId: "demo",
        status: "working",
        activity: "active",
        branch: "feature/demo",
        issueId: null,
        summary: "preview available at https://preview.example.com",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pr: {
          number: 1,
          url: "https://github.com/example/repo/pull/1",
          title: "PR",
          branch: "feature/demo",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          ciStatus: "none",
          reviewDecision: "none",
          mergeability: {
            mergeable: true,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
          previewUrl: "https://deploy-preview.example.com",
        },
        metadata: {
          devServerUrl: "http://127.0.0.1:3000",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.path === "/api/sessions/session-1/output?lines=400") {
      return new Response(JSON.stringify({
        output: "stdout localhost:3002",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/api/sessions/bridge%3Abridge-1%3Asession-1/preview?inspect=1"),
      { params: Promise.resolve({ id: "bridge:bridge-1:session-1" }) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, [
      "/api/sessions/session-1",
      "/api/sessions/session-1/output?lines=400",
    ]);

    const payload = await response.json() as {
      connected: boolean;
      candidateUrls: string[];
      currentUrl: string | null;
      title: string | null;
      screenshotKey: string;
      lastError: string | null;
    };

      assert.equal(payload.connected, false);
      assert.deepEqual(payload.candidateUrls, [
        "http://127.0.0.1:3000/",
        "http://localhost:3002/",
      ]);
    assert.equal(payload.currentUrl, null);
    assert.equal(payload.title, null);
    assert.match(payload.screenshotKey, /^\d+$/);
    assert.equal(payload.lastError, null);
  } finally {
    global.fetch = originalFetch;
  }
});
