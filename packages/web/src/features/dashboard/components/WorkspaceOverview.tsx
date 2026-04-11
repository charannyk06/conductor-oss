"use client";

import { useMemo } from "react";
import {
  FolderGit2,
  FolderKanban,
  GitBranch,
  Layers3,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { APP_SURFACE_SCROLL_CLASS_NAME } from "@/components/sessions/sessionMobileScroll";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import type { ConfigProject } from "@/hooks/useConfig";
import { SessionCard } from "@/components/SessionCard";

interface WorkspaceOverviewProps {
  projects: ConfigProject[];
  sessions: DashboardSession[];
  onCreateWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
}

function selectRecentSessions(sessions: DashboardSession[], limit: number): DashboardSession[] {
  const recent: DashboardSession[] = [];

  for (const session of sessions) {
    let insertAt = recent.length;
    while (insertAt > 0 && recent[insertAt - 1]!.lastActivityAt.localeCompare(session.lastActivityAt) < 0) {
      insertAt -= 1;
    }

    if (insertAt >= limit) {
      continue;
    }

    recent.splice(insertAt, 0, session);
    if (recent.length > limit) {
      recent.pop();
    }
  }

  return recent;
}

export function WorkspaceOverview({
  projects,
  sessions,
  onCreateWorkspace,
  onSelectSession,
}: WorkspaceOverviewProps) {
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.status !== "archived"),
    [sessions],
  );

  const recentSessions = useMemo(() => {
    return selectRecentSessions(visibleSessions, Math.max(visibleSessions.length, 12));
  }, [visibleSessions]);

  const sessionStats = useMemo(() => {
    let active = 0;
    let attention = 0;
    let merge = 0;

    for (const session of visibleSessions) {
      const level = getAttentionLevel(session);
      if (level !== "done") {
        active += 1;
      }
      if (level === "merge") {
        merge += 1;
        attention += 1;
      } else if (level === "respond" || level === "review") {
        attention += 1;
      }
    }

    return { active, attention, merge };
  }, [visibleSessions]);
  const showWelcomeState = projects.length === 0 && visibleSessions.length === 0;

  const statCards = [
    { label: "Projects", value: String(projects.length), icon: FolderGit2, caption: "Linked workspaces" },
    { label: "Active sessions", value: String(sessionStats.active), icon: Layers3, caption: "Agent sessions in progress" },
    { label: "Need attention", value: String(sessionStats.attention), icon: Sparkles, caption: "Awaiting review or input" },
    { label: "Merge ready", value: String(sessionStats.merge), icon: GitBranch, caption: "Cleared to land" },
  ];

  if (showWelcomeState) {
    return (
      <div className={`flex h-full min-h-0 w-full flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))] ${APP_SURFACE_SCROLL_CLASS_NAME}`}>
        <div className="mx-auto flex h-full min-h-0 w-full max-w-[1200px] flex-1 flex-col px-3 py-3 sm:px-4 sm:py-4">
          <div className="mb-4 flex justify-end">
            <Button variant="outline" size="md" onClick={onCreateWorkspace}>
              Add workspace
            </Button>
          </div>

          <div className="flex flex-1 items-center justify-center">
            <Card className="w-full max-w-[880px] border-[var(--vk-border)] bg-[color:color-mix(in_srgb,var(--vk-bg-panel)_88%,transparent)]">
              <CardContent className="flex flex-col items-center px-6 py-12 text-center sm:px-10 sm:py-16">
                <span className="inline-flex h-14 w-14 items-center justify-center rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
                  <FolderKanban className="h-6 w-6" />
                </span>
                <p className="mt-5 text-[11px] uppercase tracking-[0.14em] text-[var(--vk-text-muted)]">
                  Frontend Control Surface
                </p>
                <h1 className="mt-3 max-w-[14ch] text-[30px] font-semibold leading-[1.02] tracking-[-0.05em] text-[var(--vk-text-strong)] sm:text-[44px]">
                  Operate workspaces, sessions, and agents from one surface.
                </h1>
                <p className="mt-4 max-w-[560px] text-[14px] leading-7 text-[var(--vk-text-muted)] sm:text-[15px]">
                  Start by linking a workspace. Once a project is connected, this page will show active sessions
                  and recent work without sending you through an empty composer first.
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                  <Button variant="primary" size="md" onClick={onCreateWorkspace}>
                    Add workspace
                  </Button>
                  <div className="inline-flex rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                    0 projects · 0 active sessions
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 w-full flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))] ${APP_SURFACE_SCROLL_CLASS_NAME}`}>
      <div className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
              Frontend Control Surface
            </p>
            <h1 className="mt-1 text-[24px] font-semibold leading-[1.05] tracking-[-0.04em] text-[var(--vk-text-strong)] sm:text-[30px]">
              Operate workspaces, sessions, and agents from one surface.
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-6 text-[var(--vk-text-muted)]">
              The workspace entrypoint now exposes status and recent activity without forcing you into a blank composer first.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="md" onClick={onCreateWorkspace}>
              Add workspace
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {statCards.map(({ label, value, icon: Icon, caption }) => (
            <Card
              key={label}
              className="bg-[color:color-mix(in_srgb,var(--vk-bg-panel)_86%,transparent)] [content-visibility:auto] [contain-intrinsic-size:104px]"
            >
              <CardContent className="flex items-center gap-3 py-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">{label}</p>
                  <p className="mt-1 text-[22px] font-semibold text-[var(--vk-text-strong)]">{value}</p>
                  <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">{caption}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex min-h-0 w-full flex-1">
          <Card className="flex min-h-0 w-full flex-1 flex-col">
            <CardHeader className="justify-between">
              <div>
                <p className="text-[14px] font-semibold text-[var(--vk-text-strong)]">Recent sessions</p>
                <p className="text-[12px] text-[var(--vk-text-muted)]">
                  Jump back into active work without hunting through the sidebar.
                </p>
              </div>
              <Badge variant="outline">{visibleSessions.length}</Badge>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {recentSessions.length === 0 ? (
                <div className="flex h-full min-h-[180px] items-center justify-center rounded-[6px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 text-center text-[13px] text-[var(--vk-text-muted)]">
                  No sessions yet. Create or open a workspace to start work.
                </div>
              ) : recentSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onSelect={onSelectSession}
                />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
