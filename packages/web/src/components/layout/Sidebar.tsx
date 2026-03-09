"use client";

import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Archive, Search } from "lucide-react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { cn } from "@/lib/cn";

interface SidebarProps {
  sessions: DashboardSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onArchive?: (id: string) => Promise<void> | void;
  onCreateWorkspace?: () => void;
  showHeader?: boolean;
}

const SESSION_ICON_DOTS = [
  { top: 0, left: 1, delay: "0ms", opacity: 1 },
  { top: 0, left: 9, delay: "120ms", opacity: 0.9 },
  { top: 6, left: 1, delay: "240ms", opacity: 0.8 },
  { top: 6, left: 9, delay: "360ms", opacity: 0.7 },
  { top: 12, left: 1, delay: "480ms", opacity: 0.6 },
  { top: 12, left: 9, delay: "600ms", opacity: 0.45 },
] as const;

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BRAILLE_SPINNER_INTERVAL_MS = 80;

interface SessionDiffStats {
  additions: number;
  deletions: number;
}

interface SessionDiffStatsCacheEntry {
  key: string;
  stats: SessionDiffStats | null;
}

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 0 || !Number.isFinite(diffMs)) return "now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSessionLabel(session: DashboardSession): string {
  const worktree = session.metadata["worktree"]?.trim() ?? "";
  if (!worktree) return "local";
  const normalized = worktree.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.includes("/worktrees/") ? "worktree" : "local";
}

function getSessionSubtitle(session: DashboardSession): string {
  const branch = session.branch?.trim();
  if (branch) return branch;

  const summary = session.summary?.trim() || session.metadata["summary"]?.trim();
  if (summary) return summary;

  if (session.status?.trim()) {
    return session.status.replace(/[_-]+/g, " ");
  }

  return session.id.slice(0, 8);
}

function getSessionAgent(session: DashboardSession): string | null {
  const agent = session.metadata["agent"]?.trim();
  return agent ? agent : null;
}

function parseDiffStats(session: DashboardSession): { additions: number; deletions: number } | null {
  const candidates = [
    session.metadata["lastStderr"],
    session.metadata["summary"],
    session.summary,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/(\d+)\s+insertions?\(\+\),\s+(\d+)\s+deletions?\(-\)/i);
    if (!match) continue;
    const additions = Number.parseInt(match[1] ?? "0", 10);
    const deletions = Number.parseInt(match[2] ?? "0", 10);
    if (Number.isFinite(additions) && Number.isFinite(deletions)) {
      return { additions, deletions };
    }
  }

  return null;
}

function getSessionDiffCacheKey(session: DashboardSession): string {
  return [
    session.id,
    session.status,
    session.lastActivityAt,
    session.branch ?? "",
    session.metadata["worktree"] ?? "",
  ].join(":");
}

function parseSessionDiffPayload(payload: unknown): SessionDiffStats | null {
  if (!payload || typeof payload !== "object") return null;

  const files = Array.isArray((payload as { files?: unknown }).files)
    ? (payload as { files: Array<{ additions?: unknown; deletions?: unknown }> }).files
    : [];

  let additions = 0;
  let deletions = 0;

  for (const file of files) {
    const nextAdditions = typeof file?.additions === "number" && Number.isFinite(file.additions)
      ? Math.max(0, file.additions)
      : 0;
    const nextDeletions = typeof file?.deletions === "number" && Number.isFinite(file.deletions)
      ? Math.max(0, file.deletions)
      : 0;
    additions += nextAdditions;
    deletions += nextDeletions;
  }

  if (additions <= 0 && deletions <= 0) {
    return null;
  }

  return { additions, deletions };
}

function getStatusBadge(session: DashboardSession, level: AttentionLevel): { label: string; className: string } {
  const summary = `${session.summary ?? ""} ${session.metadata["summary"] ?? ""}`.toLowerCase();

  if (session.status === "killed" || summary.includes("interrupted")) {
    return {
      label: "Interrupted",
      className: "text-[var(--vk-orange)]",
    };
  }

  switch (level) {
    case "merge":
      return {
        label: "Ready",
        className: "text-[var(--vk-green)]",
      };
    case "respond":
      return {
        label: "Needs input",
        className: "text-[var(--vk-red)]",
      };
    case "review":
      return {
        label: "Review",
        className: "text-[var(--vk-orange)]",
      };
    case "working":
      return {
        label: "Running",
        className: "text-[#4e87f3]",
      };
    case "done":
      return {
        label: "Done",
        className: "text-[var(--vk-text-muted)]",
      };
    default:
      return {
        label: "Queued",
        className: "text-[var(--vk-text-muted)]",
      };
  }
}

function SessionRunningSpinner() {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % BRAILLE_SPINNER_FRAMES.length);
    }, BRAILLE_SPINNER_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <span
      aria-hidden="true"
      className="inline-block select-none font-mono text-[18px] leading-none text-[var(--vk-text-strong)]"
    >
      {BRAILLE_SPINNER_FRAMES[frameIndex]}
    </span>
  );
}

function SessionRuntimeIcon({ running }: { running: boolean }) {
  if (!running) return null;

  return (
    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center">
      <SessionRunningSpinner />
    </span>
  );
}

function SessionDiffBadge({
  additions,
  deletions,
  isSelected,
}: SessionDiffStats & { isSelected: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[10px] px-3 py-1.5 font-mono text-[12px] leading-none tabular-nums",
        isSelected ? "bg-[rgba(255,255,255,0.1)]" : "bg-[rgba(255,255,255,0.06)]",
      )}
    >
      <span className="flex items-center gap-3">
        <span className="text-[#18c58f]">+{additions}</span>
        <span className="text-[#f26d6d]">−{deletions}</span>
      </span>
    </span>
  );
}

export function Sidebar({
  sessions,
  selectedId,
  onSelect,
  onArchive,
  onCreateWorkspace,
  showHeader = true,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [diffStatsBySessionId, setDiffStatsBySessionId] = useState<Record<string, SessionDiffStatsCacheEntry>>({});

  const filtered = useMemo(() => {
    const visibleSessions = sessions.filter((session) => session.status !== "archived");
    if (!search.trim()) return visibleSessions;
    const q = search.toLowerCase();

    return visibleSessions.filter((session) => {
      const summary = session.summary ?? "";
      const branch = session.branch ?? "";
      const agent = session.metadata["agent"] ?? "";
      const label = getSessionLabel(session);
      const subtitle = getSessionSubtitle(session);
      return (
        session.id.toLowerCase().includes(q) ||
        session.projectId.toLowerCase().includes(q) ||
        summary.toLowerCase().includes(q) ||
        branch.toLowerCase().includes(q) ||
        agent.toLowerCase().includes(q) ||
        label.toLowerCase().includes(q) ||
        subtitle.toLowerCase().includes(q)
      );
    });
  }, [search, sessions]);

  const handleSessionKeyDown = (event: KeyboardEvent<HTMLDivElement>, sessionId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(sessionId);
    }
  };

  const handleArchive = async (event: MouseEvent<HTMLButtonElement>, sessionId: string) => {
    event.stopPropagation();
    event.preventDefault();
    if (!onArchive || archivingId === sessionId) return;
    setArchivingId(sessionId);
    try {
      await onArchive(sessionId);
    } catch (error) {
      console.error("Failed to archive session", error);
      setArchiveError(sessionId);
      window.setTimeout(() => setArchiveError(null), 3000);
    } finally {
      setArchivingId((current) => (current === sessionId ? null : current));
    }
  };

  const orderedSessions = useMemo(() => {
    return [...filtered].sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }, [filtered]);

  useEffect(() => {
    const controller = new AbortController();
    const sessionsToFetch = orderedSessions.filter((session) => {
      const cacheKey = getSessionDiffCacheKey(session);
      return diffStatsBySessionId[session.id]?.key !== cacheKey;
    });

    if (sessionsToFetch.length === 0) {
      return () => controller.abort();
    }

    void Promise.all(
      sessionsToFetch.map(async (session) => {
        const cacheKey = getSessionDiffCacheKey(session);
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/diff`, {
            signal: controller.signal,
          });
          if (!response.ok) {
            return [session.id, { key: cacheKey, stats: null }] as const;
          }
          const payload = await response.json();
          return [session.id, { key: cacheKey, stats: parseSessionDiffPayload(payload) }] as const;
        } catch (error) {
          if ((error as Error).name === "AbortError") {
            return null;
          }
          return [session.id, { key: cacheKey, stats: null }] as const;
        }
      }),
    ).then((entries) => {
      const resolvedEntries = entries.filter((entry): entry is readonly [string, SessionDiffStatsCacheEntry] => entry !== null);
      if (resolvedEntries.length === 0) return;
      setDiffStatsBySessionId((current) => {
        const next = { ...current };
        for (const [sessionId, entry] of resolvedEntries) {
          next[sessionId] = entry;
        }
        return next;
      });
    });

    return () => controller.abort();
  }, [diffStatsBySessionId, orderedSessions]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showHeader && (
        <div className="flex h-[33px] items-center gap-1 px-2">
          <p className="text-[16px] text-[var(--vk-text-normal)]">Workspaces</p>
          {onCreateWorkspace && (
            <button
              type="button"
              onClick={onCreateWorkspace}
              className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-[3px] text-[var(--vk-orange)] hover:bg-[var(--vk-bg-hover)] lg:hidden"
              aria-label="New workspace"
            >
              <span className="text-[14px]">+</span>
            </button>
          )}
        </div>
      )}

      <div className={cn("flex h-[38px] items-center px-2 pb-1.5", !showHeader && "pt-1.5")}>
        <label className="flex h-[30px] flex-1 items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2">
          <Search className="h-3.5 w-3.5 text-[var(--vk-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="ml-1.5 w-full bg-transparent text-[14px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {orderedSessions.length === 0 ? (
          <p className="px-2 py-2 text-[14px] text-[var(--vk-text-muted)]">No sessions</p>
        ) : (
          <div className="space-y-2">
            {orderedSessions.map((session) => {
              const level = getAttentionLevel(session);
              const diffStats = diffStatsBySessionId[session.id]?.stats ?? parseDiffStats(session);
              const statusBadge = getStatusBadge(session, level);
              const sessionAgent = getSessionAgent(session);
              const isSelected = session.id === selectedId;
              const isRunning = level === "working";
              const isArchiving = archivingId === session.id;
              const hasArchiveError = archiveError === session.id;

              return (
                <div
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => handleSessionKeyDown(event, session.id)}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-[8px] border px-3 py-3 text-left transition-colors",
                    isSelected
                      ? "border-[rgba(234,122,42,0.28)] bg-[rgba(255,255,255,0.08)]"
                      : "border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] hover:bg-[var(--vk-bg-hover)]",
                  )}
                >
                  <SessionRuntimeIcon running={isRunning} />

                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span className="min-w-0 flex flex-1 items-center gap-2">
                        {sessionAgent ? (
                          <span
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
                            title={sessionAgent}
                            aria-label={`${sessionAgent} agent`}
                          >
                            <AgentTileIcon seed={{ label: sessionAgent }} className="h-4 w-4" />
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate text-[14px] font-medium text-[var(--vk-text-strong)]">
                          {getSessionLabel(session)}
                        </span>
                      </span>
                      {diffStats ? (
                        <SessionDiffBadge
                          additions={diffStats.additions}
                          deletions={diffStats.deletions}
                          isSelected={isSelected}
                        />
                      ) : (
                        <span className="shrink-0 rounded-[8px] bg-[rgba(255,255,255,0.06)] px-2.5 py-1 text-[11px] font-medium">
                          <span className={statusBadge.className}>{statusBadge.label}</span>
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block truncate text-[12px] text-[var(--vk-text-muted)]">
                      {getSessionSubtitle(session)}
                    </span>
                  </span>
                  {onArchive ? (
                    <button
                      type="button"
                      onClick={(event) => void handleArchive(event, session.id)}
                      disabled={isArchiving}
                      className={cn(
                        "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-[var(--vk-border)] text-[var(--vk-text-muted)] transition",
                        "opacity-70 group-hover:opacity-100 focus-visible:opacity-100",
                        "hover:border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]",
                        isArchiving && "cursor-wait opacity-100",
                      )}
                      aria-label={`Archive session ${session.id}`}
                      title={hasArchiveError ? "Archive failed" : "Archive session"}
                    >
                      <Archive className={cn("h-3.5 w-3.5", hasArchiveError && "text-red-400")} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
