import assert from "node:assert/strict";
import test from "node:test";
import {
  getBuiltinRemoteAccessToken,
  isBuiltinRemoteAuthEnabled,
  isValidBuiltinAccessToken,
  verifyBuiltinRemoteSession,
} from "./remoteAuth";

test("public share-link remote auth is disabled", async () => {
  assert.equal(getBuiltinRemoteAccessToken(), null);
  assert.equal(isBuiltinRemoteAuthEnabled(), false);
  assert.equal(isValidBuiltinAccessToken("anything"), false);
  assert.equal(await verifyBuiltinRemoteSession("anything"), false);
});
