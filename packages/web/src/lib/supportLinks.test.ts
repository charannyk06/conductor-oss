import assert from "node:assert/strict";
import test from "node:test";
import {
  CONDUCTOR_APP_URL,
  CONDUCTOR_ISSUES_URL,
  CONDUCTOR_SUPPORT_DISCUSSIONS_URL,
  getRemoteAccessSupportMessage,
} from "./supportLinks";

test("support links point to live conductor support surfaces", () => {
  assert.equal(CONDUCTOR_APP_URL, "https://app.conductross.com");
  assert.equal(CONDUCTOR_SUPPORT_DISCUSSIONS_URL, "https://github.com/charannyk06/conductor-oss/discussions");
  assert.equal(CONDUCTOR_ISSUES_URL, "https://github.com/charannyk06/conductor-oss/issues");
});

test("getRemoteAccessSupportMessage explains why raw port forwarding is blocked", () => {
  const message = getRemoteAccessSupportMessage("unavailable");

  assert.ok(message);
  assert.match(message, /port forwarding/i);
  assert.match(message, /remote access/i);
  assert.match(message, /app\.conductross\.com/i);
  assert.match(message, /Cloudflare Access or Clerk/i);
});

test("getRemoteAccessSupportMessage only adds extra guidance for unavailable access paths", () => {
  assert.equal(getRemoteAccessSupportMessage("invalid"), null);
  assert.equal(getRemoteAccessSupportMessage(undefined), null);
});
