"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useResponsiveSidebarStateWithOptions } from "@/hooks/useResponsiveSidebarState";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { BridgeStatusPill } from "@/components/bridge/BridgeStatusPill";
import { WorkspaceSidebarPanel } from "@/components/layout/WorkspaceSidebarPanel";
import { SessionDetail } from "@/components/sessions/SessionDetail";
import { shouldUseCompactTerminalChrome } from "@/components/sessions/sessionTerminalUtils";
import { useConfig } from "@/hooks/useConfig";
import { useNotificationAlerts } from "@/hooks/useNotificationAlerts";
import { usePreferences } from "@/hooks/usePreferences";
import { useSession } from "@/hooks/useSession";
import { useSessions } from "@/hooks/useSessions";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";
import { buildAllProjectsHref } from "@/lib/dashboardHref";
import type { DashboardSession } from "@/lib/types";

export default function SessionPageClient({
  requiresPairedDeviceScope = false,
}: {
  requiresPairedDeviceScope?: boolean;
}) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeBridgeId = useMemo(
    () => decodeBridgeSessionId(params.id)?.bridgeId ?? null,
    [params.id],
  );
  const scopeReady = !requiresPairedDeviceScope || Boolean(routeBridgeId);
  const { session: currentSession } = useSession(params.id, null, {
    bridgeId: routeBridgeId,
    enabled: scopeReady,
  });
  const effectiveBridgeId = currentSession?.bridgeId ?? routeBridgeId;
  const { projects } = useConfig(effectiveBridgeId, { enabled: !requiresPairedDeviceScope || Boolean(effectiveBridgeId) });
  const { preferences, loading: preferencesLoading } = usePreferences(effectiveBridgeId, {
    enabled: !requiresPairedDeviceScope || Boolean(effectiveBridgeId),
  });
  const {
    mobileSidebarOpen,
    desktopSidebarOpen,
    toggleSidebar,
    closeSidebarOnMobile,
  } = useResponsiveSidebarStateWithOptions({ initialDesktopOpen: false });
  const sidebarVisible = mobileSidebarOpen || desktopSidebarOpen;
  const { sessions, refresh } = useSessions(undefined, {
    enabled: sidebarVisible && (!requiresPairedDeviceScope || Boolean(effectiveBridgeId)),
    bridgeId: effectiveBridgeId,
  });
  const dashboardSessions = sessions as unknown as DashboardSession[];
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [compactTerminalChrome, setCompactTerminalChrome] = useState(false);
  const terminalTabActive = useMemo(() => {
    const tab = searchParams.get("tab");
    return (
      tab === null
      || tab === "terminal"
      || (tab !== "overview" && tab !== "preview" && tab !== "skills" && tab !== "chat")
    );
  }, [searchParams]);
  const immersiveTerminalMode = terminalTabActive && compactTerminalChrome;
  const notificationProjectId = currentSession?.projectId ?? null;

  useNotificationAlerts({
    enabled: !preferencesLoading && notificationProjectId !== null,
    projectId: notificationProjectId,
    preferences: preferences?.notifications ?? null,
    bridgeId: effectiveBridgeId,
  });

  const topBarTitle = useMemo(() => {
    if (currentSession) {
      return [currentSession.projectId, currentSession.branch].filter(Boolean).join(" \u00b7 ");
    }

    if (selectedProjectId) {
      return selectedProjectId;
    }

    return "Session";
  }, [currentSession, selectedProjectId]);

  const dashboardRootHref = useMemo(() => {
    return buildAllProjectsHref(effectiveBridgeId);
  }, [effectiveBridgeId]);

  useEffect(() => {
    if (currentSession?.projectId) {
      setSelectedProjectId(currentSession.projectId);
      return;
    }
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0]?.id ?? null);
    }
  }, [currentSession?.projectId, projects, selectedProjectId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)")
      : null;
    const syncCompactTerminalChrome = () => {
      setCompactTerminalChrome(shouldUseCompactTerminalChrome());
    };

    syncCompactTerminalChrome();
    window.addEventListener("resize", syncCompactTerminalChrome);
    mediaQuery?.addEventListener?.("change", syncCompactTerminalChrome);

    return () => {
      window.removeEventListener("resize", syncCompactTerminalChrome);
      mediaQuery?.removeEventListener?.("change", syncCompactTerminalChrome);
    };
  }, []);

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
      router.replace(dashboardRootHref);
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
      hideMobileSidebarToggle={immersiveTerminalMode}
      sidebar={sidebarVisible ? (
        <WorkspaceSidebarPanel
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(projectId) => {
            if (projectId === null) {
              router.push(dashboardRootHref);
              return;
            }
            setSelectedProjectId(projectId);
          }}
          sessions={dashboardSessions}
          selectedSessionId={params.id}
          onSelectSession={(sessionId, options) => {
            const params = new URLSearchParams();
            params.set("tab", options?.tab ?? "terminal");
            router.push(`/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`);
            closeSidebarOnMobile();
          }}
          onArchiveSession={handleArchiveSession}
          onCreateWorkspace={() => {
            router.push(dashboardRootHref);
          }}
        />
      ) : null}
    >
      {immersiveTerminalMode ? null : (
        <TopBar
          title={topBarTitle}
          rightContent={<BridgeStatusPill />}
        />
      )}
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${immersiveTerminalMode ? "bg-[#060404]" : ""}`}>
        <SessionDetail
          key={params.id}
          sessionId={params.id}
          initialSession={currentSession}
          bridgeId={effectiveBridgeId}
          immersiveMobileMode={immersiveTerminalMode}
          onOpenSidebar={toggleSidebar}
        />
      </div>
    </AppShell>
  );
}
