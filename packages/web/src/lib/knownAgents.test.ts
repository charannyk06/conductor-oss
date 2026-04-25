import assert from "node:assert/strict";
import test from "node:test";
import {
  filterTerminalAgentNames,
  resolveTerminalAgent,
  supportsTerminalSessions,
} from "@/lib/knownAgents";

test("openclaw is dispatcher-only", () => {
  assert.equal(supportsTerminalSessions("openclaw"), false);
  assert.equal(supportsTerminalSessions("claude-code"), true);
  assert.equal(supportsTerminalSessions("pi"), true);
});

test("filterTerminalAgentNames removes dispatcher-only agents", () => {
  assert.deepEqual(filterTerminalAgentNames(["claude-code", "openclaw", "codex"]), [
    "claude-code",
    "codex",
  ]);
});

test("resolveTerminalAgent falls back when the current agent is dispatcher-only", () => {
  assert.equal(resolveTerminalAgent("openclaw", "claude-code"), "claude-code");
});
