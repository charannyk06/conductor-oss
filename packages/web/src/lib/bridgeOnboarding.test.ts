import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBridgeBootstrapConnectCommand,
  buildBridgeConnectCommand,
  buildBridgeInstallCommand,
  buildBridgeInstallScriptUrl,
  buildBridgeManualPairCommand,
  buildBridgeRepairHref,
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
    "curl -fsSL https://preview.conductross.com/bridge/install.sh | sh",
  );
});

test("buildBridgeBootstrapConnectCommand uses the cross-platform npx entrypoint", () => {
  assert.equal(
    buildBridgeBootstrapConnectCommand(
      "https://preview.conductross.com/bridge/install.sh",
      "https://preview.conductross.com",
      "https://relay.conductross.com",
    ),
    "npx --yes conductor-oss@latest bridge setup --dashboard-url https://preview.conductross.com --relay-url https://relay.conductross.com",
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

test("buildBridgeRepairHref deep-links to the bridge setup flow for a device", () => {
  assert.equal(
    buildBridgeRepairHref("device 1"),
    "/bridge/connect?device=device%201#bridge-setup",
  );
});
