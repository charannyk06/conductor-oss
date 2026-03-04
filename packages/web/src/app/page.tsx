"use client";

import { useState, useMemo } from "react";
import { Bot, LayoutDashboard } from "lucide-react";
import type { DashboardSession } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { useSessions } from "@/hooks/useSessions";
import { useConfig } from "@/hooks/useConfig";
import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { LayoutEmptyState } from "@/components/layout/EmptyState";
import { SessionDetail } from "@/components/sessions/SessionDetail";
import { AgentGrid } from "@/components/agents/AgentGrid";
import { cn } from "@/lib/cn";

type ActiveTab = "sessions" | "agents";

export default function Home() {
  const { sessions, loading } = useSessions();
  const { config } = useConfig();

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>("sessions");

  // Cast sessions from hook to DashboardSession (API returns full shape)
  const dashboardSessions = sessions as unknown as DashboardSession[];

  const projects = useMemo(() => {
    if (!config?.projects) return [];
    const p = config.projects as Record<string, Record<string, unknown>>;
    return Object.entries(p).map(([id, project]) => ({
      id,
      repo: (project["repo"] as string | undefined) ?? null,
      iconUrl: (project["iconUrl"] as string | undefined) ?? null,
      description: (project["description"] as string | undefined) ?? null,
      agent: (project["agent"] as string | undefined) ?? "claude-code",
    }));
  }, [config]);

  const selectedSession = useMemo(
    () => dashboardSessions.find((s) => s.id === selectedSessionId) ?? null,
    [dashboardSessions, selectedSessionId],
  );

  const stats = useMemo(() => {
    const active = dashboardSessions.filter(
      (s) => getAttentionLevel(s) !== "done",
    );
    const totalCost = dashboardSessions.reduce((sum, s) => {
      try {
        const raw = s.metadata?.["cost"];
        if (!raw) return sum;
        const parsed = JSON.parse(raw) as { estimatedCostUsd?: number; totalUSD?: number };
        return sum + (parsed.estimatedCostUsd ?? parsed.totalUSD ?? 0);
      } catch {
        return sum;
      }
    }, 0);
    return {
      total: dashboardSessions.length,
      active: active.length,
      totalCost,
    };
  }, [dashboardSessions]);

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  return (
    <AppShell
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      sidebar={
        <div className="flex h-full flex-col">
          {/* Tab switcher */}
          <div className="flex border-b border-[var(--color-border-default)]">
            <button
              onClick={() => setActiveTab("sessions")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-2 text-[12px] font-medium transition-colors",
                activeTab === "sessions"
                  ? "border-b-2 border-[var(--color-accent)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
              )}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Sessions
            </button>
            <button
              onClick={() => setActiveTab("agents")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-2 text-[12px] font-medium transition-colors",
                activeTab === "agents"
                  ? "border-b-2 border-[var(--color-accent)] text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
              )}
            >
              <Bot className="h-3.5 w-3.5" />
              Agents
            </button>
          </div>

          {/* Tab content */}
          {activeTab === "sessions" ? (
            <Sidebar
              sessions={dashboardSessions}
              selectedId={selectedSessionId}
              onSelect={setSelectedSessionId}
              projects={projects}
              onToggleSidebar={toggleSidebar}
            />
          ) : (
            <div className="flex-1 overflow-auto p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Configured Agents
              </p>
              <p className="text-[12px] text-[var(--color-text-secondary)]">
                View agents in the main panel.
              </p>
            </div>
          )}
        </div>
      }
    >
      {activeTab === "agents" ? (
        <AgentGrid />
      ) : selectedSessionId ? (
        <div className="flex h-full flex-col">
          <TopBar session={selectedSession} />
          <SessionDetail sessionId={selectedSessionId} />
        </div>
      ) : (
        <LayoutEmptyState
          totalSessions={stats.total}
          activeSessions={stats.active}
          totalCost={stats.totalCost}
        />
      )}
    </AppShell>
  );
}
