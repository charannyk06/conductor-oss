"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { cn } from "@/lib/cn";
import { AgentTileIcon } from "@/components/AgentTileIcon";

interface SidebarProps {
  sessions: DashboardSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateWorkspace?: () => void;
  showHeader?: boolean;
}

interface GroupConfig {
  id: "needs_attention" | "running" | "idle";
  title: string;
}

const GROUPS: GroupConfig[] = [
  { id: "needs_attention", title: "Needs Attention" },
  { id: "running", title: "Running" },
  { id: "idle", title: "Idle" },
];

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function classify(attention: AttentionLevel): GroupConfig["id"] {
  if (attention === "respond" || attention === "review" || attention === "merge") return "needs_attention";
  if (attention === "working") return "running";
  return "idle";
}

function parseCostUsd(session: DashboardSession): string | null {
  const raw = session.metadata?.["cost"];
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { estimatedCostUsd?: number; totalUSD?: number };
    const value = parsed.estimatedCostUsd ?? parsed.totalUSD;
    if (!value || value <= 0) return null;
    return `$${value.toFixed(2)}`;
  } catch {
    return null;
  }
}

function getAttentionColor(level: AttentionLevel): string {
  if (level === "merge") return "var(--vk-green)";
  if (level === "respond") return "var(--vk-red)";
  if (level === "review") return "var(--vk-orange)";
  if (level === "working") return "#4e87f3";
  return "var(--vk-text-muted)";
}

export function Sidebar({
  sessions,
  selectedId,
  onSelect,
  onCreateWorkspace,
  showHeader = true,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<GroupConfig["id"], boolean>>({
    needs_attention: false,
    running: false,
    idle: false,
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();

    return sessions.filter((session) => {
      const summary = session.summary ?? "";
      return (
        session.id.toLowerCase().includes(q) ||
        session.projectId.toLowerCase().includes(q) ||
        summary.toLowerCase().includes(q)
      );
    });
  }, [search, sessions]);

  const grouped = useMemo(() => {
    const result: Record<GroupConfig["id"], DashboardSession[]> = {
      needs_attention: [],
      running: [],
      idle: [],
    };

    for (const session of filtered) {
      result[classify(getAttentionLevel(session))].push(session);
    }

    for (const key of Object.keys(result) as GroupConfig["id"][]) {
      result[key].sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      );
    }

    return result;
  }, [filtered]);

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

      <div className="flex-1 overflow-y-auto">
        {GROUPS.map((group) => {
          const items = grouped[group.id];
          const isCollapsed = collapsed[group.id];

          return (
            <section key={group.id} className="pt-1">
              <button
                type="button"
                className="flex h-8 w-full items-center px-2 text-left"
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
              >
                <span className="text-[16px] text-[var(--vk-text-normal)]">{group.title}</span>
                <span className="ml-auto text-[var(--vk-text-muted)]">
                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </span>
              </button>

              {!isCollapsed && (
                <div>
                  {items.length === 0 && (
                    <p className="px-2 py-1 text-[14px] text-[var(--vk-text-muted)]">No workspaces</p>
                  )}
                  {items.map((session) => {
                    const level = getAttentionLevel(session);
                    const cost = parseCostUsd(session);
                    const isSelected = session.id === selectedId;
                    const agentName = session.metadata["agent"]?.trim() ?? "";

                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => onSelect(session.id)}
                        className={cn(
                          "group flex w-full flex-col px-2 py-1 text-left",
                          isSelected ? "bg-[var(--vk-bg-hover)]" : "hover:bg-[var(--vk-bg-hover)]",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <AgentTileIcon
                            seed={{ label: agentName || "agent" }}
                            className="h-4 w-4"
                          />
                          <p className="truncate text-[14px] text-[var(--vk-text-normal)]">
                            {session.summary ?? session.id}
                          </p>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-[14px]">
                          <span className="text-[var(--vk-text-muted)]">{formatAge(session.lastActivityAt)}</span>
                          {agentName && (
                            <span className="truncate text-[11px] text-[var(--vk-text-muted)]">
                              {agentName}
                            </span>
                          )}
                          {cost && (
                            <span className="ml-auto text-[11px]" style={{ color: getAttentionColor(level) }}>
                              {cost}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

    </div>
  );
}
