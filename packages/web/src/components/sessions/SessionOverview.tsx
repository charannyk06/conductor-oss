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
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
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

  const raw = (metadata as Record<string, unknown>)["cost"];
  if (typeof raw !== "string") return 0;

  try {
    const parsed = JSON.parse(raw) as { estimatedCostUsd?: number; totalUSD?: number };
    return parsed.estimatedCostUsd ?? parsed.totalUSD ?? 0;
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

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
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
      </div>

      <div className="space-y-3">
        <Card>
          <CardHeader>
            <AgentTileIcon seed={{ label: agentName || "agent" }} className="h-6 w-6" />
            <span className="text-[12px] font-semibold text-[var(--text-normal)]">Session Status</span>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={statusVariant[session.status] ?? "default"}>{session.status}</Badge>
              {session.activity && <Badge variant="info">{session.activity as string}</Badge>}
              {session.attention && <Badge variant="warning">{session.attention as string}</Badge>}
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
