import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestBridgePreview } from "./bridgeApiProxy";

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
