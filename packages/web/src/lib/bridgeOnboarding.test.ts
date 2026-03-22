import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBridgeConnectCommand,
  buildBridgeInstallCommand,
  buildBridgeInstallScriptUrl,
  buildBridgeManualPairCommand,
} from "./bridgeOnboarding";

test("buildBridgeInstallScriptUrl resolves against the current dashboard origin", () => {
  assert.equal(
    buildBridgeInstallScriptUrl("https://preview.conductross.com"),
    "https://preview.conductross.com/bridge/install.sh",
  );
});

test("buildBridgeInstallCommand produces a copy-pasteable shell pipeline", () => {
  assert.equal(
    buildBridgeInstallCommand("https://preview.conductross.com/bridge/install.sh"),
    'curl -fsSL https://preview.conductross.com/bridge/install.sh | sh && export PATH="$HOME/.local/bin:$PATH"',
  );
});

test("buildBridgeConnectCommand includes dashboard and relay arguments", () => {
  assert.equal(
    buildBridgeConnectCommand(
      "https://preview.conductross.com",
      "https://relay.conductross.com",
    ),
    "conductor-bridge connect --dashboard-url https://preview.conductross.com --relay-url https://relay.conductross.com",
  );
});

test("buildBridgeManualPairCommand includes relay arguments for both steps", () => {
  assert.equal(
    buildBridgeManualPairCommand("ABC123", "https://relay.conductross.com"),
    "conductor-bridge pair --code ABC123 --relay-url https://relay.conductross.com\nconductor-bridge daemon --relay-url https://relay.conductross.com",
  );
});
