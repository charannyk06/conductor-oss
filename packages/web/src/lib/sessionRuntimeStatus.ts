"use client";

import type { RuntimeAgentModelContext } from "@/lib/runtimeAgentModelsShared";

export interface SessionRuntimeUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  toolTokens?: number | null;
  totalTokens?: number | null;
  tokensLeft?: number | null;
  percentUsed?: number | null;
  percentLeft?: number | null;
}

export interface SessionRuntimeContextWindow {
  maxTokens?: number | null;
  source?: string | null;
  note?: string | null;
}

export interface SessionRuntimeSource {
  kind?: string | null;
  label?: string | null;
  path?: string | null;
  note?: string | null;
}

export interface SessionRuntimeStatus {
  agent?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  cwd?: string | null;
  updatedAt?: string | null;
  source?: SessionRuntimeSource | null;
  contextWindow?: SessionRuntimeContextWindow | null;
  usage?: SessionRuntimeUsage | null;
}

export interface ResolvedRuntimeContext {
  maxTokens: number | null;
  inputMaxTokens: number | null;
  outputMaxTokens: number | null;
  source: string | null;
  note: string | null;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatCompactTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000) {
    return `${trimTrailingZeros((value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2))}M`;
  }
  if (value >= 1_000) {
    return `${trimTrailingZeros((value / 1_000).toFixed(value >= 100_000 ? 0 : value >= 10_000 ? 1 : 2))}K`;
  }
  return `${Math.round(value)}`;
}

export function formatUsageSummary(status: SessionRuntimeStatus | null | undefined): string {
  const percentLeft = status?.usage?.percentLeft;
  if (typeof percentLeft === "number" && Number.isFinite(percentLeft)) {
    return `${Math.max(0, Math.round(percentLeft))}% left`;
  }

  const totalTokens = status?.usage?.totalTokens;
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    return `${formatCompactTokens(totalTokens)} used`;
  }

  return "usage n/a";
}

export function formatContextSummary(status: SessionRuntimeStatus | null | undefined): string {
  const maxTokens = status?.contextWindow?.maxTokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return `${formatCompactTokens(maxTokens)} ctx`;
  }

  return "ctx unknown";
}

export function formatStatusPath(cwd: string | null | undefined): string {
  const normalized = cwd?.trim();
  if (!normalized) return "cwd unavailable";

  const withHome = normalized
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^([A-Za-z]):\\Users\\[^\\]+/, "~");
  if (withHome.length <= 42) {
    return withHome;
  }

  const segments = withHome.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 3) {
    return withHome;
  }

  const tail = segments.slice(-3).join("/");
  return withHome.startsWith("~") ? `~/${tail}` : `.../${tail}`;
}

export function getUsageRingPercent(status: SessionRuntimeStatus | null | undefined): number | null {
  const percentUsed = status?.usage?.percentUsed;
  if (typeof percentUsed === "number" && Number.isFinite(percentUsed)) {
    return Math.min(100, Math.max(0, percentUsed));
  }
  return null;
}

export function resolveRuntimeContext(
  status: SessionRuntimeStatus | null | undefined,
  modelContext: RuntimeAgentModelContext | null | undefined,
): ResolvedRuntimeContext {
  const runtimeMaxTokens = status?.contextWindow?.maxTokens;
  const catalogMaxTokens = typeof modelContext?.maxTokens === "number" && modelContext.maxTokens > 0
    ? modelContext.maxTokens
    : typeof modelContext?.inputMaxTokens === "number" && modelContext.inputMaxTokens > 0
      ? modelContext.inputMaxTokens
      : null;

  return {
    maxTokens: typeof runtimeMaxTokens === "number" && runtimeMaxTokens > 0 ? runtimeMaxTokens : catalogMaxTokens,
    inputMaxTokens: typeof modelContext?.inputMaxTokens === "number" && modelContext.inputMaxTokens > 0
      ? modelContext.inputMaxTokens
      : null,
    outputMaxTokens: typeof modelContext?.outputMaxTokens === "number" && modelContext.outputMaxTokens > 0
      ? modelContext.outputMaxTokens
      : null,
    source: status?.contextWindow?.source?.trim()
      || modelContext?.source?.trim()
      || null,
    note: status?.contextWindow?.note?.trim()
      || modelContext?.note?.trim()
      || null,
  };
}

export function formatResolvedContextSummary(
  context: ResolvedRuntimeContext | null | undefined,
): string {
  const maxTokens = context?.maxTokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return `${formatCompactTokens(maxTokens)} ctx`;
  }

  return "ctx unknown";
}
