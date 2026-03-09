import type { AgentModelAccess } from "@conductor-oss/core/types";
import type {
  RuntimeAgentModelContext,
  RuntimeAgentModelCatalog,
} from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  buildRuntimeModelContext,
  extractReasoningOptionsFromVariantKeys,
  formatGenericModelLabel,
  normalizeTokenLimit,
  pickRuntimeDefaultModel,
  pickRuntimeDefaultReasoning,
  readCommandOutput,
  toObject,
  uniqueModelOptions,
} from "./helpers";

function parseOpenCodeVerboseModels(output: string): Array<{ key: string; data: Record<string, unknown> }> {
  const lines = output.split(/\r?\n/);
  const entries: Array<{ key: string; data: Record<string, unknown> }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const key = lines[index]?.trim() ?? "";
    if (!key || !key.includes("/")) {
      continue;
    }

    let next = index + 1;
    while (next < lines.length && lines[next]?.trim().length === 0) {
      next += 1;
    }

    if (next >= lines.length || !(lines[next] ?? "").trim().startsWith("{")) {
      continue;
    }

    let buffer = "";
    let parsed: Record<string, unknown> | null = null;
    let end = next;

    while (end < lines.length) {
      buffer = buffer.length > 0 ? `${buffer}\n${lines[end]}` : (lines[end] ?? "");
      try {
        parsed = JSON.parse(buffer) as Record<string, unknown>;
        break;
      } catch {
        end += 1;
      }
    }

    if (!parsed) {
      continue;
    }

    entries.push({ key, data: parsed });
    index = end;
  }

  return entries;
}

export async function buildOpenCodeRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const output = await readCommandOutput(["opencode", "open-code", "open_code"], ["models", "--verbose"]);
  if (!output) {
    return null;
  }

  const verboseModels = parseOpenCodeVerboseModels(output);
  if (verboseModels.length === 0) {
    return null;
  }

  const reasoningOptionsByModel: Record<string, import("@conductor-oss/core/types").AgentReasoningOption[]> = {};
  const defaultReasoningByModel: Record<string, string> = {};
  const modelContextById: Record<string, RuntimeAgentModelContext> = {};
  const models = uniqueModelOptions(verboseModels.map(({ key, data }) => {
    const name = typeof data.name === "string" && data.name.trim().length > 0
      ? data.name.trim()
      : formatGenericModelLabel(key);
    const limit = toObject(data.limit);
    const context = normalizeTokenLimit(limit.context);
    const input = normalizeTokenLimit(limit.input);
    const outputTokens = normalizeTokenLimit(limit.output);
    const contextSuffix = context !== null
      ? ` Context: ${context.toLocaleString()} tokens.`
      : "";
    const description = `${name} available through the local OpenCode CLI (${key}).${contextSuffix}`;
    const contextDetails = buildRuntimeModelContext({
      maxTokens: context,
      inputMaxTokens: input,
      outputMaxTokens: outputTokens,
      source: "opencode_models_verbose",
      note: "Read from `opencode models --verbose`.",
    });
    if (contextDetails) {
      modelContextById[key] = contextDetails;
      const rawId = typeof data.id === "string" ? data.id.trim() : "";
      if (rawId && rawId !== key) {
        modelContextById[rawId] = contextDetails;
      }
    }

    const variantKeys = Object.keys(toObject(data.variants));
    const reasoningOptions = extractReasoningOptionsFromVariantKeys(
      variantKeys.map((variant) => variant.trim().toLowerCase()).filter(Boolean),
    );
    if (reasoningOptions.length > 0) {
      reasoningOptionsByModel[key] = reasoningOptions;
      defaultReasoningByModel[key] = pickRuntimeDefaultReasoning(
        reasoningOptions,
        reasoningOptions.some((option) => option.id === "medium") ? "medium" : null,
        reasoningOptions.some((option) => option.id === "high") ? "high" : reasoningOptions[0]?.id ?? null,
      ) ?? reasoningOptions[0]?.id ?? "";
    }

    return {
      id: key,
      label: name,
      description,
      access: ["default"] as AgentModelAccess[],
    };
  }));

  const defaultModel = pickRuntimeDefaultModel(models, [
    "openai/gpt-5.4",
    "openai/gpt-5.3-codex",
    "anthropic/claude-sonnet-4-6",
  ].find((candidate) => models.some((model) => model.id === candidate)) ?? null);

  return buildDefaultAccessRuntimeCatalog("opencode", models, {
    customModelPlaceholder: defaultModel ?? models[0]?.id ?? "",
    defaultModel,
    modelContextById,
    reasoningOptionsByModel,
    defaultReasoningByModel,
  });
}
