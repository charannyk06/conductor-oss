"use client";

import { useMemo, useState } from "react";
import { Search, ChevronDown, ChevronRight, Settings, Bot, Cpu, PanelLeftClose } from "lucide-react";
import type { DashboardSession } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Separator } from "@/components/ui/Separator";
import { RunningDots } from "@/components/ui/RunningDots";

interface ConfigProject {
  id: string;
  repo: string | null;
  iconUrl?: string | null;
  description: string | null;
  agent: string;
}

interface SidebarProps {
  sessions: DashboardSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  projects: ConfigProject[];
  version?: string;
  onToggleSidebar?: () => void;
}

const ATTENTION_COLORS: Record<string, string> = {
  working: "var(--color-status-working)",
  pending: "var(--color-status-attention)",
  review: "var(--color-accent-orange)",
  respond: "var(--color-status-error)",
  merge: "var(--color-status-ready)",
  done: "var(--color-status-done)",
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

function isActiveSession(session: DashboardSession): boolean {
  const level = getAttentionLevel(session);
  return level !== "done";
}

function AgentIcon({ agent }: { agent: string }) {
  const isCpu = agent.toLowerCase().includes("code") || agent.toLowerCase().includes("claude");
  const Icon = isCpu ? Cpu : Bot;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />;
}

export function Sidebar({
  sessions,
  selectedId,
  onSelect,
  projects,
  version,
  onToggleSidebar,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.summary ?? "").toLowerCase().includes(q) ||
        s.projectId.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, DashboardSession[]>();
    for (const s of filtered) {
      const pid = s.projectId || "ungrouped";
      const arr = map.get(pid);
      if (arr) {
        arr.push(s);
      } else {
        map.set(pid, [s]);
      }
    }
    // Sort sessions within each group by lastActivityAt desc
    for (const arr of map.values()) {
      arr.sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      );
    }
    return map;
  }, [filtered]);

  const projectMap = useMemo(() => {
    const m = new Map<string, ConfigProject>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const toggleGroup = (pid: string) => {
    setCollapsed((prev) => ({ ...prev, [pid]: !prev[pid] }));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold tracking-tight text-[var(--color-text-primary)]">
            Conductor
          </span>
          {version && (
            <Badge variant="outline" className="text-[10px]">
              {version}
            </Badge>
          )}
        </div>
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)]"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="w-full bg-transparent text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
          />
        </div>
      </div>

      <Separator />

      {/* Session list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {grouped.size === 0 && (
            <p className="px-4 py-8 text-center text-[12px] text-[var(--color-text-muted)]">
              No sessions found
            </p>
          )}
          {[...grouped.entries()].map(([pid, groupSessions]) => {
            const isCollapsed = collapsed[pid] ?? false;
            const project = projectMap.get(pid);
            const label = project?.id ?? pid;
            const activeCount = groupSessions.filter(isActiveSession).length;

            return (
              <div key={pid}>
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(pid)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  <span className="truncate">{label}</span>
                  {activeCount > 0 && (
                    <span className="ml-auto text-[10px] tabular-nums text-[var(--color-text-muted)]">
                      {activeCount}
                    </span>
                  )}
                </button>

                {/* Session items */}
                {!isCollapsed &&
                  groupSessions.map((session) => {
                    const attention = getAttentionLevel(session);
                    const isSelected = session.id === selectedId;
                    const isRunning = attention === "working";
                    const dotColor = ATTENTION_COLORS[attention] ?? "var(--color-text-muted)";
                    const agentName = session.metadata["agent"] ?? "";

                    return (
                      <button
                        key={session.id}
                        onClick={() => onSelect(session.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors",
                          isSelected
                            ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]/50",
                        )}
                      >
                        {/* Status dot */}
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            isRunning && "animate-pulse",
                          )}
                          style={{ background: dotColor }}
                        />

                        {/* Name + running dots */}
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px]">
                              {session.summary ?? session.id.slice(0, 8)}
                            </span>
                            {isRunning && <RunningDots className="shrink-0" />}
                          </span>
                        </span>

                        {/* Agent icon + time */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          {agentName && <AgentIcon agent={agentName} />}
                          <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
                            {formatAge(session.lastActivityAt)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      <Separator />

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-secondary)]">
          <Settings className="h-4 w-4" />
        </button>
        <span className="text-[11px] text-[var(--color-text-muted)]">Settings</span>
      </div>
    </div>
  );
}
