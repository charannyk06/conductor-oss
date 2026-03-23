import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBridgeDevice, normalizeBridgeDevices } from "./bridgeDevices";

test("normalizeBridgeDevice coerces malformed bridge payloads into safe defaults", () => {
  const normalized = normalizeBridgeDevice({
    device_id: "device-123",
    device_name: "Mac",
    hostname: "macbook-pro",
    os: "darwin",
    arch: "arm64",
    connected: "yes",
    last_status: {
      hostname: null,
      os: undefined,
      connected: 1,
      version: " 0.3.4 ",
    },
  });

  assert.deepEqual(normalized, {
    device_id: "device-123",
    device_name: "Mac",
    hostname: "macbook-pro",
    os: "darwin",
    arch: "arm64",
    connected: false,
    last_status: {
      hostname: "macbook-pro",
      os: "darwin",
      connected: false,
      version: "0.3.4",
    },
  });
});

test("normalizeBridgeDevices ignores non-object entries and keeps valid booleans", () => {
  const normalized = normalizeBridgeDevices([
    null,
    "bad",
    {
      device_id: "device-1",
      hostname: "host-1",
      os: "darwin",
      arch: "arm64",
      connected: true,
      last_status: {
        hostname: "relay-host-1",
        os: "darwin",
        connected: true,
        version: "",
      },
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.device_id, "device-1");
  assert.equal(normalized[0]?.device_name, "host-1");
  assert.equal(normalized[0]?.connected, true);
  assert.equal(normalized[0]?.last_status?.hostname, "relay-host-1");
  assert.equal(normalized[0]?.last_status?.connected, true);
  assert.equal(normalized[0]?.last_status?.version, null);
});
