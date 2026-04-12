import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSessionTerminalComponent,
  SESSION_TERMINAL_IMPLEMENTATION,
  shouldUseRemoteSessionTerminal,
} from "./sessionTerminalRouting";

test("dashboard terminal contract is ttyd iframe (embeds e.g. Polyscope rely on this)", () => {
  assert.equal(SESSION_TERMINAL_IMPLEMENTATION, "ttyd-iframe");
});

test("loadSessionTerminalComponent resolves to a component", async () => {
  const SessionTerminal = await loadSessionTerminalComponent();
  // `memo()` wraps a function component; host may report typeof as "object".
  assert.ok(
    typeof SessionTerminal === "function"
    || (typeof SessionTerminal === "object" && SessionTerminal !== null),
  );
});

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
