"use client";

import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DashboardSession } from "@/lib/types";
import { Sidebar } from "@/components/layout/Sidebar";

interface ProjectItem {
  id: string;
  description?: string | null;
}

interface WorkspaceSidebarPanelProps {
  orgLabel: string;
  projects: ProjectItem[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  sessions: DashboardSession[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateWorkspace: () => void;
}

export function WorkspaceSidebarPanel({
  orgLabel,
  projects,
  selectedProjectId,
  onSelectProject,
  sessions,
  selectedSessionId,
  onSelectSession,
  onCreateWorkspace,
}: WorkspaceSidebarPanelProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--vk-bg-panel)]">
      <section className="flex h-[57px] items-center border-b border-[var(--vk-border)] px-4">
        <p className="truncate text-[15px] font-medium leading-[21px] text-[var(--vk-text-strong)]">
            {orgLabel}
        </p>
        <button
          type="button"
          onClick={onCreateWorkspace}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
          aria-label="Create workspace"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New</span>
        </button>
      </section>

      <section className="border-b border-[var(--vk-border)] pb-2 pt-1.5">
        <div className="flex h-[28px] items-center px-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">Projects</p>
        </div>
        <div className="max-h-[260px] overflow-y-auto px-2">
          {projects.map((project) => {
            const selected = selectedProjectId === project.id;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  "mb-1.5 flex w-full items-center gap-3 rounded-[6px] px-3 py-2.5 text-left text-[14px] leading-[21px]",
                  selected
                    ? "bg-[var(--vk-bg-hover)] text-[var(--vk-text-normal)]"
                    : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]",
                )}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[#3c83f6]" />
                <span className="truncate">{project.id}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col pt-1.5">
        <Sidebar
          sessions={sessions}
          selectedId={selectedSessionId}
          onSelect={onSelectSession}
          onCreateWorkspace={onCreateWorkspace}
          showHeader={false}
        />
      </section>
    </div>
  );
}
