import assert from "node:assert/strict";
import test from "node:test";
import {
  isPairedBridgeScopePending,
  isPairedBridgeScopeReady,
  resolveSelectedBridgeId,
} from "./bridgeScope";

test("paired scope preserves the requested bridge while it reconnects", () => {
  assert.equal(resolveSelectedBridgeId({
    requiresPairedDeviceScope: true,
    requestedBridgeId: "bridge-demo",
    selectedBridgeId: "",
    connectedBridgeIds: [],
  }), "bridge-demo");
});

test("paired scope falls back to the first connected bridge when none is requested", () => {
  assert.equal(resolveSelectedBridgeId({
    requiresPairedDeviceScope: true,
    requestedBridgeId: null,
    selectedBridgeId: "",
    connectedBridgeIds: ["bridge-a", "bridge-b"],
  }), "bridge-a");
});

test("local scope clears disconnected bridge selections", () => {
  assert.equal(resolveSelectedBridgeId({
    requiresPairedDeviceScope: false,
    requestedBridgeId: null,
    selectedBridgeId: "bridge-demo",
    connectedBridgeIds: [],
  }), "");
});

test("paired scope stays pending until the selected bridge is connected", () => {
  assert.equal(isPairedBridgeScopePending({
    requiresPairedDeviceScope: true,
    effectiveBridgeId: "bridge-demo",
    connectedBridgeIds: [],
    bridgeInventoryStatus: "loading",
  }), true);

  assert.equal(isPairedBridgeScopePending({
    requiresPairedDeviceScope: true,
    effectiveBridgeId: "bridge-demo",
    connectedBridgeIds: ["bridge-other"],
    bridgeInventoryStatus: "ready",
  }), true);
});

test("paired scope becomes ready once the selected bridge is online", () => {
  assert.equal(isPairedBridgeScopeReady({
    requiresPairedDeviceScope: true,
    effectiveBridgeId: "bridge-demo",
    connectedBridgeIds: ["bridge-demo"],
    bridgeInventoryStatus: "ready",
  }), true);

  assert.equal(isPairedBridgeScopeReady({
    requiresPairedDeviceScope: true,
    effectiveBridgeId: "bridge-demo",
    connectedBridgeIds: ["bridge-demo"],
    bridgeInventoryStatus: "error",
  }), false);
});
