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
    amp: "default",
    claudeCode: "pro",
    codex: "chatgpt",
    cursorCli: "default",
    droid: "default",
    gemini: "oauth",
    githubCopilot: "default",
    opencode: "default",
    qwenCode: "oauth",
    ccr: "default",
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

  const copilotCatalog = getAgentModelCatalog("github-copilot");
  assert.ok(copilotCatalog);
  assert.deepEqual(
    copilotCatalog.accessOptions.map((option) => option.id),
    ["default"],
  );
});

test("core exposes stable fallback model and reasoning catalogs", () => {
  assert.deepEqual(
    getAvailableAgentModels("codex", { codex: "chatgpt" }).map((model) => model.id),
    [
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
    ],
  );
  assert.equal(getDefaultAgentModel("codex", { codex: "chatgpt" }), "gpt-5.4");
  assert.deepEqual(
    getAvailableAgentModels("claude-code", { claudeCode: "pro" }).map((model) => model.id),
    ["claude-sonnet-4-6", "claude-haiku-4-5"],
  );
  assert.deepEqual(
    getAvailableAgentModels("claude-code", { claudeCode: "max" }).map((model) => model.id),
    ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  );
  assert.deepEqual(
    getAvailableAgentReasoningEfforts("claude-code", { claudeCode: "max" }).map((option) => option.id),
    ["low", "medium", "high"],
  );
  assert.equal(getDefaultAgentReasoningEffort("claude-code", { claudeCode: "max" }), "high");
});

test("resolveAgentModelAccess uses the saved preference when valid", () => {
  assert.equal(resolveAgentModelAccess("codex", { codex: "api" }), "api");
  assert.equal(resolveAgentModelAccess("claude-code", { claudeCode: "max" }), "max");
  assert.equal(resolveAgentModelAccess("github-copilot", { githubCopilot: "default" }), "default");
});

test("unsupported agents fall back cleanly", () => {
  assert.equal(supportsAgentModelSelection("amp"), true);
  assert.equal(resolveAgentModelAccess("amp", null), "default");
  assert.equal(getAgentModelCatalog("amp")?.label, "Amp");
  assert.equal(supportsAgentModelSelection("custom-agent"), false);
  assert.equal(resolveAgentModelAccess("custom-agent", null), null);
  assert.equal(getAgentModelCatalog("custom-agent"), null);
});
