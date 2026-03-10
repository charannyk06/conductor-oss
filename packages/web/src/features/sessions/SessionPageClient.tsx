"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useResponsiveSidebarStateWithOptions } from "@/hooks/useResponsiveSidebarState";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { WorkspaceSidebarPanel } from "@/components/layout/WorkspaceSidebarPanel";
import { SessionDetail } from "@/components/sessions/SessionDetail";
import { useConfig } from "@/hooks/useConfig";
import { useSession } from "@/hooks/useSession";
import { useSessions } from "@/hooks/useSessions";
import type { DashboardSession } from "@/lib/types";

export default function SessionPageClient() {
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

  const topBarTitle = useMemo(() => {
    if (currentSession) {
      return [currentSession.projectId, currentSession.branch].filter(Boolean).join(" \u00b7 ");
    }

    if (selectedProjectId) {
      return selectedProjectId;
    }

    return "Session";
  }, [currentSession, selectedProjectId]);

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
          onSelectSession={(sessionId) => {
            router.push(`/sessions/${encodeURIComponent(sessionId)}`);
            closeSidebarOnMobile();
          }}
          onArchiveSession={handleArchiveSession}
          onCreateWorkspace={() => {
            router.push("/");
          }}
        />
      ) : null}
    >
      <TopBar
        title={topBarTitle}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <SessionDetail key={params.id} sessionId={params.id} initialSession={currentSession} />
      </div>
    </AppShell>
  );
}
