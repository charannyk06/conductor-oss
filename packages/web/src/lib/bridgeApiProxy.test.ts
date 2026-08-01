import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { proxyEventStreamToBridgeDevice, requestBridgePreview } from "./bridgeApiProxy";

test("bridge preview reads are cancelled by their absolute deadline", async () => {
  const previousRelayUrl = process.env.CONDUCTOR_BRIDGE_RELAY_URL;
  const intervals = new Set<NodeJS.Timeout>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":200,"body_base64":"');
    const interval = setInterval(() => response.write("YQ=="), 20);
    intervals.add(interval);
    response.once("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.CONDUCTOR_BRIDGE_RELAY_URL = `http://127.0.0.1:${address.port}`;
    await assert.rejects(
      requestBridgePreview(
        "device-1",
        { authorization: "Bearer test-token" },
        {
          sessionId: "session-1",
          method: "GET",
          url: "http://127.0.0.1:3000/",
        },
        { signal: AbortSignal.timeout(100) },
      ),
      /abort|time/i,
    );
  } finally {
    if (previousRelayUrl === undefined) {
      delete process.env.CONDUCTOR_BRIDGE_RELAY_URL;
    } else {
      process.env.CONDUCTOR_BRIDGE_RELAY_URL = previousRelayUrl;
    }
    for (const interval of intervals) clearInterval(interval);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("proxyEventStreamToBridgeDevice keeps bridge SSE bodies streaming instead of waiting for completion", async () => {
  const previousRelayUrl = process.env.CONDUCTOR_BRIDGE_RELAY_URL;
  const previousRelayJwtSecret = process.env.RELAY_JWT_SECRET;
  const originalFetch = global.fetch;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let requestBody: Record<string, unknown> | null = null;

  try {
    process.env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";
    process.env.RELAY_JWT_SECRET = "bridge-api-proxy-test-secret-at-least-32-bytes";
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

    const response = await proxyEventStreamToBridgeDevice(
      new Request("http://127.0.0.1:3000/api/projects/demo/dispatcher/feed/stream?limit=120", {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Content-Type": "text/event-stream",
          "Last-Event-ID": "evt-42",
          Forwarded: "for=198.51.100.10",
          "X-Forwarded-For": "198.51.100.11",
          "X-Real-IP": "198.51.100.12",
          "Proxy-Authorization": "Basic test",
          "Client-IP": "198.51.100.13",
        },
      }),
      "bridge-1",
      "/api/projects/demo/dispatcher/feed/stream",
    );

    if (!requestBody) {
      throw new Error("expected bridge proxy request body");
    }
    const bridgeRequest = requestBody as Record<string, unknown>;
    assert.equal(bridgeRequest.stream, true);
    assert.deepEqual(bridgeRequest.headers, {
      accept: "text/event-stream",
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      "last-event-id": "evt-42",
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("response should expose a readable body");
    }
    if (!streamController) {
      throw new Error("upstream stream controller should be captured");
    }
    const controller = streamController as ReadableStreamDefaultController<Uint8Array>;

    controller.enqueue(encoder.encode("data: chunk-1\n\n"));
    const first = await reader.read();
    assert.equal(decoder.decode(first.value), "data: chunk-1\n\n");

    let secondResolved = false;
    const secondRead = reader.read().then((value) => {
      secondResolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondResolved, false);

    controller.enqueue(encoder.encode("data: chunk-2\n\n"));
    controller.close();
    const second = await secondRead;
    assert.equal(decoder.decode(second.value), "data: chunk-2\n\n");
    const done = await reader.read();
    assert.equal(done.done, true);
  } finally {
    if (previousRelayUrl === undefined) {
      delete process.env.CONDUCTOR_BRIDGE_RELAY_URL;
    } else {
      process.env.CONDUCTOR_BRIDGE_RELAY_URL = previousRelayUrl;
    }
    if (previousRelayJwtSecret === undefined) {
      delete process.env.RELAY_JWT_SECRET;
    } else {
      process.env.RELAY_JWT_SECRET = previousRelayJwtSecret;
    }
    global.fetch = originalFetch;
  }
});
