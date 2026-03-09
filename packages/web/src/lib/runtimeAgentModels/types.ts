import type {
  AgentReasoningOption,
} from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";

export type RuntimeModelCatalogCacheEntry = {
  value: RuntimeAgentModelCatalog | null;
  expiresAt: number;
};

export type CodexCacheReasoningLevel = {
  effort?: unknown;
  description?: unknown;
};

export type CodexCacheModel = {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  priority?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
};

export type ClaudeSettings = {
  model?: unknown;
  alwaysThinkingEnabled?: unknown;
};

export type ClaudeStatsCache = {
  dailyModelTokens?: Array<{
    tokensByModel?: Record<string, unknown>;
  }>;
  modelUsage?: Record<string, {
    contextWindow?: unknown;
    maxOutputTokens?: unknown;
  }>;
};

export type SimpleAuthSettings = {
  security?: {
    auth?: {
      selectedType?: unknown;
    };
  };
};

export type RecentFileMatchOptions = {
  extensions?: string[];
  filenamePattern?: RegExp;
  maxDepth?: number;
  maxFiles?: number;
  maxDirectories?: number;
};

export type DroidModelDetail = {
  reasoningOptions: AgentReasoningOption[];
  defaultReasoning: string | null;
};

export const RUNTIME_MODEL_CATALOG_TTL_MS = 60_000;

export const DEFAULT_REASONING_DESCRIPTIONS: Record<string, string> = {
  minimal: "Minimal deliberate reasoning for the fastest supported responses.",
  low: "Fast responses with lighter reasoning.",
  medium: "Balanced speed and reasoning depth for everyday tasks.",
  high: "Deeper reasoning for more complex tasks.",
  max: "Maximum deliberate reasoning supported by the local CLI.",
  off: "Disable explicit reasoning and use the model's fastest path.",
  none: "Disable explicit reasoning and use the model's fastest path.",
  xhigh: "Maximum reasoning depth for the hardest tasks.",
};
