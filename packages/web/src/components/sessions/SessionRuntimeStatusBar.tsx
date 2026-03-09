"use client";

import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import type { Agent } from "@/hooks/useAgents";
import { normalizeAgentName } from "@/lib/agentUtils";
import { formatCurrentModelLabel } from "@/lib/sessionModelCatalog";
import {
  formatCompactTokens,
  formatResolvedContextSummary,
  formatStatusPath,
  formatUsageSummary,
  getUsageRingPercent,
  resolveRuntimeContext,
  type SessionRuntimeStatus,
} from "@/lib/sessionRuntimeStatus";
import type { RuntimeAgentModelContext } from "@/lib/runtimeAgentModelsShared";

interface SessionRuntimeStatusBarProps {
  agentName: string;
  sessionModel: string | null;
  sessionReasoningEffort: string | null;
  runtimeStatus: SessionRuntimeStatus | null;
  agents: Agent[];
}

function formatReasoningLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized === "xhigh") return "extra high";
  return normalized.replace(/[_-]+/g, " ");
}

function modelAliases(value: string | null | undefined): string[] {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return [];

  const aliases = new Set<string>();
  const push = (candidate: string) => {
    const next = candidate.trim().toLowerCase();
    if (next) aliases.add(next);
  };

  push(normalized);
  if (normalized.includes("/")) {
    const suffix = normalized.split("/").pop();
    if (suffix) push(suffix);
  }

  push(normalized.replace(/-(\d+)-(\d+)(?=$|-)/g, "-$1.$2"));
  push(normalized.replace(/-(\d+)\.(\d+)(?=$|-)/g, "-$1-$2"));

  return [...aliases];
}

function pickStrongerContext(
  current: RuntimeAgentModelContext | null | undefined,
  candidate: RuntimeAgentModelContext | null | undefined,
): RuntimeAgentModelContext | null {
  if (!candidate) return current ?? null;
  if (!current) return candidate;

  const currentValue = current.maxTokens ?? current.inputMaxTokens ?? current.outputMaxTokens ?? 0;
  const candidateValue = candidate.maxTokens ?? candidate.inputMaxTokens ?? candidate.outputMaxTokens ?? 0;
  if (candidateValue > currentValue) {
    return candidate;
  }
  if (currentValue > 0) {
    return current;
  }
  return candidate.source && !current.source ? candidate : current;
}

function buildContextIndex(agents: Agent[]): Map<string, RuntimeAgentModelContext> {
  const index = new Map<string, RuntimeAgentModelContext>();

  for (const agent of agents) {
    const modelContextById = agent.runtimeModelCatalog?.modelContextById ?? {};
    for (const [modelId, context] of Object.entries(modelContextById)) {
      if (!context) continue;
      for (const alias of modelAliases(modelId)) {
        const existing = index.get(alias);
        const next = pickStrongerContext(existing, context);
        if (next) {
          index.set(alias, next);
        }
      }
    }
  }

  return index;
}

function resolveCatalogContext(
  modelId: string,
  directContext: RuntimeAgentModelContext | null | undefined,
  contextIndex: Map<string, RuntimeAgentModelContext>,
): RuntimeAgentModelContext | null {
  let resolved = directContext ?? null;
  for (const alias of modelAliases(modelId)) {
    resolved = pickStrongerContext(resolved, contextIndex.get(alias));
  }
  return resolved;
}

function UsageRing({ percentUsed }: { percentUsed: number | null }) {
  const clamped = percentUsed === null ? null : Math.min(100, Math.max(0, percentUsed));
  const degree = clamped === null ? 0 : clamped * 3.6;
  const background = clamped === null
    ? "linear-gradient(180deg, rgba(230,230,230,0.12), rgba(230,230,230,0.12))"
    : `conic-gradient(#ea7a2a ${degree}deg, rgba(255,255,255,0.12) ${degree}deg 360deg)`;

  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
      style={{ background }}
    >
      <span className="absolute inset-[2px] rounded-full bg-[#141414]" />
      <span
        className={`relative h-[5px] w-[5px] rounded-full ${
          clamped === null ? "bg-[#6d6d6d]" : "bg-[#ea7a2a]"
        }`}
      />
    </span>
  );
}

export function SessionRuntimeStatusBar({
  agentName,
  sessionModel,
  sessionReasoningEffort,
  runtimeStatus,
  agents,
}: SessionRuntimeStatusBarProps) {
  const normalizedAgentName = normalizeAgentName(agentName);
  const resolvedModel = runtimeStatus?.model?.trim() || sessionModel?.trim() || "";
  const resolvedReasoning = runtimeStatus?.reasoningEffort?.trim()
    || sessionReasoningEffort?.trim()
    || "";
  const modelLabel = resolvedModel
    ? formatCurrentModelLabel(agentName, resolvedModel)
    : "Agent default";
  const reasoningLabel = formatReasoningLabel(resolvedReasoning);
  const primaryLabel = reasoningLabel ? `${modelLabel} ${reasoningLabel}` : modelLabel;
  const usageLabel = formatUsageSummary(runtimeStatus);
  const cwdLabel = formatStatusPath(runtimeStatus?.cwd ?? null);
  const percentUsed = getUsageRingPercent(runtimeStatus);
  const contextIndex = useMemo(() => buildContextIndex(agents), [agents]);
  const activeAgent = agents.find((candidate) => normalizeAgentName(candidate.name) === normalizedAgentName) ?? null;
  const activeCatalogContext = resolvedModel
    ? resolveCatalogContext(
        resolvedModel,
        activeAgent?.runtimeModelCatalog?.modelContextById?.[resolvedModel] ?? null,
        contextIndex,
      )
    : null;
  const activeContext = resolveRuntimeContext(runtimeStatus, activeCatalogContext);
  const activeAgentLabel = activeAgent?.label ?? agentName;
  const activeContextLabel = formatResolvedContextSummary(activeContext);
  const usageSummary = runtimeStatus?.usage?.percentLeft != null || runtimeStatus?.usage?.totalTokens != null
    ? usageLabel
    : null;
  const sourceLabel = runtimeStatus?.source?.label?.trim() || "Session metadata";
  const sourcePath = runtimeStatus?.source?.path?.trim() || null;
  const sourceNote = runtimeStatus?.source?.note?.trim()
    || activeContext.note
    || null;

  return (
    <div className="mt-3 rounded-[4px] border border-[#2f2f2f] bg-[#141414] px-3 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 overflow-hidden text-left font-mono text-[12px] leading-[18px] text-[#bbbbbb] sm:text-[13px] sm:leading-[19px]"
          >
            <UsageRing percentUsed={percentUsed} />
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">
              <span className="text-[#f2f2f2]">{primaryLabel}</span>
              {usageSummary ? (
                <>
                  <span className="px-2 text-[#626262]">·</span>
                  <span className="text-[#f0c39a]">{usageSummary}</span>
                </>
              ) : null}
              <span className="px-2 text-[#626262]">·</span>
              <span className="text-[#b7b7b7]">{activeContextLabel}</span>
              <span className="px-2 text-[#626262]">·</span>
              <span className="truncate text-[#7c7c7c]">{cwdLabel}</span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[380px] space-y-2 px-3 py-3">
          <div className="space-y-1">
            <p className="font-mono text-[12px] text-[var(--text-strong)]">{primaryLabel}</p>
            <p className="text-[11px] leading-[16px] text-[var(--text-muted)]">
              {activeAgentLabel} · {sourceLabel}
            </p>
          </div>
          <div className="space-y-1 text-[11px] leading-[16px] text-[var(--text-muted)]">
            <p>Usage: {usageLabel}</p>
            <p>Context: {activeContextLabel}</p>
            {activeContext.maxTokens != null ? <p>Window: {formatCompactTokens(activeContext.maxTokens)} tokens</p> : null}
            {activeContext.inputMaxTokens != null ? <p>Input limit: {formatCompactTokens(activeContext.inputMaxTokens)} tokens</p> : null}
            {activeContext.outputMaxTokens != null ? <p>Output limit: {formatCompactTokens(activeContext.outputMaxTokens)} tokens</p> : null}
            <p>Path: {runtimeStatus?.cwd?.trim() || "Unavailable"}</p>
            {sourcePath ? <p>File: {sourcePath}</p> : null}
            {sourceNote ? <p>{sourceNote}</p> : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
