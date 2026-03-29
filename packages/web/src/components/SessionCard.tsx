"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  GitBranch,
  MessageSquare,
  Terminal,
  RotateCcw,
  XOctagon,
} from "lucide-react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { getAttentionLevel, TERMINAL_STATUSES } from "@/lib/types";
import { cn } from "@/lib/cn";
import { ActivityDot } from "./ActivityDot";
import { AgentTileIcon } from "./AgentTileIcon";
import { CIBadge } from "./CIBadge";
import { DiffSizeBadge } from "./DiffSizeBadge";
import { buildSessionHref } from "@/lib/dashboardHref";

/* ─── Helpers ────────────────────────────────────────────────────────── */

function formatAge(isoDate: string, now: number): string {
  const diffMs = now - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDuration(createdAt: string, lastActivityAt: string): string {
  const ms = new Date(lastActivityAt).getTime() - new Date(createdAt).getTime();
  if (ms < 0) return "-";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function parseCost(metadata: Record<string, string>): number | null {
  const raw = metadata["cost"];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.estimatedCostUsd ?? parsed.totalUSD ?? null;
  } catch {
    return null;
  }
}

const PROJECT_PALETTE = [
  { bg: "rgba(59,130,246,0.12)", text: "#60a5fa" },
  { bg: "rgba(139,92,246,0.12)", text: "#a78bfa" },
  { bg: "rgba(16,185,129,0.12)", text: "#34d399" },
  { bg: "rgba(245,158,11,0.12)", text: "#fbbf24" },
  { bg: "rgba(244,63,94,0.12)", text: "#fb7185" },
  { bg: "rgba(6,182,212,0.12)", text: "#22d3ee" },
  { bg: "rgba(99,102,241,0.12)", text: "#818cf8" },
  { bg: "rgba(236,72,153,0.12)", text: "#f472b6" },
];

function getProjectColor(projectId: string): { bg: string; text: string } {
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PROJECT_PALETTE[Math.abs(hash) % PROJECT_PALETTE.length];
}

/* ─── Attention-level visual config ──────────────────────────────────── */

const LEVEL_BORDER: Record<string, string> = {
  merge: "border-[color-mix(in_srgb,var(--status-ready)_30%,transparent)]",
  respond: "border-[color-mix(in_srgb,var(--status-attention)_30%,transparent)]",
  review: "border-[color-mix(in_srgb,var(--vk-orange,orange)_20%,transparent)]",
};

const LEVEL_TITLE_CLASS: Record<string, string> = {
  working: "text-[13px] font-medium text-[var(--text-secondary)]",
  pending: "text-[13px] font-medium text-[var(--text-secondary)]",
};

/* ─── Alert detection ────────────────────────────────────────────────── */

interface Alert {
  key: string;
  label: string;
  color: string;
  borderColor: string;
  bg: string;
}

function getAlerts(session: DashboardSession): Alert[] {
  const alerts: Alert[] = [];
  const pr = session.pr;
  if (!pr) return alerts;

  if (pr.ciStatus === "failing") {
    alerts.push({
      key: "ci-failing",
      label: "CI failing",
      color: "var(--status-error)",
      borderColor: "color-mix(in srgb, var(--status-error) 40%, transparent)",
      bg: "color-mix(in srgb, var(--status-error) 8%, transparent)",
    });
  }

  if (pr.reviewDecision === "changes_requested") {
    alerts.push({
      key: "changes",
      label: "Changes requested",
      color: "var(--vk-orange, #f59f0a)",
      borderColor: "color-mix(in srgb, var(--vk-orange, #f59f0a) 40%, transparent)",
      bg: "color-mix(in srgb, var(--vk-orange, #f59f0a) 8%, transparent)",
    });
  }

  if (!pr.mergeability.noConflicts) {
    alerts.push({
      key: "conflicts",
      label: "Conflicts",
      color: "var(--status-error)",
      borderColor: "color-mix(in srgb, var(--status-error) 40%, transparent)",
      bg: "color-mix(in srgb, var(--status-error) 8%, transparent)",
    });
  }

  if (
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved &&
    pr.state === "open"
  ) {
    alerts.push({
      key: "merge-ready",
      label: "Ready to merge",
      color: "var(--status-ready)",
      borderColor: "color-mix(in srgb, var(--status-ready) 40%, transparent)",
      bg: "color-mix(in srgb, var(--status-ready) 8%, transparent)",
    });
  }

  return alerts;
}

/* ─── Done status info ───────────────────────────────────────────────── */

function getDoneStatusInfo(session: DashboardSession): {
  label: string;
  color: string;
  bg: string;
} {
  if (session.status === "merged" || session.pr?.state === "merged") {
    return { label: "merged", color: "var(--status-ready)", bg: "color-mix(in srgb, var(--status-ready) 12%, transparent)" };
  }
  if (session.status === "killed" || session.status === "terminated") {
    return { label: session.status, color: "var(--status-error)", bg: "color-mix(in srgb, var(--status-error) 12%, transparent)" };
  }
  return { label: session.status || "done", color: "var(--text-faint)", bg: "color-mix(in srgb, var(--text-faint) 12%, transparent)" };
}

/* ─── Review badge ───────────────────────────────────────────────────── */

function ReviewBadge({ decision }: { decision: string }) {
  const approved = decision === "approved";
  const changes = decision === "changes_requested";
  const color = approved
    ? "var(--status-ready)"
    : changes
      ? "var(--status-error)"
      : "var(--text-faint)";
  const bg = approved
    ? "color-mix(in srgb, var(--status-ready) 12%, transparent)"
    : changes
      ? "color-mix(in srgb, var(--status-error) 12%, transparent)"
      : "color-mix(in srgb, var(--text-faint) 10%, transparent)";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: bg, color }}
    >
      {approved ? "\u2705 Approved" : changes ? "Changes req." : `Review: ${decision || "pending"}`}
    </span>
  );
}

/* ─── Props ──────────────────────────────────────────────────────────── */

interface SessionCardProps {
  session: DashboardSession;
  onSelect?: (sessionId: string) => void;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onRestore?: (sessionId: string) => void;
  /** Render compact done variant without expand/collapse */
  compact?: boolean;
}

/* ─── Done Card Variant ──────────────────────────────────────────────── */

function DoneCard({ session, onSelect, onRestore }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const statusInfo = getDoneStatusInfo(session);
  const projectColor = getProjectColor(session.projectId);
  const isRestorable =
    session.status !== "merged" && TERMINAL_STATUSES.has(session.status);

  return (
    <div
      className={cn(
        "rounded-[10px] border border-[rgba(255,255,255,0.06)] bg-[rgba(23,25,30,0.88)] p-3 transition-colors hover:border-[rgba(255,255,255,0.12)]",
        expanded && "border-[rgba(255,255,255,0.1)]",
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, input")) return;
        setExpanded(!expanded);
      }}
    >
      {/* Row 1: Status pill + project + restore */}
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ background: statusInfo.bg, color: statusInfo.color }}
        >
          {statusInfo.label}
        </span>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium"
          style={{ background: projectColor.bg, color: projectColor.text }}
        >
          {session.projectId}
        </span>
        <div className="flex-1" />
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="inline-flex items-center gap-1 text-[10px] text-[var(--color-accent)] hover:underline"
          >
            <RotateCcw className="h-3 w-3" />
            restore
          </button>
        )}
      </div>

      {/* Row 2: Title */}
      <p className="mt-1.5 text-[13px] font-semibold leading-snug text-[var(--text-primary)] line-clamp-2">
        {session.summary || session.projectId}
      </p>

      {/* Row 3: Meta chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {session.branch && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--vk-bg-panel)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-faint)]">
            <GitBranch className="h-2.5 w-2.5 opacity-50" />
            {session.branch}
          </span>
        )}
        {session.pr && (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded-full bg-[var(--vk-bg-panel)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--text-primary)] hover:underline"
          >
            #{session.pr.number}
          </a>
        )}
        {session.pr?.additions != null && session.pr?.deletions != null && (
          <DiffSizeBadge additions={session.pr.additions} deletions={session.pr.deletions} />
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-3 border-t border-[var(--vk-border)] pt-3 space-y-2">
          {session.pr && (
            <div className="flex items-center gap-2 flex-wrap">
              <CIBadge status={session.pr.ciStatus} prUrl={session.pr.url} />
              <ReviewBadge decision={session.pr.reviewDecision} />
            </div>
          )}
          {!session.pr && (
            <p className="text-[11px] text-[var(--text-faint)]">No PR associated.</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main SessionCard ───────────────────────────────────────────────── */

export function SessionCard({
  session,
  onSelect,
  onSend,
  onKill,
  onRestore,
  compact,
}: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [sending, setSending] = useState(false);
  const [ageNow, setAgeNow] = useState(() => Date.now());

  const level = getAttentionLevel(session);
  const isTerminal = TERMINAL_STATUSES.has(session.status);
  const isRestorable = isTerminal && session.status !== "merged";
  const projectColor = getProjectColor(session.projectId);
  const cost = parseCost(session.metadata);
  const alerts = getAlerts(session);
  const agent = session.metadata?.agent;
  const pr = session.pr;

  const isMergeReady =
    pr?.state === "open" &&
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved;

  const handleSend = useCallback(async () => {
    const msg = messageInput.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      await Promise.resolve(onSend?.(session.id, msg));
      setMessageInput("");
    } finally {
      setTimeout(() => setSending(false), 1500);
    }
  }, [messageInput, sending, onSend, session.id]);

  useEffect(() => {
    setAgeNow(Date.now());
    const timer = window.setInterval(() => setAgeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Done variant
  if (level === "done" || compact) {
    return (
      <DoneCard
        session={session}
        onSelect={onSelect}
        onSend={onSend}
        onKill={onKill}
        onRestore={onRestore}
      />
    );
  }

  const borderClass = isMergeReady
    ? LEVEL_BORDER.merge
    : alerts.length > 0
      ? LEVEL_BORDER.respond
      : level in LEVEL_BORDER
        ? LEVEL_BORDER[level]
        : "border-[rgba(255,255,255,0.08)]";

  const titleClass =
    level in LEVEL_TITLE_CLASS ? LEVEL_TITLE_CLASS[level] : "text-[14px] font-semibold text-[var(--text-primary)]";

  return (
    <div
      className={cn(
        "rounded-[10px] border bg-[rgba(23,25,30,0.96)] p-3 shadow-[0_10px_24px_rgba(0,0,0,0.24)] transition-colors hover:border-[rgba(255,255,255,0.14)]",
        borderClass,
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, input, textarea")) return;
        onSelect?.(session.id);
      }}
    >
      {/* Header: ActivityDot + session ID + project + age + detail link */}
      <div className="flex items-center gap-2">
        <ActivityDot activity={session.activity} />
        <span className="font-mono text-[11px] text-[var(--text-muted)] truncate max-w-[120px]">
          {session.id}
        </span>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium"
          style={{ background: projectColor.bg, color: projectColor.text }}
        >
          {session.projectId}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--text-faint)]">
          {formatAge(session.createdAt, ageNow)}
        </span>
        <a
          href={buildSessionHref(session.id, { bridgeId: session.bridgeId, tab: "terminal" })}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--text-muted)]"
          title="Open session"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Title */}
      <div className="mt-1.5">
        <p className={cn("leading-snug line-clamp-2", titleClass)}>
          {session.summary || session.projectId}
        </p>
      </div>

      {/* Meta: branch + PR + diff + agent */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {session.branch && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--text-faint)]">
            <GitBranch className="h-2.5 w-2.5 opacity-50" />
            {session.branch}
          </span>
        )}
        {pr && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[11px] font-bold text-[var(--text-primary)] hover:underline"
          >
            #{pr.number}
          </a>
        )}
        {pr?.additions != null && pr?.deletions != null && (
          <DiffSizeBadge additions={pr.additions} deletions={pr.deletions} />
        )}
        {agent && (
          <span className="inline-flex items-center gap-1 rounded bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
            <AgentTileIcon seed={{ label: agent }} className="h-4 w-4" />
            {agent}
          </span>
        )}
      </div>

      {/* Alert pills */}
      {alerts.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {alerts.map((alert) => (
            <span
              key={alert.key}
              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
              style={{
                background: alert.bg,
                color: alert.color,
                border: `1px solid ${alert.borderColor}`,
              }}
            >
              {alert.label}
            </span>
          ))}
          {pr && <CIBadge status={pr.ciStatus} compact prUrl={pr.url} />}
          {pr && pr.reviewDecision !== "none" && pr.reviewDecision !== "pending" && (
            <ReviewBadge decision={pr.reviewDecision} />
          )}
        </div>
      )}

      {/* Footer: cost + duration + status */}
      <div className="mt-2 flex items-center gap-3 border-t border-[var(--vk-border)] pt-2">
        {cost != null && (
          <span className="font-mono text-[10px] text-[var(--text-faint)]">
            ${cost.toFixed(2)}
          </span>
        )}
        <span className="text-[10px] text-[var(--text-faint)]">
          {formatDuration(session.createdAt, session.lastActivityAt)}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] capitalize text-[var(--text-muted)]">
          {session.status.replace(/_/g, " ")}
        </span>
      </div>

      {/* Quick reply (non-terminal only) */}
      {!isTerminal && (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Message agent..."
            className="flex-1 rounded-md border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2.5 py-1.5 text-[11px] text-[var(--text-primary)] placeholder-[var(--text-faint)] outline-none focus:border-[var(--color-accent)]"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleSend();
            }}
            disabled={sending || messageInput.trim().length === 0}
            className="rounded-md bg-[var(--color-accent)] px-2.5 py-1.5 text-[10px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {sending ? "Sent" : "Send"}
          </button>
        </div>
      )}

      {/* Actions (terminal only) */}
      {isTerminal && (
        <div className="mt-2 flex flex-wrap gap-2">
          {isRestorable && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRestore?.(session.id);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--vk-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)]"
            >
              <RotateCcw className="h-3 w-3" />
              Restore
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onKill?.(session.id);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-[color-mix(in_srgb,var(--status-error)_30%,transparent)] px-2 py-1 text-[10px] font-medium text-[var(--status-error)] hover:bg-[color-mix(in_srgb,var(--status-error)_8%,transparent)]"
          >
            <XOctagon className="h-3 w-3" />
            Cleanup
          </button>
        </div>
      )}
    </div>
  );
}
