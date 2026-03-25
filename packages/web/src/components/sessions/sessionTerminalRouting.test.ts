import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseRemoteSessionTerminal } from "./sessionTerminalRouting";

test("bridge-scoped sessions keep using the ttyd terminal surface", () => {
  assert.equal(shouldUseRemoteSessionTerminal("bridge-mac"), false);
  assert.equal(shouldUseRemoteSessionTerminal("  bridge-mac  "), false);
});

test("local sessions also keep the direct ttyd iframe path", () => {
  assert.equal(shouldUseRemoteSessionTerminal(undefined), false);
  assert.equal(shouldUseRemoteSessionTerminal(null), false);
  assert.equal(shouldUseRemoteSessionTerminal(""), false);
  assert.equal(shouldUseRemoteSessionTerminal("   "), false);
});
