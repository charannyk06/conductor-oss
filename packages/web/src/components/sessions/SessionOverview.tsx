"use client";

import { useState } from "react";
import { Bot, Copy, Check, GitBranch, FolderGit2, Clock, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

interface SessionData {
  id: string;
  status: string;
  agent: string;
  output: string;
  createdAt: string;
  branch?: string;
  worktree?: string;
  cost?: number;
  task?: string;
  prompt?: string;
  activity?: string;
  attention?: string;
  startedAt?: string;
  finishedAt?: string;
  [key: string]: unknown;
}

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

  function handleCopy() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 font-mono text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
    >
      <span>{text}</span>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3 opacity-50" />
      )}
    </button>
  );
}

interface TimelineEntry {
  label: string;
  time: string;
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="flex flex-col gap-0">
      {entries.map((entry, i) => (
        <div key={entry.label} className="flex items-start gap-3">
          <div className="flex flex-col items-center">
            <div className="mt-1.5 h-2 w-2 rounded-full bg-[#58a6ff]" />
            {i < entries.length - 1 && <div className="w-px flex-1 min-h-[20px] bg-[#30363d]" />}
          </div>
          <div className="flex items-baseline gap-2 pb-3">
            <span className="text-[12px] text-[var(--color-text-secondary)]">{entry.label}</span>
            <span className="text-[11px] font-mono text-[var(--color-text-muted)]">
              {new Date(entry.time).toLocaleTimeString()}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SessionOverview({ session }: SessionOverviewProps) {
  const prompt = (session.task ?? session.prompt ?? "") as string;
  const timelineEntries: TimelineEntry[] = [
    { label: "Spawned", time: session.createdAt },
    ...(session.startedAt ? [{ label: "Working", time: session.startedAt as string }] : []),
    ...(session.finishedAt ? [{ label: "Done", time: session.finishedAt as string }] : []),
  ];

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Task / Prompt */}
      {prompt && (
        <Card>
          <CardHeader>
            <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">Task</span>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-[13px] text-[var(--color-text-primary)]">{prompt}</p>
          </CardContent>
        </Card>
      )}

      {/* Status badges */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant[session.status] ?? "default"}>{session.status}</Badge>
        {session.activity && <Badge variant="info">{session.activity as string}</Badge>}
        {session.attention && <Badge variant="warning">{session.attention as string}</Badge>}
      </div>

      {/* Agent */}
      <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
        <Bot className="h-4 w-4 text-[var(--color-text-muted)]" />
        <span>{session.agent}</span>
      </div>

      {/* Git info */}
      {(session.branch || session.worktree) && (
        <Card>
          <CardContent className={cn("flex flex-col gap-2")}>
            {session.branch && (
              <div className="flex items-center gap-2">
                <GitBranch className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                <CopyText text={session.branch} />
              </div>
            )}
            {session.worktree && (
              <div className="flex items-center gap-2">
                <FolderGit2 className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                <CopyText text={session.worktree as string} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Cost */}
      {typeof session.cost === "number" && session.cost > 0 && (
        <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <DollarSign className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
          <span>${session.cost.toFixed(2)}</span>
        </div>
      )}

      {/* Timeline */}
      {timelineEntries.length > 0 && (
        <Card>
          <CardHeader>
            <Clock className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">Timeline</span>
          </CardHeader>
          <CardContent>
            <Timeline entries={timelineEntries} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
