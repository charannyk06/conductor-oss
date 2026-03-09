"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  Clock3,
  Copy,
  DollarSign,
  FolderGit2,
  GitBranch,
  ListChecks,
  Timer,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { DashboardSession } from "@/lib/types";
import { AgentTileIcon } from "@/components/AgentTileIcon";

type SessionData = DashboardSession & {
  agent?: string;
  worktree?: string | null;
  cost?: number;
  task?: string;
  prompt?: string;
  attention?: string;
  startedAt?: string;
  finishedAt?: string;
};

interface SessionOverviewProps {
  session: SessionData;
}

const statusVariant: Record<string, "success" | "warning" | "error" | "info" | "default"> = {
  archived: "default",
  queued: "info",
  running: "success",
  working: "success",
  done: "default",
  merged: "success",
  errored: "error",
  stuck: "warning",
  killed: "error",
  needs_input: "warning",
};

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access denied or unavailable — silently fail
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex items-center gap-1 font-mono text-[12px] text-[var(--text-normal)] transition-colors hover:text-[var(--text-strong)]"
    >
      <span className="truncate">{text}</span>
      {copied ? <Check className="h-3 w-3 text-[var(--status-ready)]" /> : <Copy className="h-3 w-3 text-[var(--text-faint)]" />}
    </button>
  );
}

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

function getDuration(start?: string | null, finish?: string | null): string {
  if (!start || !finish) return "-";
  const startMs = new Date(start).getTime();
  const finishMs = new Date(finish).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return "-";

  const minutes = Math.floor((finishMs - startMs) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseCost(session: SessionData): number {
  if (typeof session.cost === "number") return session.cost;
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== "object") return 0;

  const raw = metadata["cost"];
  if (typeof raw !== "string") return 0;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const estimated = typeof parsed.estimatedCostUsd === "number" ? parsed.estimatedCostUsd : 0;
    const total = typeof parsed.totalUSD === "number" ? parsed.totalUSD : 0;
    // HUMAN-REVIEWED: display-only cost, no billing impact
    return estimated ?? total;
  } catch {
    return 0;
  }
}

function pickMetadata(session: SessionData, key: string): string | undefined {
  const value = session.metadata[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function parsePositiveInteger(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function SessionOverview({ session }: SessionOverviewProps) {
  const prompt = useMemo(
    () => (
      pickMetadata(session, "task")
      ?? pickMetadata(session, "prompt")
      ?? (typeof session.task === "string" ? session.task : "")
      ?? (typeof session.prompt === "string" ? session.prompt : "")
    ),
    [session],
  );

  const agentName = useMemo(
    () => (
      pickMetadata(session, "agent")
      ?? (typeof session.agent === "string" ? session.agent : "")
    ),
    [session],
  );

  const worktree = useMemo(
    () => (
      pickMetadata(session, "worktree")
      ?? pickMetadata(session, "path")
      ?? (typeof session.worktree === "string" ? session.worktree : "")
    ),
    [session],
  );

  const stats = useMemo(
    () => ({
      created: formatDateTime(session.createdAt),
      started: formatDateTime(pickMetadata(session, "startedAt") ?? session.startedAt),
      finished: formatDateTime(pickMetadata(session, "finishedAt") ?? session.finishedAt),
      duration: getDuration(
        pickMetadata(session, "startedAt") ?? session.startedAt,
        pickMetadata(session, "finishedAt") ?? session.finishedAt,
      ),
      cost: parseCost(session),
    }),
    [session],
  );

  const queuePosition = useMemo(
    () => parsePositiveInteger(pickMetadata(session, "queuePosition")),
    [session],
  );
  const queueDepth = useMemo(
    () => parsePositiveInteger(pickMetadata(session, "queueDepth")),
    [session],
  );
  const recoveryState = useMemo(
    () => pickMetadata(session, "recoveryState") ?? "",
    [session],
  );
  const recoverySummary = useMemo(
    () => {
      if (session.status === "queued") {
        return queuePosition ? `Waiting in queue at position ${queuePosition}${queueDepth ? ` of ${queueDepth}` : ""}.` : "Waiting in the launch queue.";
      }
      if (recoveryState === "requeued_after_restart") {
        return "This session was recovered after a backend restart and requeued automatically.";
      }
      if (recoveryState === "reattach_pending") {
        return "Reattaching the tmux-managed runtime after backend restart.";
      }
      if (recoveryState === "detached_runtime") {
        return "The backend restarted while the agent may still be running. Kill or archive this session before resuming.";
      }
      if (recoveryState === "resume_required") {
        return "This session was recovered after a backend restart. Send a message to resume in the same workspace.";
      }
      return "";
    },
    [queueDepth, queuePosition, recoveryState, session.status],
  );

  return (
    <div className="space-y-3">
      {prompt && (
        <Card>
          <CardHeader>
            <ListChecks className="h-4 w-4 text-[var(--accent)]" />
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
              Task Brief
            </span>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-normal)]">{prompt}</p>
          </CardContent>
        </Card>
      )}

      {(session.status === "queued" || recoveryState) && (
        <Card>
          <CardHeader>
            <Clock3 className="h-4 w-4 text-[var(--accent)]" />
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
              Launch State
            </span>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant[session.status] ?? "default"}>{session.status}</Badge>
              {queuePosition ? (
                <Badge variant="info">
                  Queue #{queuePosition}{queueDepth ? ` / ${queueDepth}` : ""}
                </Badge>
              ) : null}
              {recoveryState ? (
                <Badge variant="warning">{recoveryState.replaceAll("_", " ")}</Badge>
              ) : null}
            </div>
            {recoverySummary ? (
              <p className="text-[13px] leading-relaxed text-[var(--text-normal)]">{recoverySummary}</p>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {(session.branch || worktree) && (
          <Card>
            <CardHeader>
              <GitBranch className="h-4 w-4 text-[var(--text-faint)]" />
              <span className="text-[12px] font-semibold text-[var(--text-normal)]">Workspace</span>
            </CardHeader>
            <CardContent className="space-y-2">
              {session.branch && (
                <div className="surface-panel flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2">
                  <GitBranch className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                  <CopyText text={session.branch} />
                </div>
              )}
              {worktree && (
                <div className="surface-panel flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2">
                  <FolderGit2 className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                  <CopyText text={worktree} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <AgentTileIcon seed={{ label: agentName || "agent" }} className="h-6 w-6" />
            <span className="text-[12px] font-semibold text-[var(--text-normal)]">Session Status</span>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={statusVariant[session.status] ?? "default"}>{session.status}</Badge>
              {session.activity && <Badge variant="info">{session.activity}</Badge>}
              {session.attention && <Badge variant="warning">{session.attention}</Badge>}
            </div>
            <p className="text-[13px] text-[var(--text-normal)]">{agentName || "Unknown agent"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Clock3 className="h-4 w-4 text-[var(--text-faint)]" />
            <span className="text-[12px] font-semibold text-[var(--text-normal)]">Timeline</span>
          </CardHeader>
          <CardContent className="space-y-2 text-[12px] text-[var(--text-muted)]">
            <Row icon={<Timer className="h-3.5 w-3.5" />} label="Created" value={stats.created} />
            <Row icon={<Timer className="h-3.5 w-3.5" />} label="Started" value={stats.started} />
            <Row icon={<Timer className="h-3.5 w-3.5" />} label="Finished" value={stats.finished} />
            <Row icon={<Clock3 className="h-3.5 w-3.5" />} label="Duration" value={stats.duration} />
            <Row
              icon={<DollarSign className="h-3.5 w-3.5" />}
              label="Estimated Cost"
              value={stats.cost > 0 ? `$${stats.cost.toFixed(2)}` : "$0.00"}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="surface-panel flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2">
      <span className="text-[var(--text-faint)]">{icon}</span>
      <span className="min-w-[70px] text-[var(--text-faint)]">{label}</span>
      <span className="ml-auto truncate text-right font-mono text-[11px] text-[var(--text-normal)]">{value}</span>
    </div>
  );
}
