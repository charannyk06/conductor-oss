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
  assert.equal(
    buildBridgeInstallScriptUrl("https://preview.conductross.com", "windows"),
    "https://preview.conductross.com/bridge/install.ps1",
  );
});

test("buildBridgeInstallCommand produces a copy-pasteable shell pipeline", () => {
  assert.equal(
    buildBridgeInstallCommand("https://preview.conductross.com/bridge/install.sh"),
    "curl -fsSL https://preview.conductross.com/bridge/install.sh | sh",
  );
  assert.equal(
    buildBridgeInstallCommand("https://preview.conductross.com/bridge/install.ps1", "windows"),
    "& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://preview.conductross.com/bridge/install.ps1')))",
  );
});

test("buildBridgeBootstrapConnectCommand uses the hosted shell installer on unix-like platforms", () => {
  assert.equal(
    buildBridgeBootstrapConnectCommand(
      "https://preview.conductross.com/bridge/install.sh",
      "https://preview.conductross.com",
      "https://relay.conductross.com",
    ),
    "curl -fsSL https://preview.conductross.com/bridge/install.sh | sh -s -- --connect --dashboard-url https://preview.conductross.com --relay-url https://relay.conductross.com",
  );
});

test("buildBridgeBootstrapConnectCommand uses the hosted PowerShell installer on windows", () => {
  assert.equal(
    buildBridgeBootstrapConnectCommand(
      "https://preview.conductross.com/bridge/install.ps1",
      "https://preview.conductross.com",
      "https://relay.conductross.com",
      "windows",
    ),
    "& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://preview.conductross.com/bridge/install.ps1'))) -Connect -DashboardUrl 'https://preview.conductross.com' -RelayUrl 'https://relay.conductross.com'",
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

test("buildBridgeConnectCommand uses the installed bridge path on windows", () => {
  assert.equal(
    buildBridgeConnectCommand(
      "https://preview.conductross.com",
      "https://relay.conductross.com",
      "windows",
    ),
    "& (Join-Path $HOME '.conductor\\bin\\conductor-bridge.exe') connect --dashboard-url https://preview.conductross.com --relay-url https://relay.conductross.com",
  );
});

test("buildBridgeManualPairCommand includes relay arguments for both steps", () => {
  assert.equal(
    buildBridgeManualPairCommand("ABC123", "https://relay.conductross.com"),
    "conductor-bridge pair --code ABC123 --relay-url https://relay.conductross.com\nconductor-bridge daemon --relay-url https://relay.conductross.com",
  );
});

test("buildBridgeManualPairCommand uses the installed bridge path on windows", () => {
  assert.equal(
    buildBridgeManualPairCommand("ABC123", "https://relay.conductross.com", "windows"),
    "& (Join-Path $HOME '.conductor\\bin\\conductor-bridge.exe') pair --code ABC123 --relay-url https://relay.conductross.com\n& (Join-Path $HOME '.conductor\\bin\\conductor-bridge.exe') daemon --relay-url https://relay.conductross.com",
  );
});

test("buildBridgeRepairHref deep-links to the bridge setup flow for a device", () => {
  assert.equal(
    buildBridgeRepairHref("device 1"),
    "/bridge/connect?device=device%201#bridge-setup",
  );
});
