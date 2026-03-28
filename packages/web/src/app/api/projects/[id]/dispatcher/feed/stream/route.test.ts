import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalFetch = global.fetch;

const SSE_PAYLOAD = 'data: {"type":"append","entries":[]}\n\n';

function resetEnv(): void {
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  process.env.CO_CONFIG_PATH = "/tmp/conductor-dispatcher-stream-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
}

function buildEventStreamResponse(payload: string = SSE_PAYLOAD): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
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
});

test("GET proxies dispatcher feed streams with streaming-safe headers", async () => {
  resetEnv();

  let seenUrl = "";
  let seenHeaders = new Headers();

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    seenHeaders = new Headers(init?.headers);
    assert.equal(init?.method, "GET");
    return buildEventStreamResponse();
  }) as typeof fetch;

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/projects/demo/dispatcher/feed/stream?limit=120"),
    { params: Promise.resolve({ id: "demo" }) },
  );

  assert.equal(
    seenUrl,
    "http://127.0.0.1:4749/api/projects/demo/dispatcher/feed/stream?limit=120",
  );
  assert.equal(seenHeaders.get("accept"), "text/event-stream");
  assert.equal(seenHeaders.get("cache-control"), "no-cache");
  assert.equal(seenHeaders.get("x-conductor-proxy-authorized"), "true");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(await response.text(), SSE_PAYLOAD);
});
