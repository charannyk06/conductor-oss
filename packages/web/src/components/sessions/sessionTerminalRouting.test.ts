import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseRemoteSessionTerminal } from "./sessionTerminalRouting";

test("bridge-scoped sessions use the remote relay terminal path", () => {
  assert.equal(shouldUseRemoteSessionTerminal("bridge-mac"), true);
  assert.equal(shouldUseRemoteSessionTerminal("  bridge-mac  "), true);
});

test("local sessions keep the direct ttyd iframe path", () => {
  assert.equal(shouldUseRemoteSessionTerminal(undefined), false);
  assert.equal(shouldUseRemoteSessionTerminal(null), false);
  assert.equal(shouldUseRemoteSessionTerminal(""), false);
  assert.equal(shouldUseRemoteSessionTerminal("   "), false);
});
