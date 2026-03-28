import assert from "node:assert/strict";
import test from "node:test";
import { decodeBridgeSessionId, encodeBridgeSessionId, getDisplaySessionId } from "./bridgeSessionIds";

test("encodeBridgeSessionId prefixes bridge-scoped session ids", () => {
  assert.equal(
    encodeBridgeSessionId("bridge-123", "session-456"),
    "bridge:bridge-123:session-456",
  );
});

test("decodeBridgeSessionId extracts bridge and session ids", () => {
  assert.deepEqual(
    decodeBridgeSessionId("bridge:bridge-123:session-456"),
    { bridgeId: "bridge-123", sessionId: "session-456" },
  );
});

test("getDisplaySessionId strips bridge transport prefixes from paired-device session ids", () => {
  assert.equal(
    getDisplaySessionId("bridge:bridge-123:session-456"),
    "session-456",
  );
});

test("getDisplaySessionId leaves local session ids unchanged", () => {
  assert.equal(getDisplaySessionId("session-456"), "session-456");
});
