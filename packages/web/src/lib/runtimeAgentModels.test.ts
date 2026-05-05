import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexRuntimeModelCatalog, parsePiListModelsOutput } from "./runtimeAgentModels";
import { parseGeminiRuntimeModelCatalog } from "./runtimeAgentModels/gemini";

test("parsePiListModelsOutput reads Pi provider model rows", () => {
  const rows = parsePiListModelsOutput(`provider  model      context  max-out  thinking  images
openai    gpt-5.4    272K     128K     yes       yes
openai    gpt-4o     128K     16.4K    no        yes`);

  assert.deepEqual(rows, [
    {
      provider: "openai",
      model: "gpt-5.4",
      context: "272K",
      maxOutput: "128K",
      thinking: true,
      images: true,
    },
    {
      provider: "openai",
      model: "gpt-4o",
      context: "128K",
      maxOutput: "16.4K",
      thinking: false,
      images: true,
    },
  ]);
});

test("parseCodexRuntimeModelCatalog keeps visible Codex models in priority order", () => {
  const catalog = parseCodexRuntimeModelCatalog({
    models: [
      {
        slug: "gpt-5.2-codex",
        display_name: "gpt-5.2-codex",
        description: "Older coding model",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced speed and depth" },
        ],
        visibility: "list",
        supported_in_api: true,
        priority: 3,
      },
      {
        slug: "gpt-5.4",
        display_name: "gpt-5.4",
        description: "Latest frontier agentic coding model.",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced speed and depth" },
          { effort: "high", description: "Deeper reasoning" },
          { effort: "xhigh", description: "Maximum depth" },
        ],
        visibility: "list",
        supported_in_api: true,
        priority: 0,
      },
      {
        slug: "gpt-5.4-mini",
        display_name: "GPT-5.4-Mini",
        description: "Smaller GPT-5.4 variant.",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced speed and depth" },
          { effort: "high", description: "Deeper reasoning" },
          { effort: "xhigh", description: "Maximum depth" },
        ],
        visibility: "list",
        supported_in_api: true,
        priority: 2,
      },
      {
        slug: "gpt-5.3-codex-spark",
        display_name: "GPT-5.3-Codex-Spark",
        description: "Ultra-fast coding model.",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced speed and depth" },
          { effort: "high", description: "Deeper reasoning" },
        ],
        visibility: "list",
        supported_in_api: false,
        priority: 2,
      },
      {
        slug: "gpt-5.2",
        display_name: "gpt-5.2",
        description: "Previous frontier model for professional work.",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balanced speed and depth" },
          { effort: "high", description: "Deeper reasoning" },
          { effort: "xhigh", description: "Maximum depth" },
        ],
        visibility: "list",
        supported_in_api: true,
        priority: 9,
      },
      {
        slug: "gpt-5.1-codex",
        display_name: "gpt-5.1-codex",
        description: "Hidden legacy model",
        visibility: "hide",
        supported_in_api: true,
        priority: 8,
      },
    ],
  }, "gpt-5.4");

  assert.ok(catalog);
  assert.deepEqual(
    catalog.modelsByAccess.chatgpt?.map((model) => model.id),
    ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.2-codex", "gpt-5.2"],
  );
  assert.deepEqual(
    catalog.modelsByAccess.api?.map((model) => model.id),
    ["gpt-5.4", "gpt-5.4-mini", "gpt-5.2-codex", "gpt-5.2"],
  );
  assert.equal(catalog.defaultModelByAccess.chatgpt, "gpt-5.4");
  assert.equal(catalog.defaultModelByAccess.api, "gpt-5.4");
  assert.equal(catalog.defaultReasoningByAccess?.chatgpt, "high");
  assert.equal(catalog.defaultReasoningByAccess?.api, "high");
  assert.deepEqual(
    catalog.reasoningOptionsByModel?.["gpt-5.4"]?.map((option) => option.id),
    ["low", "medium", "high", "xhigh"],
  );
});

test("parseGeminiRuntimeModelCatalog remaps stale Gemini 3.1 Flash history to the live CLI model", () => {
  const catalog = parseGeminiRuntimeModelCatalog([
    "gemini-3.1-flash-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
  ]);

  assert.ok(catalog);
  assert.deepEqual(
    catalog.modelsByAccess.oauth?.map((model) => model.id),
    ["gemini-3-flash-preview", "gemini-3.1-pro-preview"],
  );
  assert.equal(catalog.defaultModelByAccess.oauth, "gemini-3-flash-preview");
  assert.equal(catalog.defaultModelByAccess.api, "gemini-3-flash-preview");
});
