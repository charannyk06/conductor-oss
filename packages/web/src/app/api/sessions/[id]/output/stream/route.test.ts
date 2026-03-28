import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalBridgeRelayUrl = process.env.CONDUCTOR_BRIDGE_RELAY_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalRelayJwtSecret = process.env.RELAY_JWT_SECRET;
const originalFetch = global.fetch;

const SSE_PAYLOAD = 'data: {"type":"delta","line":"hello"}\n\n';

function resetEnv(): void {
  process.env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";
  process.env.CO_CONFIG_PATH = "/tmp/conductor-output-stream-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
  process.env.RELAY_JWT_SECRET = "output-stream-route-test-secret";
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

test("GET proxies bridge-backed output streams with streaming-safe headers", async () => {
  resetEnv();

  let seenPath = "";

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    assert.equal(url, "https://relay.example.com/api/devices/bridge-1/proxy");
    assert.equal(init?.method, "POST");

    const headers = new Headers(init?.headers);
    assert.match(headers.get("authorization") ?? "", /^Bearer\s.+/);
    assert.match(headers.get("x-forwarded-host") ?? "", /^(?:127\\.0\\.0\\.1|localhost):3000$/);
    assert.equal(headers.get("x-forwarded-proto"), "http");

    const body = JSON.parse(String(init?.body)) as {
      method: string;
      path: string;
    };
    assert.equal(body.method, "GET");
    seenPath = body.path;
    return buildEventStreamResponse();
  }) as typeof fetch;

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/sessions/bridge%3Abridge-1%3Asession-1/output/stream?lines=80"),
    { params: Promise.resolve({ id: "bridge:bridge-1:session-1" }) },
  );

  assert.equal(seenPath, "/api/sessions/session-1/output/stream?lines=80");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(await response.text(), SSE_PAYLOAD);
});
