import assert from "node:assert/strict";
import test from "node:test";
import { PreviewWorkerError } from "../lib/types.js";
import { waitForReachableTunnelUrl } from "./tunnel.js";

test("waitForReachableTunnelUrl resolves after DNS starts answering", async () => {
  let attempts = 0;

  await waitForReachableTunnelUrl(
    "https://preview.trycloudflare.com",
    2_000,
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("getaddrinfo ENOTFOUND preview.trycloudflare.com");
        (error as NodeJS.ErrnoException).code = "ENOTFOUND";
        throw error;
      }
      return [{ address: "104.21.1.1", family: 4 }];
    },
  );

  assert.equal(attempts, 3);
});

test("waitForReachableTunnelUrl throws a PreviewWorkerError when DNS never resolves", async () => {
  await assert.rejects(
    () => waitForReachableTunnelUrl(
      "https://preview.trycloudflare.com",
      10,
      async () => {
        const error = new Error("getaddrinfo ENOTFOUND preview.trycloudflare.com");
        (error as NodeJS.ErrnoException).code = "ENOTFOUND";
        throw error;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof PreviewWorkerError);
      assert.equal(error.statusCode, 408);
      assert.match(error.message, /Timed out while waiting for a reachable cloudflared tunnel URL/);
      return true;
    },
  );
});
