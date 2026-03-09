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

export async function buildClaudeRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const settings = await readJsonFileIfPresent<ClaudeSettings>(join(homedir(), ".claude", "settings.json"));
  const stats = await readJsonFileIfPresent<ClaudeStatsCache>(join(homedir(), ".claude", "stats-cache.json"));
  const reasoningOptions = await detectReasoningOptionsFromHelp(["claude", "claude-code", "cc"]);
  const discoveredModels = collectClaudeStatsModels(stats);
  const configuredModel = typeof settings?.model === "string" ? settings.model.trim().toLowerCase() : null;

  const availableModels = uniqueModelOptions(discoveredModels.map((model) => {
    return toRuntimeModelOption(
      model,
      `Model discovered from the local Claude Code installation (${model}).`,
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

  const defaultReasoning = settings?.alwaysThinkingEnabled === true ? "high" : "medium";
  const defaultReasoningByAccess: Partial<Record<AgentModelAccess, string>> = {};
  for (const access of ["pro", "max", "api"] as const) {
    const resolvedDefault = pickRuntimeDefaultReasoning(reasoningOptions, defaultReasoning, defaultReasoning);
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
