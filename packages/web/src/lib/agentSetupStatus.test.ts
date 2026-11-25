import assert from "node:assert/strict";
import { test } from "node:test";

import { agentModelAccessBadgeLabel, agentSetupStatusLabel, parseAgentAuthStatus } from "./agentSetupStatus";

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

test("agentSetupStatusLabel reports the detected sign-in", () => {
  const signedOut = parseAgentAuthStatus({ state: "signed_out", method: null, plan: null, loginCommand: "codex login" });
  assert.equal(signedOut?.loginCommand, "codex login");
  assert.equal(agentSetupStatusLabel({ installed: true, ready: false, configured: false, auth: signedOut }), "Sign-in needed");

  const subscription = parseAgentAuthStatus({ state: "signed_in", method: "subscription", plan: "max" });
  assert.equal(agentSetupStatusLabel({ installed: true, ready: true, auth: subscription }), "Subscription connected (max)");

  const apiKey = parseAgentAuthStatus({ state: "signed_in", method: "api_key" });
  assert.equal(agentSetupStatusLabel({ installed: true, ready: true, auth: apiKey }), "API key connected");

  const unknown = parseAgentAuthStatus({ state: "unknown" });
  assert.equal(agentSetupStatusLabel({ installed: true, ready: true, auth: unknown }), "CLI ready");
  assert.equal(parseAgentAuthStatus({ state: "bogus" }), null);
  assert.equal(parseAgentAuthStatus(null), null);
});
