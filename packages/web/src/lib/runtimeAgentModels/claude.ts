import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentModelAccess,
  AgentModelOption,
} from "@conductor-oss/core/types";
import type {
  RuntimeAgentModelContext,
  RuntimeAgentModelCatalog,
} from "../runtimeAgentModelsShared";
import type { ClaudeSettings, ClaudeStatsCache } from "./types";
import {
  buildRuntimeModelContext,
  detectReasoningOptionsFromHelp,
  pickRuntimeDefaultReasoning,
  readJsonFileIfPresent,
  toReasoningOption,
  toObject,
  toRuntimeModelOption,
  uniqueModelOptions,
} from "./helpers";

function formatClaudeModelLabel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized === "opus") return "Claude Opus";
  if (normalized === "sonnet") return "Claude Sonnet";
  if (normalized === "haiku") return "Claude Haiku";

  const match = normalized.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-(\d{8}))?$/);
  if (!match) {
    return normalized
      .split(/[-_]+/g)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }

  const family = match[1];
  const major = match[2];
  const minor = match[3];
  return `Claude ${family[0]?.toUpperCase() + family.slice(1)} ${major}.${minor}`;
}

function getClaudeAccessForModel(model: string): AgentModelAccess[] {
  const normalized = model.trim().toLowerCase();
  if (normalized === "opus" || normalized.includes("claude-opus")) {
    return ["max", "api"];
  }
  if (normalized === "haiku" || normalized.includes("claude-haiku")) {
    return ["pro", "max", "api"];
  }
  return ["pro", "max", "api"];
}

function canonicalizeClaudeModelId(model: string | null | undefined): string | null {
  const normalized = model?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized === "sonnet") return "claude-sonnet-4-6";
  if (normalized === "opus") return "claude-opus-4-6";
  if (normalized === "haiku") return "claude-haiku-4-5";
  return normalized;
}

function resolveClaudeConfiguredModel(
  configuredModel: string | null,
  availableModels: AgentModelOption[],
  family: "sonnet" | "opus" | "haiku",
): string | null {
  if (!configuredModel) return null;
  const normalized = configuredModel.trim().toLowerCase();
  if (availableModels.some((model) => model.id === normalized)) {
    return normalized;
  }
  if (normalized === family) {
    return availableModels.find((model) => model.id.toLowerCase().includes(`claude-${family}`))?.id ?? null;
  }
  return null;
}

function collectClaudeStatsModels(stats: ClaudeStatsCache | null): string[] {
  const entries = Array.isArray(stats?.dailyModelTokens) ? stats.dailyModelTokens : [];
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const entry of [...entries].reverse()) {
    const tokensByModel = toObject(entry.tokensByModel);
    for (const model of Object.keys(tokensByModel)) {
      const normalized = model.trim();
      if (!normalized.startsWith("claude-") || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }

  return ordered;
}

function defaultClaudeReasoningOptions() {
  return ["low", "medium", "high"].map((effort) => toReasoningOption(effort));
}

function collectClaudeConfiguredModels(settings: ClaudeSettings | null): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

  const configuredModel = canonicalizeClaudeModelId(typeof settings?.model === "string" ? settings.model : null);
  if (configuredModel) {
    seen.add(configuredModel);
    values.push(configuredModel);
  }

  if (Array.isArray(settings?.availableModels)) {
    for (const value of settings.availableModels) {
      if (typeof value !== "string") continue;
      const normalized = canonicalizeClaudeModelId(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }

  return values;
}

function supplementClaudeRuntimeModels(discoveredModels: string[], configuredModels: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [...discoveredModels, ...configuredModels]) {
    const normalized = canonicalizeClaudeModelId(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }

  if (ordered.length === 0) {
    seen.add("claude-sonnet-4-6");
    ordered.push("claude-sonnet-4-6");
  }

  if (!seen.has("claude-haiku-4-5")) {
    ordered.push("claude-haiku-4-5");
  }

  return ordered;
}

export async function buildClaudeRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const settings = await readJsonFileIfPresent<ClaudeSettings>(join(homedir(), ".claude", "settings.json"));
  const stats = await readJsonFileIfPresent<ClaudeStatsCache>(join(homedir(), ".claude", "stats-cache.json"));
  const detectedReasoningOptions = await detectReasoningOptionsFromHelp(["claude", "claude-code", "cc"]);
  const reasoningOptions = detectedReasoningOptions.length > 0
    ? detectedReasoningOptions
    : defaultClaudeReasoningOptions();
  const discoveredModels = collectClaudeStatsModels(stats);
  const configuredModels = collectClaudeConfiguredModels(settings);
  const configuredModel = canonicalizeClaudeModelId(typeof settings?.model === "string" ? settings.model : null);

  const availableModels = uniqueModelOptions(supplementClaudeRuntimeModels(discoveredModels, configuredModels).map((model) => {
    return toRuntimeModelOption(
      model,
      `Model available in the local Claude Code installation (${model}).`,
      getClaudeAccessForModel(model),
      formatClaudeModelLabel,
    );
  }));

  if (availableModels.length === 0 && !configuredModel) {
    return null;
  }

  const allModels = availableModels.length > 0
    ? availableModels
    : [
        toRuntimeModelOption(
          configuredModel ?? "sonnet",
          "Model configured in the local Claude Code settings.",
          getClaudeAccessForModel(configuredModel ?? "sonnet"),
          formatClaudeModelLabel,
        ),
      ];

  const proModels = allModels.filter((model) => model.access.includes("pro"));
  const maxModels = allModels.filter((model) => model.access.includes("max"));
  const apiModels = allModels.filter((model) => model.access.includes("api"));
  const modelContextById: Record<string, RuntimeAgentModelContext> = {};

  for (const model of allModels) {
    const usage = stats?.modelUsage?.[model.id];
    const context = buildRuntimeModelContext({
      maxTokens: usage?.contextWindow,
      outputMaxTokens: usage?.maxOutputTokens,
      source: "claude_stats_cache",
      note: "Read from Claude Code's local stats cache.",
    });
    if (context) {
      modelContextById[model.id] = context;
    }
  }

  const defaultModelByAccess: Partial<Record<AgentModelAccess, string>> = {};
  const proDefault = resolveClaudeConfiguredModel(configuredModel, proModels, "sonnet") ?? proModels[0]?.id ?? null;
  const maxDefault = resolveClaudeConfiguredModel(configuredModel, maxModels, "opus")
    ?? maxModels.find((model) => model.id.toLowerCase().includes("claude-opus"))?.id
    ?? maxModels[0]?.id
    ?? null;
  const apiDefault = resolveClaudeConfiguredModel(configuredModel, apiModels, "sonnet") ?? apiModels[0]?.id ?? null;

  if (proDefault) defaultModelByAccess.pro = proDefault;
  if (maxDefault) defaultModelByAccess.max = maxDefault;
  if (apiDefault) defaultModelByAccess.api = apiDefault;

  const configuredReasoning = typeof settings?.effortLevel === "string"
    ? settings.effortLevel.trim().toLowerCase()
    : settings?.alwaysThinkingEnabled === true
      ? "high"
      : "medium";
  const defaultReasoningByAccess: Partial<Record<AgentModelAccess, string>> = {};
  for (const access of ["pro", "max", "api"] as const) {
    const resolvedDefault = pickRuntimeDefaultReasoning(reasoningOptions, configuredReasoning, "medium");
    if (resolvedDefault) {
      defaultReasoningByAccess[access] = resolvedDefault;
    }
  }

  return {
    agent: "claude-code",
    customModelPlaceholder: configuredModel || allModels[0]?.id || "",
    defaultModelByAccess,
    defaultReasoningByAccess,
    modelsByAccess: {
      ...(proModels.length > 0 ? { pro: proModels } : {}),
      ...(maxModels.length > 0 ? { max: maxModels } : {}),
      ...(apiModels.length > 0 ? { api: apiModels } : {}),
    },
    ...(Object.keys(modelContextById).length > 0 ? { modelContextById } : {}),
    ...(reasoningOptions.length > 0
      ? {
          reasoningOptionsByAccess: {
            pro: reasoningOptions,
            max: reasoningOptions,
            api: reasoningOptions,
          },
        }
      : {}),
  };
}
