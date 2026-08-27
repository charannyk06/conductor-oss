import assert from "node:assert/strict";
import test from "node:test";
import { createInitialDemoState, demoStateReducer } from "./demoState";

test("demo reducer focuses a synthetic session", () => {
  const initial = createInitialDemoState();
  const next = demoStateReducer(initial, {
    type: "focus-session",
    sessionId: "demo-session-176",
    timestamp: "2026-08-25T14:00:00.000Z",
  });

  assert.equal(next.selectedSessionId, "demo-session-176");
  assert.match(next.timeline[0]?.label ?? "", /Focused synthetic session demo-session-176/i);
});

test("demo reducer queues a new synthetic session and selects it", () => {
  const initial = createInitialDemoState();
  const next = demoStateReducer(initial, {
    type: "start-agent",
    timestamp: "2026-08-25T14:05:00.000Z",
    projectId: "demo-docs",
    prompt: "Draft the public walkthrough.",
    agent: "codex",
  });

  assert.equal(next.sessions[0]?.projectId, "demo-docs");
  assert.equal(next.sessions[0]?.status, "queued");
  assert.equal(next.selectedSessionId, next.sessions[0]?.id);
  assert.equal(next.nextSyntheticSessionNumber, initial.nextSyntheticSessionNumber + 1);
});

test("demo reducer sends feedback and returns the session to working", () => {
  const initial = createInitialDemoState();
  const next = demoStateReducer(initial, {
    type: "send-feedback",
    timestamp: "2026-08-25T14:08:00.000Z",
    sessionId: "demo-session-198",
    feedback: "Make the approval boundary explicit.",
  });

  const updated = next.sessions.find((session) => session.id === "demo-session-198");
  assert.equal(updated?.status, "working");
  assert.equal(updated?.lastFeedback, "Make the approval boundary explicit.");
  assert.equal(next.selectedSessionId, "demo-session-198");
});
