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

function getUsageTone(percentUsed: number | null): {
  ring: string;
  dot: string;
  halo: string;
  panel: string;
} {
  if (percentUsed === null) {
    return {
      ring: "rgba(255,255,255,0.12)",
      dot: "var(--text-faint)",
      halo: "transparent",
      panel: "rgba(255,255,255,0.06)",
    };
  }

  if (percentUsed >= 85) {
    return {
      ring: "var(--status-error)",
      dot: "var(--status-error)",
      halo: "color-mix(in srgb, var(--status-error) 24%, transparent)",
      panel: "color-mix(in srgb, var(--status-error) 12%, transparent)",
    };
  }

  if (percentUsed >= 65) {
    return {
      ring: "var(--status-attention)",
      dot: "var(--status-attention)",
      halo: "color-mix(in srgb, var(--status-attention) 24%, transparent)",
      panel: "color-mix(in srgb, var(--status-attention) 12%, transparent)",
    };
  }

  return {
    ring: "var(--status-working)",
    dot: "var(--status-working)",
    halo: "color-mix(in srgb, var(--status-working) 24%, transparent)",
    panel: "color-mix(in srgb, var(--status-working) 10%, transparent)",
  };
}

function UsageRing({ percentUsed }: { percentUsed: number | null }) {
  const clamped = percentUsed === null ? null : Math.min(100, Math.max(0, percentUsed));
  const degree = clamped === null ? 0 : clamped * 3.6;
  const tone = getUsageTone(clamped);
  const background = clamped === null
    ? `linear-gradient(180deg, ${tone.ring}, ${tone.ring})`
    : `conic-gradient(${tone.ring} ${degree}deg, rgba(255,255,255,0.12) ${degree}deg 360deg)`;

  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
      style={{
        background,
        boxShadow: `0 0 0 1px ${tone.panel}, 0 0 18px ${tone.halo}`,
      }}
    >
      <span className="absolute inset-[2px] rounded-full bg-[var(--bg-panel)]" />
      <span
        className="relative h-[6px] w-[6px] rounded-full"
        style={{ backgroundColor: tone.dot }}
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
  // Prefer the session record for the selected model so the sidebar reflects
  // intentional model changes even if the CLI telemetry lags behind.
  const resolvedModel = sessionModel?.trim() || runtimeStatus?.model?.trim() || "";
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
  const usageTone = getUsageTone(percentUsed);

  return (
    <div
      className="mt-3 overflow-hidden rounded-[6px] border border-[var(--border-soft)] bg-[var(--bg-panel)]"
      style={{
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.03), 0 0 0 1px ${usageTone.panel}`,
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 overflow-hidden bg-[linear-gradient(135deg,color-mix(in_srgb,var(--bg-panel)_88%,transparent),color-mix(in_srgb,var(--bg-surface)_76%,transparent))] px-3 py-2.5 text-left text-[12px] leading-[18px] text-[var(--text-normal)] transition hover:bg-[linear-gradient(135deg,color-mix(in_srgb,var(--bg-panel)_96%,transparent),color-mix(in_srgb,var(--bg-surface)_88%,transparent))] sm:text-[13px] sm:leading-[19px]"
          >
            <UsageRing percentUsed={percentUsed} />
            <span className="min-w-0 flex-1 overflow-hidden font-sans">
              <span className="flex flex-wrap items-center gap-x-0 gap-y-1 sm:inline">
                <span className="text-[13px] font-medium tracking-[0.02em] text-[var(--text-strong)] sm:text-[14px]">
                  {primaryLabel}
                </span>
                {usageSummary ? (
                  <>
                    <span className="hidden px-2 text-[var(--text-faint)] sm:inline">·</span>
                    <span className="ml-2 sm:ml-0" style={{ color: usageTone.ring }}>{usageSummary}</span>
                  </>
                ) : null}
                <span className="hidden px-2 text-[var(--text-faint)] sm:inline">·</span>
                <span className="hidden text-[var(--text-muted)] sm:inline">{activeContextLabel}</span>
                <span className="hidden px-2 text-[var(--text-faint)] sm:inline">·</span>
                <span className="hidden truncate font-mono text-[11px] text-[var(--text-faint)] sm:inline sm:text-[12px]">
                  {cwdLabel}
                </span>
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[380px] space-y-2 px-3 py-3">
          <div className="space-y-1">
            <p className="font-sans text-[13px] font-medium tracking-[0.02em] text-[var(--text-strong)]">
              {primaryLabel}
            </p>
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
