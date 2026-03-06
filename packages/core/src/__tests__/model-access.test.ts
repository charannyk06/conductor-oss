import assert from "node:assert/strict";
import test from "node:test";
import {
  getAgentModelCatalog,
  getAvailableAgentModels,
  getAvailableAgentReasoningEfforts,
  getDefaultAgentModel,
  getDefaultAgentReasoningEffort,
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

test("agent catalogs only expose access metadata", () => {
  const codexCatalog = getAgentModelCatalog("codex");
  assert.ok(codexCatalog);
  assert.equal(codexCatalog.label, "Codex");
  assert.deepEqual(
    codexCatalog.accessOptions.map((option) => option.id),
    ["chatgpt", "api"],
  );

  const claudeCatalog = getAgentModelCatalog("claude-code");
  assert.ok(claudeCatalog);
  assert.deepEqual(
    claudeCatalog.accessOptions.map((option) => option.id),
    ["pro", "max", "api"],
  );
});

test("core no longer exposes hardcoded model or reasoning lists", () => {
  assert.deepEqual(getAvailableAgentModels("codex", { codex: "chatgpt" }), []);
  assert.equal(getDefaultAgentModel("codex", { codex: "chatgpt" }), null);
  assert.deepEqual(getAvailableAgentReasoningEfforts("claude-code", { claudeCode: "max" }), []);
  assert.equal(getDefaultAgentReasoningEffort("claude-code", { claudeCode: "max" }), null);
});

test("resolveAgentModelAccess uses the saved preference when valid", () => {
  assert.equal(resolveAgentModelAccess("codex", { codex: "api" }), "api");
  assert.equal(resolveAgentModelAccess("claude-code", { claudeCode: "max" }), "max");
});

test("unsupported agents fall back cleanly", () => {
  assert.equal(supportsAgentModelSelection("amp"), false);
  assert.equal(resolveAgentModelAccess("amp", null), null);
  assert.equal(getAgentModelCatalog("amp"), null);
});
