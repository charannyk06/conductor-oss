import assert from "node:assert/strict";
import test from "node:test";
import { requireWorkerApiKey } from "./config.js";

test("requireWorkerApiKey rejects missing and short keys", () => {
  assert.throws(() => requireWorkerApiKey(undefined), /must be configured/);
  assert.throws(() => requireWorkerApiKey("short-secret"), /at least 32 bytes/);
});

test("requireWorkerApiKey measures UTF-8 bytes and returns the trimmed key", () => {
  assert.equal(requireWorkerApiKey(`  ${"a".repeat(32)}  `), "a".repeat(32));
  assert.equal(requireWorkerApiKey("🔐".repeat(8)), "🔐".repeat(8));
});
