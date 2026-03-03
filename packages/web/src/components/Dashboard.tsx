"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import type {
  DashboardSession,
  DashboardStats,
  SSESnapshotEvent,
} from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { TERMINAL_STATUSES } from "@conductor-oss/core/types";
import { SessionCard } from "./SessionCard";
import { EmptyState } from "./EmptyState";
import { useTheme } from "./ThemeProvider";

type ConfigProject = {
  id: string;
  boardDir: string;
  boardFile?: string;
  repo: string | null;
  description: string | null;
  agent: string;
};
type AttentionGroup = "respond" | "review" | "merge" | "pending" | "working" | "done";
type StatusFilter = "all" | "active" | "terminal" | "attention";
type SortMode = "recent" | "oldest" | "cost" | "attention";
type ViewMode = "grid" | "lanes";

interface DashboardProps {
  sessions: DashboardSession[];
  stats: DashboardStats;
  configProjects?: ConfigProject[];
}

export function Dashboard({ sessions: initialSessions, stats: initialStats, configProjects: initialConfigProjects = [] }: DashboardProps) {
  const [sessions, setSessions] = useState<DashboardSession[]>(initialSessions);
  const [stats, setStats] = useState<DashboardStats>(initialStats);
  const [configProjects, setConfigProjects] = useState<ConfigProject[]>(initialConfigProjects);
  const [connected, setConnected] = useState(false);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const { theme, toggleTheme } = useTheme();

  // SSE connection for live updates
  // Fetch all configured projects for sidebar (even with 0 sessions)
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json() as Promise<{ projects: ConfigProject[] }>)
      .then((d) => { if (Array.isArray(d.projects)) setConfigProjects(d.projects); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as SSESnapshotEvent;
        if (data.type === "snapshot" && data.sessions) {
          setSessions((prev) => {
            const updates = new Map(data.sessions.map((s) => [s.id, s]));
            const prevIds = new Set(prev.map((s) => s.id));
            const removedIds = new Set<string>();
            for (const id of prevIds) {
              if (!updates.has(id)) removedIds.add(id);
            }
            const newSessionIds: string[] = [];
            for (const id of updates.keys()) {
              if (!prevIds.has(id)) newSessionIds.push(id);
            }

            let changed = removedIds.size > 0 || newSessionIds.length > 0;

            const next = prev
              .filter((s) => !removedIds.has(s.id))
              .map((session) => {
                const update = updates.get(session.id);
                if (!update) return session;

                const statusChanged = update.status !== session.status;
                const activityChanged = update.activity !== session.activity;
                const summaryChanged = update.summary != null && update.summary !== session.summary;
                const prChanged = update.pr != null && session.pr != null && (
                  update.pr.ciStatus !== session.pr.ciStatus ||
                  update.pr.reviewDecision !== session.pr.reviewDecision ||
                  update.pr.state !== session.pr.state ||
                  update.pr.mergeable !== session.pr.mergeability.mergeable
                );

                if (statusChanged || activityChanged || summaryChanged || prChanged) {
                  changed = true;
                  const merged = {
                    ...session,
                    status: update.status,
                    activity: update.activity,
                    lastActivityAt: update.lastActivityAt,
                    createdAt: update.createdAt,
                    projectId: update.projectId,
                    issueId: update.issueId,
                    branch: update.branch,
                    metadata: update.metadata,
                    ...(summaryChanged ? { summary: update.summary! } : {}),
                  };
                  if (prChanged && merged.pr && update.pr) {
                    merged.pr = {
                      ...merged.pr,
                      ciStatus: update.pr.ciStatus,
                      reviewDecision: update.pr.reviewDecision,
                      state: update.pr.state,
                      mergeability: {
                        ...merged.pr.mergeability,
                        mergeable: update.pr.mergeable,
                      },
                    };
                  }
                  return merged;
                }
                return session;
              });

            for (const id of newSessionIds) {
              const update = updates.get(id)!;
              next.push({
                id,
                status: update.status,
                activity: update.activity,
                createdAt: update.createdAt,
                lastActivityAt: update.lastActivityAt,
                summary: update.summary ?? null,
                projectId: update.projectId,
                issueId: update.issueId ?? null,
                branch: update.branch ?? null,
                metadata: update.metadata,
                pr: null,
              });
            }

            return changed ? next : prev;
          });
        }
      } catch {
        // Ignore malformed SSE events
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  // Poll /api/sessions every 5s for full data refresh
  const pollSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: DashboardSession[]; stats: DashboardStats };
      setSessions(data.sessions);
      setStats(data.stats);
    } catch {
      // ignore poll errors
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => void pollSessions(), 3000);
    return () => clearInterval(interval);
  }, [pollSessions]);

  // Recompute stats when sessions change
  useEffect(() => {
    setStats({
      totalSessions: sessions.length,
      workingSessions: sessions.filter((s) => s.activity === "active").length,
      openPRs: sessions.filter((s) => s.pr?.state === "open").length,
      needsAttention: sessions.filter(
        (s) =>
          s.status === "needs_input" ||
          s.status === "stuck" ||
          s.status === "errored" ||
          s.activity === "waiting_input" ||
          s.activity === "blocked"
      ).length,
    });
  }, [sessions]);

  // Merge config projects + session-derived counts for sidebar
  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sess of sessions) {
      const pid = sess.projectId || "default";
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    const allIds = new Set([...configProjects.map((p) => p.id), ...counts.keys()]);
    return [...allIds].sort().map((id) => {
      const cfg = configProjects.find((p) => p.id === id);
      return {
        id,
        count: counts.get(id) ?? 0,
        boardDir: cfg?.boardDir ?? id,
        boardFile: cfg?.boardFile,
        repo: cfg?.repo ?? null,
      };
    });
  }, [sessions, configProjects]);

  const agentOptions = useMemo(() => {
    const unique = new Set<string>();
    for (const session of sessions) {
      const agent = session.metadata["agent"]?.trim();
      if (agent) unique.add(agent);
    }
    return [...unique].sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  // Filtered + sorted sessions
  const filteredSessions = useMemo(() => {
    let next = sessions;

    if (activeProject) {
      next = next.filter((s) => (s.projectId || "default") === activeProject);
    }

    if (statusFilter === "active") {
      next = next.filter((s) => !TERMINAL_STATUSES.has(s.status));
    } else if (statusFilter === "terminal") {
      next = next.filter((s) => TERMINAL_STATUSES.has(s.status));
    } else if (statusFilter === "attention") {
      next = next.filter((s) => {
        const level = getAttentionLevel(s);
        return level === "respond" || level === "review" || level === "merge";
      });
    }

    if (attentionOnly) {
      next = next.filter((s) => {
        const level = getAttentionLevel(s);
        return level === "respond" || level === "review" || level === "merge";
      });
    }

    if (agentFilter !== "all") {
      next = next.filter((s) => (s.metadata["agent"] ?? "") === agentFilter);
    }

    const query = search.trim().toLowerCase();
    if (query.length > 0) {
      next = next.filter((s) => {
        const haystack = [
          s.id,
          s.projectId,
          s.issueId ?? "",
          s.branch ?? "",
          s.summary ?? "",
          s.status,
          s.activity ?? "",
          s.metadata["agent"] ?? "",
          s.pr?.title ?? "",
          s.pr?.url ?? "",
        ].join("\n").toLowerCase();
        return haystack.includes(query);
      });
    }

    const ranked = [...next];
    ranked.sort((a, b) => {
      if (sortMode === "oldest") {
        return new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime();
      }
      if (sortMode === "cost") {
        return parseEstimatedCost(b) - parseEstimatedCost(a);
      }
      if (sortMode === "attention") {
        return attentionRank(a) - attentionRank(b);
      }
      return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    });

    return ranked;
  }, [sessions, activeProject, statusFilter, attentionOnly, agentFilter, search, sortMode]);

  const sessionsByLane = useMemo(() => {
    const grouped: Record<AttentionGroup, DashboardSession[]> = {
      respond: [],
      review: [],
      merge: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of filteredSessions) {
      const lane = getAttentionLevel(session) as AttentionGroup;
      grouped[lane].push(session);
    }
    return grouped;
  }, [filteredSessions]);

  const cleanupCandidates = useMemo(
    () => filteredSessions.filter((s) => TERMINAL_STATUSES.has(s.status)),
    [filteredSessions],
  );

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const executeKill = useCallback(async (sessionId: string): Promise<{ ok: boolean; reason?: string }> => {
    setBusySessionId(sessionId);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 404) {
        const detail = await res.text();
        return {
          ok: false,
          reason: detail || `Request failed with ${res.status}`,
        };
      }

      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      return { ok: false, reason: msg };
    } finally {
      setBusySessionId((current) => (current === sessionId ? null : current));
    }
  }, []);

  const handleKill = async (sessionId: string) => {
    if (busySessionId || bulkBusy) return;
    if (!confirm(`Kill / clean up session ${sessionId}?`)) return;
    setActionError(null);
    const result = await executeKill(sessionId);
    if (!result.ok) {
      const reason = result.reason ?? "Unknown error";
      setActionError(`Unable to clean up session ${sessionId}: ${reason}`);
      console.error(`Failed to kill ${sessionId}:`, reason);
    }
  };

  const handleCleanupTerminal = async () => {
    if (busySessionId || bulkBusy) return;
    if (cleanupCandidates.length === 0) return;

    const ids = [...new Set(cleanupCandidates.map((s) => s.id))];
    const noun = ids.length === 1 ? "session" : "sessions";
    if (!confirm(`Clean up ${ids.length} terminal ${noun} in current view?`)) return;

    setActionError(null);
    setBulkBusy(true);
    const failures: string[] = [];
    for (const sessionId of ids) {
      const result = await executeKill(sessionId);
      if (!result.ok) {
        failures.push(`${sessionId}: ${result.reason ?? "Unknown error"}`);
      }
    }
    setBulkBusy(false);

    if (failures.length > 0) {
      setActionError(`Cleanup completed with ${failures.length} failure(s). ${failures[0]}`);
      return;
    }
    setActionError(null);
  };

  const handleRestore = async (sessionId: string) => {
    if (busySessionId || bulkBusy) return;
    if (busySessionId === sessionId) return;
    if (!confirm(`Restore session ${sessionId}?`)) return;
    setBusySessionId(sessionId);
    setActionError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
        method: "POST",
      });
      if (!res.ok) {
        const detail = await res.text();
        const reason = detail || `Request failed with ${res.status}`;
        setActionError(`Unable to restore session ${sessionId}: ${reason}`);
        console.error(`Failed to restore ${sessionId}:`, detail);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setActionError(`Unable to restore session ${sessionId}: ${msg}`);
      console.error(`Failed to restore ${sessionId}:`, err);
    } finally {
      setBusySessionId((current) => (current === sessionId ? null : current));
    }
  };

  useEffect(() => {
    if (!commandOpen) return;
    const id = window.setTimeout(() => {
      commandInputRef.current?.focus();
    }, 20);
    return () => window.clearTimeout(id);
  }, [commandOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = Boolean(
        target &&
          (target.closest("input, textarea, select") ||
            target.isContentEditable),
      );

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        setCommandQuery("");
        return;
      }

      if (event.key === "Escape" && commandOpen) {
        event.preventDefault();
        setCommandOpen(false);
        return;
      }

      if (!isTypingTarget && event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen]);

  type CommandAction = { id: string; label: string; hint?: string; run: () => void };
  const commandActions: CommandAction[] = useMemo(() => {
    return [
      {
        id: "toggle-theme",
        label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
        hint: "Appearance",
        run: () => toggleTheme(),
      },
      {
        id: "toggle-view",
        label: viewMode === "grid" ? "Switch to lane view" : "Switch to grid view",
        hint: "Layout",
        run: () => setViewMode((v) => (v === "grid" ? "lanes" : "grid")),
      },
      {
        id: "refresh",
        label: "Refresh sessions now",
        hint: "Live data",
        run: () => {
          void pollSessions();
        },
      },
      {
        id: "focus-attention",
        label: attentionOnly ? "Show all sessions" : "Focus needs attention",
        hint: "Filtering",
        run: () => setAttentionOnly((v) => !v),
      },
      {
        id: "clear-filters",
        label: "Clear filters",
        hint: "Filtering",
        run: () => {
          setSearch("");
          setStatusFilter("all");
          setAgentFilter("all");
          setAttentionOnly(false);
          setSortMode("recent");
        },
      },
      {
        id: "cleanup",
        label: `Cleanup terminal sessions (${cleanupCandidates.length})`,
        hint: "Agent control",
        run: () => {
          void handleCleanupTerminal();
        },
      },
    ];
  }, [theme, toggleTheme, viewMode, pollSessions, attentionOnly, cleanupCandidates.length, handleCleanupTerminal]);

  const visibleCommandActions = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (query.length === 0) return commandActions;
    return commandActions.filter((action) => {
      const text = `${action.label} ${action.hint ?? ""}`.toLowerCase();
      return text.includes(query);
    });
  }, [commandActions, commandQuery]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`shrink-0 border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] flex flex-col transition-all duration-200 ${
          sidebarOpen ? "w-60" : "w-0 overflow-hidden border-r-0"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)] tracking-tight">
            Conductor
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          <div className="mb-1 px-2 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Projects
          </div>

          {/* All sessions */}
          <button
            onClick={() => setActiveProject(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${
              activeProject === null
                ? "bg-[var(--color-sidebar-active)] text-[var(--color-accent)] font-medium"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
              <path d="M1.5 1.75V13.5h13.25a.75.75 0 010 1.5H.75a.75.75 0 01-.75-.75V1.75a.75.75 0 011.5 0zm14.28 2.53l-5.25 5.25a.75.75 0 01-1.06 0L7 7.06 4.28 9.78a.75.75 0 01-1.06-1.06l3.25-3.25a.75.75 0 011.06 0L10 7.94l4.72-4.72a.75.75 0 111.06 1.06z" />
            </svg>
            <span>All Sessions</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-muted)] tabular-nums">
              {sessions.length}
            </span>
          </button>

          {/* Project list */}
          {projects.map((project) => {
            const boardDirHasPath = project.boardDir.includes("/");
            const inferredBoardFile = project.boardDir.endsWith(".md")
              ? (boardDirHasPath ? project.boardDir : `projects/${project.boardDir}`)
              : (boardDirHasPath
                ? `${project.boardDir}/CONDUCTOR.md`
                : `projects/${project.boardDir}/CONDUCTOR.md`);
            const obsidianFile = project.boardFile ?? inferredBoardFile;
            const obsidianUrl = `obsidian://open?vault=workspace&file=${encodeURIComponent(obsidianFile)}`;
            const githubUrl = project.repo ? `https://github.com/${project.repo}` : null;
            return (
              <div key={project.id} className="group relative">
                <button
                  onClick={() => setActiveProject(activeProject === project.id ? null : project.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                    activeProject === project.id
                      ? "bg-[var(--color-sidebar-active)] text-[var(--color-accent)] font-medium"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]"
                  }`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />
                  <span className="truncate">{project.id}</span>
                  <span className="ml-auto text-[11px] text-[var(--color-text-muted)] tabular-nums">
                    {project.count}
                  </span>
                </button>
                {/* Quick-action icons shown on hover */}
                <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-1">
                  <a href={obsidianUrl} title="Open board in Obsidian" onClick={(e) => e.stopPropagation()}
                     className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-subtle)]">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
                  </a>
                  {githubUrl && (
                    <a href={githubUrl} target="_blank" rel="noopener noreferrer" title="Open repo on GitHub" onClick={(e) => e.stopPropagation()}
                       className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-subtle)]">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-6 py-3">
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)] transition-colors"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 2.75A.75.75 0 011.75 2h12.5a.75.75 0 010 1.5H1.75A.75.75 0 011 2.75zm0 5A.75.75 0 011.75 7h12.5a.75.75 0 010 1.5H1.75A.75.75 0 011 7.75zM1.75 12a.75.75 0 000 1.5h12.5a.75.75 0 000-1.5H1.75z" />
            </svg>
          </button>

          <h1 className="text-[15px] font-semibold text-[var(--color-text-primary)] tracking-tight">
            {activeProject ? activeProject : "Dashboard"}
          </h1>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected
                  ? "bg-[var(--color-status-ready)] animate-[pulse_3s_ease-in-out_infinite]"
                  : "bg-[var(--color-status-error)]"
              }`}
            />
            <span className="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider">
              {connected ? "Live" : "Offline"}
            </span>
          </div>

          <div className="flex-1" />

          {/* Stats pills */}
          <div className="hidden items-center gap-2 sm:flex">
            <StatPill label="Sessions" value={stats.totalSessions} />
            {stats.workingSessions > 0 && (
              <StatPill
                label="Working"
                value={stats.workingSessions}
                color="var(--color-status-working)"
              />
            )}
            {stats.openPRs > 0 && (
              <StatPill
                label="PRs"
                value={stats.openPRs}
                color="var(--color-accent-violet)"
              />
            )}
            {stats.needsAttention > 0 && (
              <StatPill
                label="Attention"
                value={stats.needsAttention}
                color="var(--color-status-attention)"
              />
            )}
          </div>

          <button
            onClick={() => {
              setCommandOpen(true);
              setCommandQuery("");
            }}
            className="hidden items-center gap-2 rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)] sm:flex"
            title="Open command bar"
          >
            <span>Command</span>
            <kbd className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-1 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
              Ctrl/Cmd+K
            </kbd>
          </button>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="rounded-md border border-[var(--color-border-default)] p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)]"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0V.75A.75.75 0 018 0zm5.657 2.343a.75.75 0 010 1.06l-1.06 1.061a.75.75 0 11-1.061-1.06l1.06-1.061a.75.75 0 011.061 0zM16 8a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0116 8zm-2.343 5.657a.75.75 0 01-1.06 0l-1.061-1.06a.75.75 0 111.06-1.061l1.061 1.06a.75.75 0 010 1.061zM8 16a.75.75 0 01-.75-.75v-1.5a.75.75 0 011.5 0v1.5A.75.75 0 018 16zM2.343 13.657a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.061a.75.75 0 01-1.061 0zM0 8a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5H.75A.75.75 0 010 8zm2.343-5.657a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061L2.343 3.404a.75.75 0 010-1.061z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z" />
              </svg>
            )}
          </button>
        </header>
        {actionError && (
          <div className="mx-6 mt-3 rounded-md border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.12)] px-3 py-2 text-[11px] text-[var(--color-status-error)]">
            {actionError}
          </div>
        )}

        <section className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-6 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search sessions, issues, branches, agents..."
                className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="all">All statuses</option>
                <option value="active">Active only</option>
                <option value="terminal">Terminal only</option>
                <option value="attention">Needs attention</option>
              </select>

              <select
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="all">All agents</option>
                {agentOptions.map((agent) => (
                  <option key={agent} value={agent}>{agent}</option>
                ))}
              </select>

              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="recent">Recent activity</option>
                <option value="oldest">Oldest activity</option>
                <option value="attention">Attention priority</option>
                <option value="cost">Cost high to low</option>
              </select>

              <button
                onClick={() => setAttentionOnly((v) => !v)}
                className={`rounded-md border px-2.5 py-2 text-[11px] font-medium transition-colors ${
                  attentionOnly
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                    : "border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                Attention only
              </button>

              <button
                onClick={() => setViewMode((v) => (v === "grid" ? "lanes" : "grid"))}
                className="rounded-md border border-[var(--color-border-default)] px-2.5 py-2 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)]"
              >
                {viewMode === "grid" ? "Lane View" : "Grid View"}
              </button>

              <button
                onClick={() => void handleCleanupTerminal()}
                disabled={cleanupCandidates.length === 0 || bulkBusy || busySessionId !== null}
                className="rounded-md border border-[rgba(239,68,68,0.28)] px-2.5 py-2 text-[11px] font-medium text-[var(--color-status-error)] transition-colors hover:bg-[rgba(239,68,68,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
                title={cleanupCandidates.length === 0 ? "No terminal sessions in current view" : "Clean up terminal sessions in current view"}
              >
                {bulkBusy ? "Cleaning..." : `Cleanup (${cleanupCandidates.length})`}
              </button>
            </div>
          </div>

          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            Showing {filteredSessions.length} of {sessions.length} sessions
            {activeProject ? ` in ${activeProject}` : ""}.
          </div>
        </section>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6">
          {filteredSessions.length === 0 ? (
            <EmptyState />
          ) : viewMode === "lanes" ? (
            <div className="flex min-w-max gap-4">
              {LANE_META.map((lane) => (
                <LaneColumn
                  key={lane.id}
                  title={lane.title}
                  color={lane.color}
                  count={sessionsByLane[lane.id].length}
                >
                  {sessionsByLane[lane.id].length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-4 text-[11px] text-[var(--color-text-muted)]">
                      No sessions
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {sessionsByLane[lane.id].map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          onSend={handleSend}
                          onKill={handleKill}
                          onRestore={handleRestore}
                          actionBusy={busySessionId === session.id || bulkBusy}
                        />
                      ))}
                    </div>
                  )}
                </LaneColumn>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onSend={handleSend}
                  onKill={handleKill}
                  onRestore={handleRestore}
                  actionBusy={busySessionId === session.id || bulkBusy}
                />
              ))}
            </div>
          )}
        </main>

        {commandOpen && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(9,11,16,0.58)] p-4 pt-24 backdrop-blur-[1.5px]"
            onClick={() => setCommandOpen(false)}
          >
            <div
              className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] shadow-[0_20px_70px_rgba(0,0,0,0.35)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
                <input
                  ref={commandInputRef}
                  type="text"
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  placeholder="Run command..."
                  className="w-full bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder-[var(--color-text-muted)]"
                />
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-2">
                {visibleCommandActions.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">No commands found.</div>
                ) : (
                  visibleCommandActions.map((action) => (
                    <button
                      key={action.id}
                      onClick={() => {
                        action.run();
                        setCommandOpen(false);
                      }}
                      className="flex w-full items-center rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-elevated)]"
                    >
                      <span className="text-[12px] text-[var(--color-text-primary)]">{action.label}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{action.hint ?? ""}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Stat pill badge for the header */
function StatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1"
      style={{
        borderColor: color ? `color-mix(in srgb, ${color} 25%, transparent)` : "var(--color-border-default)",
        background: color ? `color-mix(in srgb, ${color} 8%, transparent)` : "transparent",
      }}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
        />
      )}
      <span
        className="text-[12px] font-semibold tabular-nums"
        style={{ color: color ?? "var(--color-text-primary)" }}
      >
        {value}
      </span>
      <span className="text-[10px] text-[var(--color-text-muted)]">
        {label}
      </span>
    </div>
  );
}

const ATTENTION_RANK: Record<AttentionGroup, number> = {
  respond: 0,
  review: 1,
  merge: 2,
  pending: 3,
  working: 4,
  done: 5,
};

const LANE_META: Array<{ id: AttentionGroup; title: string; color: string }> = [
  { id: "respond", title: "Respond", color: "var(--color-status-error)" },
  { id: "review", title: "Review", color: "var(--color-accent-orange)" },
  { id: "merge", title: "Merge", color: "var(--color-status-ready)" },
  { id: "pending", title: "Pending", color: "var(--color-status-attention)" },
  { id: "working", title: "Working", color: "var(--color-status-working)" },
  { id: "done", title: "Done", color: "var(--color-text-muted)" },
];

function attentionRank(session: DashboardSession): number {
  const level = getAttentionLevel(session) as AttentionGroup;
  return ATTENTION_RANK[level] ?? 99;
}

function parseEstimatedCost(session: DashboardSession): number {
  const raw = session.metadata["cost"];
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { estimatedCostUsd?: number; totalUSD?: number };
    return parsed.estimatedCostUsd ?? parsed.totalUSD ?? 0;
  } catch {
    return 0;
  }
}

function LaneColumn({
  title,
  color,
  count,
  children,
}: {
  title: string;
  color: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="w-[360px] shrink-0 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <h2 className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
        <span className="ml-auto rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">{count}</span>
      </div>
      {children}
    </section>
  );
}
