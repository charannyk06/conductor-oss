"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useResponsiveSidebarStateWithOptions } from "@/hooks/useResponsiveSidebarState";
import { AppShell } from "@/components/layout/AppShell";
import { WorkspaceSidebarPanel } from "@/components/layout/WorkspaceSidebarPanel";
import { SessionDetail } from "@/components/sessions/SessionDetail";
import { useConfig } from "@/hooks/useConfig";
import { useSession } from "@/hooks/useSession";
import { useSessions } from "@/hooks/useSessions";
import type { DashboardSession } from "@/lib/types";

export function SessionPageClient() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { projects } = useConfig();
  const { session: currentSession } = useSession(params.id);
  const {
    mobileSidebarOpen,
    desktopSidebarOpen,
    toggleSidebar,
    closeSidebarOnMobile,
  } = useResponsiveSidebarStateWithOptions({ initialDesktopOpen: false });
  const sidebarVisible = mobileSidebarOpen || desktopSidebarOpen;
  const { sessions, refresh } = useSessions(undefined, { enabled: sidebarVisible });
  const dashboardSessions = sessions as unknown as DashboardSession[];
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>(() => params.id ? [params.id] : []);
  const immersiveTerminalMode = true;

  useEffect(() => {
    if (params.id && !openSessionIds.includes(params.id)) {
      setOpenSessionIds((current) => {
        const next = [...current, params.id];
        // Cap to prevent unbounded memory growth; evict oldest (non-active) entries.
        const MAX_OPEN_SESSIONS = 20;
        if (next.length > MAX_OPEN_SESSIONS) {
          return next.slice(next.length - MAX_OPEN_SESSIONS);
        }
        return next;
      });
    }
  }, [params.id, openSessionIds]);

  useEffect(() => {
    if (currentSession?.projectId) {
      setSelectedProjectId(currentSession.projectId);
      return;
    }
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0]?.id ?? null);
    }
  }, [currentSession?.projectId, projects, selectedProjectId]);

  async function handleArchiveSession(sessionId: string) {
    let res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
      method: "POST",
    });
    let data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;

    if (res.status === 404) {
      res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "archive" }),
      });
      data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
    }

    if (!res.ok) {
      throw new Error(data?.error ?? `Failed to archive session: ${res.status}`);
    }

    setOpenSessionIds((current) => current.filter((id) => id !== sessionId));

    if (sessionId === params.id) {
      router.push("/");
      return;
    }

    await refresh();
  }

  if (!params.id) {
    return (
      <div className="flex h-dvh min-h-[100dvh] items-center justify-center">
        <span className="text-[13px] text-[var(--text-muted)]">No session ID provided</span>
      </div>
    );
  }

  return (
    <AppShell
      mobileSidebarOpen={mobileSidebarOpen}
      desktopSidebarOpen={desktopSidebarOpen}
      onToggleSidebar={toggleSidebar}
      sidebar={sidebarVisible ? (
        <WorkspaceSidebarPanel
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(projectId) => {
            if (projectId === null) {
              router.push("/");
              return;
            }
            setSelectedProjectId(projectId);
          }}
          sessions={dashboardSessions}
          selectedSessionId={params.id}
          onSelectSession={(sessionId, options) => {
            const paramsUrl = new URLSearchParams();
            if (options?.tab) {
              paramsUrl.set("tab", options.tab);
            }
            const query = paramsUrl.toString();
            router.push(query.length > 0
              ? `/sessions/${encodeURIComponent(sessionId)}?${query}`
              : `/sessions/${encodeURIComponent(sessionId)}`);
            closeSidebarOnMobile();
          }}
          onArchiveSession={handleArchiveSession}
          onCreateWorkspace={() => {
            router.push("/");
          }}
        />
      ) : null}
    >
      <div className={`relative flex min-h-0 flex-1 flex-col overflow-clip ${immersiveTerminalMode ? "bg-[#060404]" : ""}`}>
        {openSessionIds.map((sessionId) => {
          const isActive = sessionId === params.id;
          return (
            <div
              key={sessionId}
              className={`absolute inset-0 flex flex-col ${isActive ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none"}`}
            >
              <SessionDetail
                sessionId={sessionId}
                initialSession={isActive ? currentSession : null}
                immersiveShell={immersiveTerminalMode}
                active={isActive}
              />
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
