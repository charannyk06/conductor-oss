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

test("missing runtime catalogs fall back to static dropdown model choices", () => {
  const models = getSelectableAgentModels("codex", { codex: "chatgpt" }, {});
  assert.notEqual(models.length, 0);
  assert.equal(models[0]?.id, "gpt-5.4");
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

test("openclaw suppresses frontend model and reasoning selection", () => {
  const selection = buildModelSelection(
    "openclaw",
    {},
    {},
    "gpt-5.3-codex-spark",
    "high",
  );

  assert.deepEqual(selection, {
    catalogModel: "",
    customModel: "",
    reasoningEffort: "",
  });
  assert.deepEqual(getSelectableAgentModels("openclaw", {}, {}), []);
});

test("empty runtime catalogs suppress stale static and custom model choices", () => {
  const emptyCursorCatalog: RuntimeAgentModelCatalog = {
    agent: "cursor-cli",
    customModelPlaceholder: "auto",
    defaultModelByAccess: {},
    modelsByAccess: {},
  };

  assert.deepEqual(
    getSelectableAgentModels(
      "cursor-cli",
      { cursorCli: "default" },
      { "cursor-cli": emptyCursorCatalog },
    ),
    [],
  );

  const selection = buildModelSelection(
    "cursor-cli",
    { cursorCli: "default" },
    { "cursor-cli": emptyCursorCatalog },
    "gpt-5.3-codex",
    "high",
  );
  assert.deepEqual(selection, {
    catalogModel: "",
    customModel: "",
    reasoningEffort: "",
  });
});

test("buildModelSelection normalizes stale saved model and reasoning aliases", () => {
  const cursorCatalog: RuntimeAgentModelCatalog = {
    agent: "cursor-cli",
    customModelPlaceholder: "gpt-5",
    defaultModelByAccess: { default: "gpt-5" },
    modelsByAccess: {
      default: [
        {
          id: "gpt-5",
          label: "GPT-5",
          description: "Runtime Cursor model",
          access: ["default"],
        },
      ],
    },
  };
  const claudeCatalog: RuntimeAgentModelCatalog = {
    agent: "claude-code",
    customModelPlaceholder: "claude-sonnet-4-6",
    defaultModelByAccess: { pro: "claude-sonnet-4-6" },
    modelsByAccess: {
      pro: [
        {
          id: "claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          description: "Runtime Claude model",
          access: ["pro"],
        },
      ],
    },
    reasoningOptionsByAccess: {
      pro: [
        { id: "low", label: "Low", description: "Low" },
        { id: "medium", label: "Medium", description: "Medium" },
        { id: "high", label: "High", description: "High" },
        { id: "max", label: "Max", description: "Max" },
      ],
    },
    defaultReasoningByAccess: { pro: "high" },
  };

  assert.deepEqual(
    buildModelSelection(
      "cursor-cli",
      { cursorCli: "default" },
      { "cursor-cli": cursorCatalog },
      "gpt-5.3-codex",
      null,
    ),
    { catalogModel: "gpt-5", customModel: "", reasoningEffort: "" },
  );

  assert.deepEqual(
    buildModelSelection(
      "claude-code",
      { claudeCode: "pro" },
      { "claude-code": claudeCatalog },
      "sonnet",
      "xhigh",
    ),
    { catalogModel: "claude-sonnet-4-6", customModel: "", reasoningEffort: "max" },
  );
});
