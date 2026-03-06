import assert from "node:assert/strict";
import test from "node:test";
import {
  getAvailableAgentModels,
  getDefaultAgentModel,
  getDefaultModelAccessPreferences,
  resolveAgentModelAccess,
  supportsAgentModelSelection,
} from "../types.js";

test("defaults expose model access preferences for supported agents", () => {
  assert.deepEqual(getDefaultModelAccessPreferences(), {
    claudeCode: "pro",
    codex: "chatgpt",
    gemini: "oauth",
    qwenCode: "oauth",
  });
});

test("anthropic Pro access only exposes Sonnet models", () => {
  const models = getAvailableAgentModels("claude-code", {
    claudeCode: "pro",
  }).map((model) => model.id);

  assert.deepEqual(models, [
    "claude-sonnet-4-5",
    "claude-sonnet-4-0",
  ]);
  assert.equal(getDefaultAgentModel("claude-code", { claudeCode: "pro" }), "claude-sonnet-4-5");
});

test("anthropic Max access unlocks Opus models", () => {
  const models = getAvailableAgentModels("claude-code", {
    claudeCode: "max",
  }).map((model) => model.id);

  assert.deepEqual(models, [
    "claude-sonnet-4-5",
    "claude-sonnet-4-0",
    "claude-opus-4-1",
    "claude-opus-4-0",
  ]);
  assert.equal(getDefaultAgentModel("claude-code", { claudeCode: "max" }), "claude-opus-4-1");
});

test("codex access differentiates chatgpt and api model lists", () => {
  const chatgptModels = getAvailableAgentModels("codex", {
    codex: "chatgpt",
  }).map((model) => model.id);
  const apiModels = getAvailableAgentModels("codex", {
    codex: "api",
  }).map((model) => model.id);

  assert.deepEqual(chatgptModels, [
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ]);
  assert.deepEqual(apiModels, [
    "gpt-5.2-codex",
    "gpt-5.1-codex",
  ]);
});

test("unsupported agents fall back cleanly", () => {
  assert.equal(supportsAgentModelSelection("amp"), false);
  assert.equal(resolveAgentModelAccess("amp", null), null);
  assert.deepEqual(getAvailableAgentModels("amp", null), []);
  assert.equal(getDefaultAgentModel("amp", null), null);
});
