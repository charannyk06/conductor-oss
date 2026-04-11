import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSessionTerminalComponent,
  SESSION_TERMINAL_IMPLEMENTATION,
  shouldUseRemoteSessionTerminal,
} from "./sessionTerminalRouting";

test("dashboard terminal contract is the native iframe terminal", () => {
  assert.equal(SESSION_TERMINAL_IMPLEMENTATION, "native-iframe");
});

test("loadSessionTerminalComponent resolves to a component", async () => {
  const SessionTerminal = await loadSessionTerminalComponent();
  assert.ok(
    typeof SessionTerminal === "function"
    || (typeof SessionTerminal === "object" && SessionTerminal !== null),
  );
});

test("bridge-scoped sessions keep the iframe-hosted terminal surface", () => {
  assert.equal(shouldUseRemoteSessionTerminal("bridge-mac"), false);
  assert.equal(shouldUseRemoteSessionTerminal("  bridge-mac  "), false);
});

test("local sessions also keep the iframe-hosted terminal surface", () => {
  assert.equal(shouldUseRemoteSessionTerminal(undefined), false);
  assert.equal(shouldUseRemoteSessionTerminal(null), false);
  assert.equal(shouldUseRemoteSessionTerminal(""), false);
  assert.equal(shouldUseRemoteSessionTerminal("   "), false);
});
