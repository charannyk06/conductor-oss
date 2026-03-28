import assert from "node:assert/strict";
import test from "node:test";
import { proxyEventStreamToRust } from "./rustBackendProxy";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalFetch = global.fetch;

function restoreEnv(): void {
  if (originalBackendUrl === undefined) {
    delete process.env.CONDUCTOR_BACKEND_URL;
  } else {
    process.env.CONDUCTOR_BACKEND_URL = originalBackendUrl;
  }
}

test.afterEach(() => {
  restoreEnv();
  global.fetch = originalFetch;
});

test.after(() => {
  restoreEnv();
  global.fetch = originalFetch;
});

test("proxyEventStreamToRust keeps the upstream SSE body as a direct passthrough", async () => {
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";

  let seenUrl = "";
  let seenHeaders = new Headers();
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"append","entries":[]}\n\n'));
      controller.close();
    },
  });

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    seenHeaders = new Headers(init?.headers);
    return new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const response = await proxyEventStreamToRust(
    new Request("http://127.0.0.1:3000/api/projects/demo/dispatcher/feed/stream?limit=120"),
    "/api/projects/demo/dispatcher/feed/stream",
  );

  assert.equal(
    seenUrl,
    "http://127.0.0.1:4749/api/projects/demo/dispatcher/feed/stream?limit=120",
  );
  assert.equal(seenHeaders.get("accept"), "text/event-stream");
  assert.equal(seenHeaders.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.body, upstreamBody);
});
