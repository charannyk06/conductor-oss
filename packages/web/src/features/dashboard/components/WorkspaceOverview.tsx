"use client";

import { useMemo } from "react";
import {
  ArrowRight,
  FolderGit2,
  FolderKanban,
  GitBranch,
  Layers3,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import type { ConfigProject } from "@/hooks/useConfig";

type WorkspaceView = "chat" | "board";

interface WorkspaceOverviewProps {
  projects: ConfigProject[];
  sessions: DashboardSession[];
  selectedProjectId: string | null;
  workspaceView: WorkspaceView;
  agentCount: number;
  onCreateWorkspace: () => void;
  onSelectProject: (projectId: string | null) => void;
  onSelectSession: (sessionId: string) => void;
  onShowView: (view: WorkspaceView) => void;
}

type ProjectSummary = {
  id: string;
  description: string | null;
  branch: string;
  totalSessions: number;
  activeSessions: number;
};

function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return "Updated now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

function getStatusTone(session: DashboardSession): "success" | "warning" | "error" | "outline" {
  const level = getAttentionLevel(session);
  if (level === "merge") return "success";
  if (level === "review" || level === "respond") return "warning";
  if (session.status === "errored" || session.status === "killed") return "error";
  return "outline";
}

function getStatusLabel(session: DashboardSession): string {
  const level = getAttentionLevel(session);
  if (level === "merge") return "Ready";
  if (level === "respond") return "Needs input";
  if (level === "review") return "Review";
  if (level === "pending") return "Pending";
  if (level === "done") return "Done";
  return "Running";
}

export function WorkspaceOverview({
  projects,
  sessions,
  selectedProjectId,
  workspaceView,
  agentCount,
  onCreateWorkspace,
  onSelectProject,
  onSelectSession,
  onShowView,
}: WorkspaceOverviewProps) {
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.status !== "archived"),
    [sessions],
  );

  const projectSummaries = useMemo<ProjectSummary[]>(() => {
    return projects
      .map((project) => {
        const projectSessions = visibleSessions.filter((session) => session.projectId === project.id);
        const activeSessions = projectSessions.filter((session) => getAttentionLevel(session) !== "done").length;

        return {
          id: project.id,
          description: project.description,
          branch: project.defaultBranch || "main",
          totalSessions: projectSessions.length,
          activeSessions,
        };
      })
      .sort((left, right) => right.activeSessions - left.activeSessions || right.totalSessions - left.totalSessions || left.id.localeCompare(right.id));
  }, [projects, visibleSessions]);

  const recentSessions = useMemo(() => {
    return [...visibleSessions]
      .sort((left, right) => new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime())
      .slice(0, 5);
  }, [visibleSessions]);

  const activeSessions = visibleSessions.filter((session) => getAttentionLevel(session) !== "done").length;
  const needsAttention = visibleSessions.filter((session) => {
    const level = getAttentionLevel(session);
    return level === "merge" || level === "respond" || level === "review";
  }).length;
  const mergeReady = visibleSessions.filter((session) => getAttentionLevel(session) === "merge").length;
  const selectedProject = projectSummaries.find((project) => project.id === selectedProjectId) ?? null;
  const showWelcomeState = projects.length === 0 && visibleSessions.length === 0;

  const statCards = [
    { label: "Projects", value: String(projects.length), icon: FolderGit2 },
    { label: "Active sessions", value: String(activeSessions), icon: Layers3 },
    { label: "Need attention", value: String(needsAttention), icon: Sparkles },
    { label: "Merge ready", value: String(mergeReady), icon: GitBranch },
  ];

  if (showWelcomeState) {
    return (
      <div className="flex min-h-full flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))]">
        <div className="mx-auto flex min-h-full w-full max-w-[1200px] flex-1 flex-col px-3 py-3 sm:px-4 sm:py-4">
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
                  Start by linking a workspace. Once a project is connected, this page will show active sessions,
                  recent work, and project focus without sending you through an empty composer first.
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
    <div className="flex min-h-full flex-col border-b border-[var(--vk-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))]">
      <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-1 flex-col gap-4 px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
              Frontend Control Surface
            </p>
            <h1 className="mt-1 text-[24px] font-semibold leading-[1.05] tracking-[-0.04em] text-[var(--vk-text-strong)] sm:text-[30px]">
              Operate workspaces, sessions, and agents from one surface.
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-6 text-[var(--vk-text-muted)]">
              The current design language stays intact, but the workspace entrypoint now exposes status, recent activity,
              and project context without forcing you into a blank composer first.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-[6px] border border-[var(--vk-border)] p-1">
              <button
                type="button"
                onClick={() => onShowView("chat")}
                className={`min-h-[32px] rounded-[4px] px-3 text-[13px] ${
                  workspaceView === "chat"
                    ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                    : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                }`}
              >
                Chat launchpad
              </button>
              <button
                type="button"
                onClick={() => onShowView("board")}
                className={`min-h-[32px] rounded-[4px] px-3 text-[13px] ${
                  workspaceView === "board"
                    ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                    : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                }`}
              >
                Board view
              </button>
            </div>

            <Button variant="outline" size="md" onClick={onCreateWorkspace}>
              Add workspace
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {statCards.map(({ label, value, icon: Icon }) => (
            <Card key={label} className="bg-[color:color-mix(in_srgb,var(--vk-bg-panel)_86%,transparent)]">
              <CardContent className="flex items-center gap-3 py-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">{label}</p>
                  <p className="mt-1 text-[22px] font-semibold text-[var(--vk-text-strong)]">{value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid flex-1 gap-3 xl:grid-cols-[1.35fr_0.95fr]">
          <Card className="flex h-full min-h-[280px] flex-col">
            <CardHeader className="justify-between">
              <div>
                <p className="text-[14px] font-semibold text-[var(--vk-text-strong)]">Recent sessions</p>
                <p className="text-[12px] text-[var(--vk-text-muted)]">Jump back into active work without hunting through the sidebar.</p>
              </div>
              <Badge variant="outline">{visibleSessions.length}</Badge>
            </CardHeader>
            <CardContent className="flex-1 space-y-2">
              {recentSessions.length === 0 ? (
                <div className="flex h-full min-h-[180px] items-center justify-center rounded-[6px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 text-center text-[13px] text-[var(--vk-text-muted)]">
                  No sessions yet. Create or open a workspace to start work.
                </div>
              ) : recentSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSession(session.id)}
                  className="flex w-full items-center gap-3 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3 text-left transition-colors hover:bg-[var(--vk-bg-hover)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[14px] font-medium text-[var(--vk-text-strong)]">
                        {session.summary?.trim() || session.projectId}
                      </p>
                      <Badge variant={getStatusTone(session)}>{getStatusLabel(session)}</Badge>
                    </div>
                    <p className="mt-1 truncate text-[12px] text-[var(--vk-text-muted)]">
                      {session.projectId}
                      {session.branch ? ` · ${session.branch}` : ""}
                      {session.issueId ? ` · ${session.issueId}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[11px] text-[var(--vk-text-muted)]">{formatRelativeTime(session.lastActivityAt)}</p>
                    <ArrowRight className="ml-auto mt-2 h-4 w-4 text-[var(--vk-text-muted)]" />
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card className="flex h-full min-h-[280px] flex-col">
            <CardHeader className="justify-between">
              <div>
                <p className="text-[14px] font-semibold text-[var(--vk-text-strong)]">Project focus</p>
                <p className="text-[12px] text-[var(--vk-text-muted)]">
                  {selectedProject ? `Selected: ${selectedProject.id}` : "Select a project to scope new work."}
                </p>
              </div>
              <Badge variant="outline">{agentCount} agents</Badge>
            </CardHeader>
            <CardContent className="flex-1 space-y-2">
              <button
                type="button"
                onClick={() => onSelectProject(null)}
                className={`flex w-full items-center justify-between rounded-[6px] border px-3 py-2 text-left ${
                  selectedProjectId === null
                    ? "border-[var(--vk-border)] bg-[var(--vk-bg-hover)] text-[var(--vk-text-strong)]"
                    : "border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                }`}
              >
                <span>All projects</span>
                <Badge variant="outline">{visibleSessions.length}</Badge>
              </button>

              {projectSummaries.length === 0 ? (
                <div className="flex h-full min-h-[180px] items-center justify-center rounded-[6px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 text-center text-[13px] text-[var(--vk-text-muted)]">
                  No configured projects yet.
                </div>
              ) : projectSummaries.slice(0, 6).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  className={`flex w-full items-start justify-between gap-3 rounded-[6px] border px-3 py-2.5 text-left ${
                    selectedProjectId === project.id
                      ? "border-[var(--vk-border)] bg-[var(--vk-bg-hover)]"
                      : "border-[var(--vk-border)] bg-[var(--vk-bg-main)] hover:bg-[var(--vk-bg-hover)]"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--vk-text-strong)]">{project.id}</p>
                    <p className="truncate text-[12px] text-[var(--vk-text-muted)]">
                      {project.description?.trim() || `Default branch: ${project.branch}`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[12px] text-[var(--vk-text-strong)]">{project.activeSessions} active</p>
                    <p className="text-[11px] text-[var(--vk-text-muted)]">{project.totalSessions} total</p>
                  </div>
                </button>
              ))}

              {selectedProject ? (
                <div className="rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3">
                  <div className="flex items-center gap-2">
                    <FolderKanban className="h-4 w-4 text-[var(--vk-text-muted)]" />
                    <p className="text-[13px] font-medium text-[var(--vk-text-strong)]">{selectedProject.id}</p>
                  </div>
                  <p className="mt-2 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                    {selectedProject.description?.trim() || "This project is ready to launch work from chat or board mode."}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
