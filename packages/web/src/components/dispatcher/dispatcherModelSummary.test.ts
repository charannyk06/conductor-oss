import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDispatcherRuntimeSummary,
  formatDispatcherReasoningLabel,
} from "./dispatcherModelSummary";

test("formatDispatcherReasoningLabel normalizes common reasoning levels", () => {
  assert.equal(formatDispatcherReasoningLabel("low"), "Low");
  assert.equal(formatDispatcherReasoningLabel("xhigh"), "Max");
  assert.equal(formatDispatcherReasoningLabel(""), null);
});

test("buildDispatcherRuntimeSummary composes the runtime chip label", () => {
  assert.equal(
    buildDispatcherRuntimeSummary({
      agent: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
    }),
    "Codex · GPT-5.4 · High",
  );
});

test("buildDispatcherRuntimeSummary omits missing model and reasoning segments", () => {
  assert.equal(
    buildDispatcherRuntimeSummary({
      agent: "claude-code",
      model: "",
      reasoningEffort: "",
    }),
    "Claude Code",
  );
});
