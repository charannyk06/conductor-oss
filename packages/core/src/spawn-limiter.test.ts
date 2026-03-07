import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSpawnLimiter } from "./spawn-limiter.js";

describe("spawn-limiter", () => {
  it("allows spawns within limits", async () => {
    const limiter = createSpawnLimiter({ globalMax: 2, perProjectMax: 1 });

    await limiter.acquire("proj-a");
    await limiter.acquire("proj-b");

    const metrics = limiter.metrics();
    assert.equal(metrics.globalActive, 2);
    assert.equal(metrics.totalSpawned, 2);

    limiter.release("proj-a");
    limiter.release("proj-b");

    const after = limiter.metrics();
    assert.equal(after.globalActive, 0);
  });

  it("queues when global limit reached", async () => {
    const limiter = createSpawnLimiter({ globalMax: 1, perProjectMax: 1, queueTimeoutMs: 500 });

    await limiter.acquire("proj-a");

    let resolved = false;
    const queued = limiter.acquire("proj-b").then(() => { resolved = true; });

    // Should be queued
    assert.equal(limiter.metrics().queueLength, 1);
    assert.equal(resolved, false);

    limiter.release("proj-a");
    await queued;
    assert.equal(resolved, true);
    assert.equal(limiter.metrics().queueLength, 0);

    limiter.release("proj-b");
  });

  it("queues when per-project limit reached", async () => {
    const limiter = createSpawnLimiter({ globalMax: 5, perProjectMax: 1, queueTimeoutMs: 500 });

    await limiter.acquire("proj-a");

    let resolved = false;
    const queued = limiter.acquire("proj-a").then(() => { resolved = true; });

    assert.equal(limiter.metrics().queueLength, 1);
    assert.equal(resolved, false);

    limiter.release("proj-a");
    await queued;
    assert.equal(resolved, true);

    limiter.release("proj-a");
  });

  it("times out queued spawns", async () => {
    const limiter = createSpawnLimiter({ globalMax: 1, perProjectMax: 1, queueTimeoutMs: 50 });

    await limiter.acquire("proj-a");

    await assert.rejects(
      () => limiter.acquire("proj-b"),
      (err: Error) => {
        assert.ok(err.message.includes("Spawn queue timeout"));
        return true;
      },
    );

    assert.equal(limiter.metrics().totalTimedOut, 1);
    limiter.release("proj-a");
  });

  it("shutdown rejects all pending", async () => {
    const limiter = createSpawnLimiter({ globalMax: 1, perProjectMax: 1, queueTimeoutMs: 60000 });

    await limiter.acquire("proj-a");
    const pending = limiter.acquire("proj-b");

    limiter.shutdown();

    await assert.rejects(
      () => pending,
      (err: Error) => {
        assert.ok(err.message.includes("shutting down"));
        return true;
      },
    );
  });
});
