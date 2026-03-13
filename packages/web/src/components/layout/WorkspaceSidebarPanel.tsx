"use client";

import { memo, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import { Sidebar } from "@/components/layout/Sidebar";
import { Button } from "@/components/ui/Button";

interface ProjectItem {
  id: string;
  description?: string | null;
}

interface WorkspaceSidebarPanelProps {
  projects: ProjectItem[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onUnlinkProject?: (projectId: string) => Promise<void>;
  sessions: DashboardSession[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string, options?: { tab?: "overview" | "preview" | "diff" }) => void;
  onArchiveSession?: (sessionId: string) => Promise<void> | void;
  onCreateWorkspace: () => void;
}

export const WorkspaceSidebarPanel = memo(function WorkspaceSidebarPanel({
  projects,
  selectedProjectId,
  onSelectProject,
  onUnlinkProject,
  sessions,
  selectedSessionId,
  onSelectSession,
  onArchiveSession,
  onCreateWorkspace,
}: WorkspaceSidebarPanelProps) {
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [confirmUnlinkProjectId, setConfirmUnlinkProjectId] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const sessionCountByProject = useMemo(() => {
    const counts = new Map<string, { total: number; active: number }>();

    for (const session of sessions) {
      if (session.status === "archived") continue;
      const current = counts.get(session.projectId) ?? { total: 0, active: 0 };
      current.total += 1;
      if (getAttentionLevel(session) !== "done") {
        current.active += 1;
      }
      counts.set(session.projectId, current);
    }

    return counts;
  }, [sessions]);

  const confirmUnlinkProject = useMemo(
    () => projects.find((project) => project.id === confirmUnlinkProjectId) ?? null,
    [confirmUnlinkProjectId, projects],
  );

  async function handleConfirmUnlink(): Promise<void> {
    if (!onUnlinkProject || !confirmUnlinkProjectId) return;
    setUnlinkingId(confirmUnlinkProjectId);
    setUnlinkError(null);
    try {
      await onUnlinkProject(confirmUnlinkProjectId);
      setConfirmUnlinkProjectId(null);
    } catch (err) {
      setUnlinkError(err instanceof Error ? err.message : "Failed to unlink project.");
    } finally {
      setUnlinkingId(null);
    }
  }

  return (
    <>
      <div className="flex h-full min-h-0 w-full flex-col bg-[var(--vk-bg-panel)]">
        <section className="border-b border-[var(--vk-border)] px-4 py-4">
          <div className="flex justify-center text-center">
            <p className="text-[22px] font-bold leading-none uppercase tracking-[0.32em] text-[var(--vk-text-strong)]">
              Conductor
            </p>
          </div>

          <button
            type="button"
            onClick={onCreateWorkspace}
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1 rounded-[6px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            aria-label="Add workspace"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Workspace</span>
          </button>
        </section>

        <section className="border-b border-[var(--vk-border)] pb-2 pt-1.5">
          <div className="flex h-[28px] items-center px-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">Projects</p>
          </div>
          <div className="max-h-[260px] overflow-y-auto px-2">
            <button
              type="button"
              onClick={() => onSelectProject(null)}
              className={cn(
                "mb-1.5 flex w-full items-center gap-3 rounded-[6px] px-3 py-2.5 text-left text-[14px] leading-[21px]",
                selectedProjectId === null
                  ? "bg-[var(--vk-bg-hover)] text-[var(--vk-text-normal)]"
                  : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]",
              )}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--vk-text-muted)]" />
              <span className="truncate">All projects</span>
              <span className="ml-auto text-[11px] text-[var(--vk-text-muted)]">{projects.length}</span>
            </button>

            {projects.map((project) => {
              const selected = selectedProjectId === project.id;
              const counts = sessionCountByProject.get(project.id) ?? { total: 0, active: 0 };
              const isUnlinking = unlinkingId === project.id;
              return (
                <div
                  key={project.id}
                  className={cn(
                    "group relative mb-1.5 flex items-center rounded-[6px]",
                    selected
                      ? "bg-[var(--vk-bg-hover)]"
                      : "hover:bg-[var(--vk-bg-hover)]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectProject(project.id)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-[14px] leading-[21px]",
                      selected
                        ? "text-[var(--vk-text-normal)]"
                        : "text-[var(--vk-text-muted)]",
                    )}
                  >
                    <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[#3c83f6]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{project.id}</span>
                      {project.description ? (
                        <span className="block truncate text-[11px] text-[var(--vk-text-muted)]">
                          {project.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[11px] text-[var(--vk-text-normal)]">{counts.active} active</span>
                      <span className="block text-[10px] text-[var(--vk-text-muted)]">{counts.total} total</span>
                    </span>
                  </button>
                  {onUnlinkProject && (
                    <button
                      type="button"
                      disabled={isUnlinking}
                      onClick={(e) => {
                        e.stopPropagation();
                        setUnlinkError(null);
                        setConfirmUnlinkProjectId(project.id);
                      }}
                      className="mr-2 inline-flex shrink-0 items-center justify-center rounded-[4px] p-1 text-[var(--vk-text-muted)] hover:bg-[var(--vk-red)]/10 hover:text-[var(--vk-red)] disabled:opacity-50"
                      aria-label={`Unlink ${project.id}`}
                      title="Unlink project"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col pt-1.5">
          <Sidebar
            sessions={sessions}
            selectedId={selectedSessionId}
            onSelect={onSelectSession}
            onArchive={onArchiveSession}
            onCreateWorkspace={onCreateWorkspace}
            showHeader={false}
          />
        </section>
      </div>

      {confirmUnlinkProject && typeof document !== "undefined"
        ? createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4"
            onClick={() => {
              if (unlinkingId) return;
              setConfirmUnlinkProjectId(null);
              setUnlinkError(null);
            }}
          >
            <div
              className="surface-card w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_28px_90px_rgba(0,0,0,0.55)]"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="unlink-project-title"
            >
              <div className="border-b border-[var(--vk-border)] px-4 py-3">
                <h2 id="unlink-project-title" className="text-[17px] font-medium text-[var(--vk-text-strong)]">
                  Unlink Project
                </h2>
                <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                  Remove <span className="font-medium text-[var(--vk-text-normal)]">{confirmUnlinkProject.id}</span> from this workspace configuration.
                </p>
              </div>

              <div className="space-y-3 px-4 py-4">
                <p className="text-[13px] leading-5 text-[var(--vk-text-normal)]">
                  This only removes the project from Conductor. Repository files on disk are not deleted.
                </p>

                {unlinkError ? (
                  <div className="rounded-[var(--radius-md)] border border-[var(--vk-red)]/35 bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
                    {unlinkError}
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setConfirmUnlinkProjectId(null);
                    setUnlinkError(null);
                  }}
                  disabled={unlinkingId !== null}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => void handleConfirmUnlink()}
                  disabled={unlinkingId !== null}
                >
                  {unlinkingId === confirmUnlinkProject.id ? "Unlinking..." : "Unlink Project"}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
        : null}
    </>
  );
});
