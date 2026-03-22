import assert from "node:assert/strict";
import test from "node:test";
import { resolveBridgeIdFromLocation, withBridgeQuery } from "./bridgeQuery";

test("withBridgeQuery appends bridgeId while preserving existing params", () => {
  assert.equal(
    withBridgeQuery("/api/notifications?limit=20", "bridge-123"),
    "/api/notifications?limit=20&bridgeId=bridge-123",
  );
});

test("resolveBridgeIdFromLocation prefers explicit bridge query params", () => {
  assert.equal(
    resolveBridgeIdFromLocation("https://app.conductross.com/?bridge=bridge-123"),
    "bridge-123",
  );
  assert.equal(
    resolveBridgeIdFromLocation("https://app.conductross.com/?bridgeId=bridge-456"),
    "bridge-456",
  );
});

test("resolveBridgeIdFromLocation falls back to the selected bridge session in the query string", () => {
  assert.equal(
    resolveBridgeIdFromLocation("https://app.conductross.com/?session=bridge%3Abridge-123%3Asession-456"),
    "bridge-123",
  );
});

test("resolveBridgeIdFromLocation falls back to the session route path", () => {
  assert.equal(
    resolveBridgeIdFromLocation("https://app.conductross.com/sessions/bridge%3Abridge-789%3Asession-456"),
    "bridge-789",
  );
});
