"use client";

import { useState } from "react";
import Link from "next/link";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { TERMINAL_STATUSES } from "@conductor-oss/core/types";
import { ActivityDot } from "./ActivityDot";

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onRestore?: (sessionId: string) => void;
}

const PROJECT_PALETTE = [
  { bg: "rgba(59, 130, 246, 0.12)", text: "#60a5fa" },
  { bg: "rgba(139, 92, 246, 0.12)", text: "#a78bfa" },
  { bg: "rgba(16, 185, 129, 0.12)", text: "#34d399" },
  { bg: "rgba(245, 158, 11, 0.12)", text: "#fbbf24" },
  { bg: "rgba(244, 63, 94, 0.12)", text: "#fb7185" },
  { bg: "rgba(6, 182, 212, 0.12)", text: "#22d3ee" },
  { bg: "rgba(99, 102, 241, 0.12)", text: "#818cf8" },
  { bg: "rgba(236, 72, 153, 0.12)", text: "#f472b6" },
];

function getProjectColor(projectId: string): { bg: string; text: string } {
  let hash = 0;
  for (const char of projectId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return PROJECT_PALETTE[Math.abs(hash) % PROJECT_PALETTE.length]!;
}

const STATUS_DOT_COLORS: Record<AttentionLevel, string> = {
  working: "var(--color-status-working)",
  pending: "var(--color-status-attention)",
  review:  "var(--color-accent-orange)",
  respond: "var(--color-status-error)",
  merge:   "var(--color-status-ready)",
  done:    "var(--color-status-done)",
};

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
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

interface CostInfo {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  totalUSD?: number;
}

function parseCost(meta: Record<string, string>): CostInfo | null {
  const raw = meta["cost"];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CostInfo;
  } catch {
    return null;
  }
}

export function SessionCard({ session, onSend, onKill, onRestore }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [sending, setSending] = useState(false);

  const level = getAttentionLevel(session);
  const isTerminal = TERMINAL_STATUSES.has(session.status);
  const isRestorable = isTerminal && session.status !== "merged";
  const projectColor = getProjectColor(session.projectId);
  const cost = parseCost(session.metadata);
  const estimatedCost = cost?.estimatedCostUsd ?? cost?.totalUSD;
  const dotColor = STATUS_DOT_COLORS[level];

  const handleSendMessage = async () => {
    const msg = messageInput.trim();
    if (!msg) return;
    setSending(true);
    onSend?.(session.id, msg);
    setMessageInput("");
    setTimeout(() => setSending(false), 1500);
  };

  return (
    <div
      className={`session-card cursor-pointer ${isTerminal ? "opacity-50" : ""}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, textarea, input")) return;
        setExpanded(!expanded);
      }}
    >
      {/* Row 1: Session ID + Project badge */}
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
        <span className="text-[11px] font-mono font-medium text-[var(--color-text-secondary)] truncate">
          {session.id}
        </span>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: projectColor.bg, color: projectColor.text }}
        >
          {session.projectId || "default"}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {formatAge(session.createdAt)}
        </span>
      </div>

      {/* Row 2: Status dot + status text + agent badge */}
      <div className="flex items-center gap-2 px-4 pb-2">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            level === "working" ? "animate-[activity-pulse_2s_ease-in-out_infinite]" : ""
          }`}
          style={{ background: dotColor }}
        />
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)] capitalize">
          {session.status.replace(/_/g, " ")}
        </span>
        {session.metadata?.agent && (
          <span className="rounded bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
            {session.metadata.agent}
          </span>
        )}
      </div>

      {/* Row 3: Summary / activity text */}
      {session.summary && (
        <div className="px-4 pb-2.5">
          <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)] line-clamp-2">
            {session.summary}
          </p>
        </div>
      )}

      {/* Row 4: PR link */}
      {session.pr && (
        <div className="flex items-center gap-1.5 px-4 pb-2.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-[var(--color-text-muted)] shrink-0">
            <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
          </svg>
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[11px] text-[var(--color-accent)] hover:underline truncate"
          >
            PR #{session.pr.number}
            {session.pr.title ? ` — ${session.pr.title}` : ""}
          </a>
          {session.pr.isDraft && (
            <span className="rounded bg-[rgba(245,158,11,0.1)] px-1 py-0.5 text-[9px] text-[var(--color-status-attention)]">
              draft
            </span>
          )}
        </div>
      )}

      {/* Row 5: Meta row (cost, duration, actions) */}
      <div className="flex items-center gap-3 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
        {estimatedCost != null && (
          <span className="text-[10px] text-[var(--color-text-muted)] font-mono">
            ${estimatedCost.toFixed(2)}
          </span>
        )}
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {formatDuration(session.createdAt, session.lastActivityAt)}
        </span>
        <div className="flex-1" />
        <Link
          href={`/sessions/${encodeURIComponent(session.id)}`}
          onClick={(e) => e.stopPropagation()}
          className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
        >
          View Details
        </Link>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="border-t border-[var(--color-border-subtle)] px-4 py-3 animate-[slide-up_0.15s_ease]">
          {/* Activity */}
          <div className="mb-3 flex items-center gap-2">
            <ActivityDot activity={session.activity} />
            {session.branch && (
              <span className="text-[10px] text-[var(--color-text-muted)] font-mono truncate max-w-[160px]">
                {session.branch}
              </span>
            )}
          </div>

          {/* PR details */}
          {session.pr && (
            <div className="mb-3 space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Pull Request</div>

              {/* CI Status badge */}
              <div className="flex items-center gap-2 flex-wrap">
                <CIBadge status={session.pr.ciStatus} prUrl={session.pr.url} />
                <ReviewBadge decision={session.pr.reviewDecision} />
                {session.pr.state !== "open" && (
                  <span className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-[rgba(163,113,247,0.15)] text-[var(--color-accent-violet)]">
                    {session.pr.state}
                  </span>
                )}
              </div>

              {/* Preview URL */}
              {session.pr.previewUrl && (
                <a href={session.pr.previewUrl} target="_blank" rel="noopener noreferrer"
                   onClick={(e) => e.stopPropagation()}
                   className="flex items-center gap-1 text-[10px] text-[var(--color-accent)] hover:underline">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                  Preview Deploy
                </a>
              )}

              {/* GitHub PR link */}
              <a href={session.pr.url} target="_blank" rel="noopener noreferrer"
                 onClick={(e) => e.stopPropagation()}
                 className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)] hover:underline hover:text-[var(--color-text-primary)]">
                Open on GitHub ↗
              </a>
            </div>
          )}

          {/* Send message */}
          {!isTerminal && (
            <div className="mb-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                  placeholder="Message agent..."
                  className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSendMessage();
                  }}
                  disabled={sending || messageInput.trim().length === 0}
                  className="rounded-md bg-[var(--color-accent)] px-2.5 py-1.5 text-[10px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40"
                >
                  {sending ? "Sent" : "Send"}
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <Link
              href={`/sessions/${encodeURIComponent(session.id)}`}
              onClick={(e) => e.stopPropagation()}
              className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-subtle)] hover:no-underline"
            >
              Terminal
            </Link>
            {isRestorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore?.(session.id);
                }}
                className="rounded-md border border-[var(--color-border-default)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-subtle)]"
              >
                Restore
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onKill?.(session.id);
              }}
              className="rounded-md border border-[rgba(239,68,68,0.3)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-status-error)] transition-colors hover:bg-[rgba(239,68,68,0.08)]"
            >
              {isTerminal ? "Cleanup" : "Kill"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CIBadge({ status, prUrl }: { status: string; prUrl: string }) {
  const color = status === "passing" ? "rgba(63,185,80,0.15)" : status === "failing" ? "rgba(248,81,73,0.15)" : "rgba(139,148,158,0.15)";
  const textColor = status === "passing" ? "var(--color-status-ready)" : status === "failing" ? "var(--color-status-error)" : "var(--color-text-muted)";
  const dot = status === "passing" ? "\u{1F7E2}" : status === "failing" ? "\u{1F534}" : "\u{1F7E1}";
  return (
    <a href={`${prUrl}/checks`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
       className="rounded px-1.5 py-0.5 text-[9px] font-medium hover:opacity-80"
       style={{ background: color, color: textColor }}>
      {dot} CI: {status || "pending"}
    </a>
  );
}

function ReviewBadge({ decision }: { decision: string }) {
  const approved = decision === "approved";
  const changes = decision === "changes_requested";
  const color = approved ? "rgba(63,185,80,0.15)" : changes ? "rgba(248,81,73,0.15)" : "rgba(139,148,158,0.15)";
  const textColor = approved ? "var(--color-status-ready)" : changes ? "var(--color-status-error)" : "var(--color-text-muted)";
  return (
    <span className="rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ background: color, color: textColor }}>
      {approved ? "\u2705 Approved" : changes ? "\u{1F504} Changes requested" : "\u{1F440} Review: " + (decision || "pending")}
    </span>
  );
}
