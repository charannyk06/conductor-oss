import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_RELAY_SECRET_REQUIRED_ERROR,
  BRIDGE_RELAY_URL_NOT_CONFIGURED_ERROR,
  isBridgeRelayConfigurationError,
} from "./bridgeRelayErrors";

test("isBridgeRelayConfigurationError matches bridge relay setup failures", () => {
  assert.equal(isBridgeRelayConfigurationError(BRIDGE_RELAY_URL_NOT_CONFIGURED_ERROR), true);
  assert.equal(isBridgeRelayConfigurationError(BRIDGE_RELAY_SECRET_REQUIRED_ERROR), true);
});

test("isBridgeRelayConfigurationError ignores runtime transport failures", () => {
  assert.equal(isBridgeRelayConfigurationError("Failed to reach bridge relay"), false);
  assert.equal(isBridgeRelayConfigurationError("connect ECONNREFUSED 127.0.0.1:8080"), false);
  assert.equal(isBridgeRelayConfigurationError(null), false);
});
