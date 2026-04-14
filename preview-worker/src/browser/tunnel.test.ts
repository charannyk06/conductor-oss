import assert from "node:assert/strict";
import test from "node:test";
import { PreviewWorkerError } from "../lib/types.js";
import { waitForReachableTunnelUrl } from "./tunnel.js";

test("waitForReachableTunnelUrl resolves after DNS and the tunnel probe both succeed", async () => {
  let dnsAttempts = 0;
  let probeAttempts = 0;

  await waitForReachableTunnelUrl(
    "https://preview.trycloudflare.com",
    2_000,
    async () => {
      dnsAttempts += 1;
      return [{ address: "104.21.1.1", family: 4 }];
    },
    async () => {
      probeAttempts += 1;
      if (probeAttempts < 3) {
        const error = new Error("fetch failed");
        (error as NodeJS.ErrnoException).code = "ENOTFOUND";
        throw error;
      }
    },
  );

  assert.equal(dnsAttempts, 3);
  assert.equal(probeAttempts, 3);
});

test("waitForReachableTunnelUrl throws a PreviewWorkerError when the tunnel probe never succeeds", async () => {
  let probeAttempts = 0;

  await assert.rejects(
    () => waitForReachableTunnelUrl(
      "https://preview.trycloudflare.com",
      10,
      async () => [{ address: "104.21.1.1", family: 4 }],
      async () => {
        probeAttempts += 1;
        throw new Error("fetch failed");
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof PreviewWorkerError);
      assert.equal(error.statusCode, 408);
      assert.match(error.message, /Timed out while waiting for a reachable cloudflared tunnel URL/);
      assert.ok(probeAttempts >= 1);
      return true;
    },
  );
});
