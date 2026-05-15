import assert from "node:assert/strict";
import test from "node:test";
import { bridgeStatusBadgeLabel } from "@/lib/bridgeStatusLabel";

test("bridge status label distinguishes local dashboard from bridge availability", () => {
  assert.equal(
    bridgeStatusBadgeLabel({ relayConfigured: false, connectedDevices: 0, totalDevices: 0, loading: false }),
    "Local backend",
  );
  assert.equal(
    bridgeStatusBadgeLabel({ relayConfigured: true, connectedDevices: 0, totalDevices: 0, loading: false }),
    "No bridge",
  );
  assert.equal(
    bridgeStatusBadgeLabel({ relayConfigured: true, connectedDevices: 0, totalDevices: 2, loading: false }),
    "Bridge offline",
  );
  assert.equal(
    bridgeStatusBadgeLabel({ relayConfigured: true, connectedDevices: 1, totalDevices: 2, loading: false }),
    "Online",
  );
});
