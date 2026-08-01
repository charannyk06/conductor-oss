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

test("GET keeps the hosted bridge-backed dispatcher feed streaming before completion", async () => {
  resetEnv();
  process.env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";
  process.env.RELAY_JWT_SECRET = "dispatcher-feed-stream-route-test-secret-at-least-32-bytes";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let requestBody: Record<string, unknown> | null = null;

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    assert.equal(url, "https://relay.example.com/api/devices/bridge-1/proxy");
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }) as typeof fetch;

  const response = await GET(
    new NextRequest(
      "http://127.0.0.1:3000/api/projects/demo/dispatcher/feed/stream?limit=120&bridgeId=bridge-1",
      {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Last-Event-ID": "evt-7",
          Forwarded: "for=198.51.100.20",
          "X-Forwarded-For": "198.51.100.21",
          "X-Real-IP": "198.51.100.22",
          "Proxy-Authorization": "Basic test",
          "Client-IP": "198.51.100.23",
        },
      },
    ),
    { params: Promise.resolve({ id: "demo" }) },
  );

  if (!requestBody) {
    throw new Error("expected bridge proxy request body");
  }
  const bridgeRequest = requestBody as Record<string, unknown>;
  assert.equal(bridgeRequest.stream, true);
  assert.equal(bridgeRequest.method, "GET");
  assert.equal(
    bridgeRequest.path,
    "/api/projects/demo/dispatcher/feed/stream?limit=120&bridgeId=bridge-1",
  );
  assert.deepEqual(bridgeRequest.headers, {
    accept: "text/event-stream",
    "cache-control": "no-cache",
    "last-event-id": "evt-7",
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("streaming route should expose a readable body");
  }
  if (!streamController) {
    throw new Error("upstream bridge stream controller should be available");
  }
  const controller = streamController as ReadableStreamDefaultController<Uint8Array>;

  controller.enqueue(encoder.encode('data: {"type":"append","entries":["first"]}\n\n'));
  const first = await reader.read();
  assert.equal(
    decoder.decode(first.value),
    'data: {"type":"append","entries":["first"]}\n\n',
  );

  let secondResolved = false;
  const secondRead = reader.read().then((value) => {
    secondResolved = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondResolved, false);

  controller.enqueue(encoder.encode('data: {"type":"append","entries":["second"]}\n\n'));
  controller.close();
  const second = await secondRead;
  assert.equal(
    decoder.decode(second.value),
    'data: {"type":"append","entries":["second"]}\n\n',
  );
  const done = await reader.read();
  assert.equal(done.done, true);
});
