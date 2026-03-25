import assert from "node:assert/strict";
import test from "node:test";
import { buildModelSelection, getSelectableAgentModels } from "./agentModelSelection";
import type { RuntimeAgentModelCatalog } from "./runtimeAgentModelsShared";

const CODEX_RUNTIME_CATALOG: RuntimeAgentModelCatalog = {
  agent: "codex",
  customModelPlaceholder: "gpt-5.4-mini",
  defaultModelByAccess: {
    chatgpt: "gpt-5.4-mini",
    api: "gpt-5.4-mini",
  },
  modelsByAccess: {
    chatgpt: [
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4-Mini",
        description: "Runtime model",
        access: ["chatgpt", "api"],
      },
    ],
    api: [
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4-Mini",
        description: "Runtime model",
        access: ["chatgpt", "api"],
      },
    ],
  },
  reasoningOptionsByModel: {
    "gpt-5.4-mini": [
      {
        id: "medium",
        label: "Medium",
        description: "Balanced speed and reasoning depth.",
      },
      {
        id: "high",
        label: "High",
        description: "Deeper reasoning.",
      },
    ],
  },
  defaultReasoningByModel: {
    "gpt-5.4-mini": "high",
  },
};

test("runtime-discovered models suppress stale static fallback choices", () => {
  const models = getSelectableAgentModels("codex", { codex: "chatgpt" }, { codex: CODEX_RUNTIME_CATALOG });
  assert.deepEqual(models.map((model) => model.id), ["gpt-5.4-mini"]);
});

test("missing runtime catalogs do not invent dropdown model choices", () => {
  const models = getSelectableAgentModels("codex", { codex: "chatgpt" }, {});
  assert.deepEqual(models, []);
});

test("buildModelSelection drops stale saved model overrides when runtime models disagree", () => {
  const selection = buildModelSelection(
    "codex",
    { codex: "chatgpt" },
    { codex: CODEX_RUNTIME_CATALOG },
    "gpt-5.1-codex-max",
    "xhigh",
  );

  assert.equal(selection.catalogModel, "gpt-5.4-mini");
  assert.equal(selection.customModel, "");
  assert.equal(selection.reasoningEffort, "high");
});

test("buildModelSelection preserves explicit custom model but drops unverifiable reasoning", () => {
  const selection = buildModelSelection(
    "opencode",
    { opencode: "default" },
    {},
    "openai/gpt-5.4",
    "max",
  );

  assert.equal(selection.catalogModel, "");
  assert.equal(selection.customModel, "openai/gpt-5.4");
  assert.equal(selection.reasoningEffort, "");
});
