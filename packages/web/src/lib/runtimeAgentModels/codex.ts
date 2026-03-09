import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentModelAccess,
  AgentModelOption,
  AgentReasoningOption,
} from "@conductor-oss/core/types";
import type {
  RuntimeAgentModelContext,
  RuntimeAgentModelCatalog,
} from "../runtimeAgentModelsShared";
import type { CodexCacheModel, CodexCacheReasoningLevel } from "./types";
import {
  buildRuntimeModelContext,
  pickRuntimeDefaultModel,
  pickRuntimeDefaultReasoning,
  readTextFileIfPresent,
  toReasoningOption,
  uniqueModelOptions,
} from "./helpers";

function formatCodexModelLabel(raw: string): string {
  return raw
    .trim()
    .split("-")
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "codex") return "Codex";
      if (lower === "spark") return "Spark";
      if (lower === "mini") return "Mini";
      if (lower === "max") return "Max";
      if (index === 0) return part.toUpperCase();
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join("-");
}

function toCodexModelOption(entry: CodexCacheModel): AgentModelOption | null {
  if (typeof entry.slug !== "string" || entry.slug.trim().length === 0) {
    return null;
  }

  const slug = entry.slug.trim();
  const rawLabel = typeof entry.display_name === "string" && entry.display_name.trim().length > 0
    ? entry.display_name.trim()
    : slug;

  return {
    id: slug,
    label: formatCodexModelLabel(rawLabel),
    description: typeof entry.description === "string" && entry.description.trim().length > 0
      ? entry.description.trim()
      : `Model exposed by the local Codex installation (${slug}).`,
    access: entry.supported_in_api === false ? ["chatgpt"] : ["chatgpt", "api"],
  };
}

function parseCodexReasoningOptions(entry: CodexCacheModel): AgentReasoningOption[] {
  const rawLevels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as CodexCacheReasoningLevel[]
    : [];

  return rawLevels
    .map((level) => {
      if (typeof level.effort !== "string" || level.effort.trim().length === 0) {
        return null;
      }
      return toReasoningOption(
        level.effort,
        typeof level.description === "string" ? level.description : null,
      );
    })
    .filter((option): option is AgentReasoningOption => Boolean(option));
}

async function readCodexConfiguredState(): Promise<{ model: string | null; reasoningEffort: string | null }> {
  const contents = await readTextFileIfPresent(join(homedir(), ".codex", "config.toml"));
  if (!contents) {
    return { model: null, reasoningEffort: null };
  }

  const modelMatch = contents.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
  const reasoningMatch = contents.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$/m);

  return {
    model: modelMatch?.[1]?.trim() || null,
    reasoningEffort: reasoningMatch?.[1]?.trim().toLowerCase() || null,
  };
}

export function parseCodexRuntimeModelCatalog(
  value: unknown,
  configuredModel: string | null = null,
  configuredReasoningEffort: string | null = null,
): RuntimeAgentModelCatalog | null {
  if (!value || typeof value !== "object") return null;

  const models = Array.isArray((value as { models?: unknown }).models)
    ? (value as { models: CodexCacheModel[] }).models
    : [];

  const listedModels = models
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.visibility === "list")
    .sort((left, right) => {
      const leftPriority = typeof left.entry.priority === "number" ? left.entry.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.entry.priority === "number" ? right.entry.priority : Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return left.index - right.index;
    })
    .map(({ entry }) => ({ option: toCodexModelOption(entry), entry }))
    .filter((entry): entry is { option: AgentModelOption; entry: CodexCacheModel } => Boolean(entry.option));

  if (listedModels.length === 0) return null;

  const reasoningOptionsByModel: Record<string, AgentReasoningOption[]> = {};
  const defaultReasoningByModel: Record<string, string> = {};
  const modelContextById: Record<string, RuntimeAgentModelContext> = {};

  for (const { option, entry } of listedModels) {
    const context = buildRuntimeModelContext({
      maxTokens: entry.context_window ?? entry.max_context_window,
      inputMaxTokens: entry.max_input_tokens,
      outputMaxTokens: entry.max_output_tokens,
      source: "codex_models_cache",
      note: "Read from the local Codex models cache.",
    });
    if (context) {
      modelContextById[option.id] = context;
    }

    const reasoningOptions = parseCodexReasoningOptions(entry);
    if (reasoningOptions.length > 0) {
      reasoningOptionsByModel[option.id] = reasoningOptions;
      const defaultReasoning = typeof entry.default_reasoning_level === "string"
        ? entry.default_reasoning_level.trim().toLowerCase()
        : null;
      const resolvedDefaultReasoning = pickRuntimeDefaultReasoning(
        reasoningOptions,
        configuredReasoningEffort,
        defaultReasoning,
      );
      if (resolvedDefaultReasoning) {
        defaultReasoningByModel[option.id] = resolvedDefaultReasoning;
      }
    }
  }

  const chatgptModels = listedModels.map(({ option }) => option);
  const apiModels = listedModels
    .map(({ option }) => option)
    .filter((model) => model.access.includes("api"));

  const fallbackPlaceholder = configuredModel?.trim() || chatgptModels[0]?.id || "";
  const chatgptDefault = pickRuntimeDefaultModel(chatgptModels, configuredModel);
  const apiDefault = pickRuntimeDefaultModel(apiModels, configuredModel);

  const defaultReasoningByAccess: Partial<Record<AgentModelAccess, string>> = {};
  if (chatgptDefault) {
    const chatgptReasoning = pickRuntimeDefaultReasoning(
      reasoningOptionsByModel[chatgptDefault] ?? [],
      configuredReasoningEffort,
      defaultReasoningByModel[chatgptDefault] ?? null,
    );
    if (chatgptReasoning) defaultReasoningByAccess.chatgpt = chatgptReasoning;
  }
  if (apiDefault) {
    const apiReasoning = pickRuntimeDefaultReasoning(
      reasoningOptionsByModel[apiDefault] ?? [],
      configuredReasoningEffort,
      defaultReasoningByModel[apiDefault] ?? null,
    );
    if (apiReasoning) defaultReasoningByAccess.api = apiReasoning;
  }

  return {
    agent: "codex",
    customModelPlaceholder: fallbackPlaceholder,
    defaultModelByAccess: {
      ...(chatgptDefault ? { chatgpt: chatgptDefault } : {}),
      ...(apiDefault ? { api: apiDefault } : {}),
    },
    defaultReasoningByAccess,
    modelsByAccess: {
      chatgpt: chatgptModels,
      api: apiModels,
    },
    ...(Object.keys(modelContextById).length > 0 ? { modelContextById } : {}),
    defaultReasoningByModel,
    reasoningOptionsByModel,
  };
}

export async function buildCodexRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const contents = await readTextFileIfPresent(join(homedir(), ".codex", "models_cache.json"));
  if (!contents) return null;

  try {
    const parsed = JSON.parse(contents) as unknown;
    const configuredState = await readCodexConfiguredState();
    return parseCodexRuntimeModelCatalog(
      parsed,
      configuredState.model,
      configuredState.reasoningEffort,
    );
  } catch {
    return null;
  }
}
