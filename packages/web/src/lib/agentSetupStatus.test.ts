import assert from "node:assert/strict";
import { test } from "node:test";

import { agentModelAccessBadgeLabel, agentSetupStatusLabel } from "./agentSetupStatus";

test("agentSetupStatusLabel separates CLI readiness from auth and install state", () => {
  assert.equal(agentSetupStatusLabel(null), "Install needed");
  assert.equal(agentSetupStatusLabel({ checking: true, installed: false, ready: false, configured: false }), "Checking install");
  assert.equal(agentSetupStatusLabel({ installed: false, ready: false, configured: false }), "Install needed");
  assert.equal(agentSetupStatusLabel({ installed: true, ready: false, configured: false }), "Auth needed");
  assert.equal(agentSetupStatusLabel({ installed: true, ready: false, configured: true }), "Setup needed");
  assert.equal(agentSetupStatusLabel({ installed: true, ready: true, configured: false }), "CLI ready");
});

test("agentModelAccessBadgeLabel makes account requirements explicit", () => {
  assert.equal(agentModelAccessBadgeLabel("Google Login"), "Access: Google Login");
  assert.equal(agentModelAccessBadgeLabel("  ChatGPT Plan  "), "Access: ChatGPT Plan");
  assert.equal(agentModelAccessBadgeLabel(null), null);
  assert.equal(agentModelAccessBadgeLabel(""), null);
});
