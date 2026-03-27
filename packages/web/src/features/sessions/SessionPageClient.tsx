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
import {
  decodeBridgeSessionId,
  encodeBridgeSessionId,
  normalizeBridgeId,
} from "@/lib/bridgeSessionIds";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { buildAllProjectsHref, buildSessionHref } from "@/lib/dashboardHref";
import { getDefaultSessionPrimaryTab } from "@/lib/sessionKinds";
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
  const queryBridgeId = useMemo(
    () => normalizeBridgeId(searchParams.get("bridge") ?? searchParams.get("bridgeId")),
    [searchParams],
  );
  const requestedBridgeId = routeBridgeId ?? queryBridgeId;
  const canonicalSessionId = useMemo(
    () => requestedBridgeId && !routeBridgeId
      ? encodeBridgeSessionId(requestedBridgeId, params.id)
      : params.id,
    [params.id, requestedBridgeId, routeBridgeId],
  );
  const scopeReady = !requiresPairedDeviceScope || Boolean(requestedBridgeId);
  const { session: currentSession } = useSession(canonicalSessionId, null, {
    bridgeId: requestedBridgeId,
    enabled: scopeReady,
  });
  const effectiveBridgeId = currentSession?.bridgeId ?? requestedBridgeId;
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
    if (tab === "dispatcher") {
      return false;
    }
    if (tab === "terminal") {
      return getDefaultSessionPrimaryTab(currentSession) === "terminal";
    }
    return tab === null && getDefaultSessionPrimaryTab(currentSession) === "terminal";
  }, [currentSession, searchParams]);
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
    if (canonicalSessionId === params.id) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("bridge");
    nextParams.delete("bridgeId");
    const nextQuery = nextParams.toString();
    const nextUrl = `/sessions/${encodeURIComponent(canonicalSessionId)}${nextQuery.length > 0 ? `?${nextQuery}` : ""}`;
    router.replace(nextUrl, { scroll: false });
  }, [canonicalSessionId, params.id, router, searchParams]);

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
    let res = await fetch(withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, effectiveBridgeId), {
      method: "POST",
    });
    let data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;

    if (res.status === 404) {
      res = await fetch(withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, effectiveBridgeId), {
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

    if (sessionId === canonicalSessionId) {
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
          selectedSessionId={canonicalSessionId}
          onSelectSession={(sessionId, options) => {
            const matchedSession = dashboardSessions.find((candidate) => candidate.id === sessionId) ?? null;
            router.push(buildSessionHref(sessionId, {
              bridgeId: effectiveBridgeId,
              tab: options?.tab ?? getDefaultSessionPrimaryTab(matchedSession),
            }));
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
          key={canonicalSessionId}
          sessionId={canonicalSessionId}
          initialSession={currentSession}
          bridgeId={effectiveBridgeId}
          immersiveMobileMode={immersiveTerminalMode}
          onOpenSidebar={toggleSidebar}
        />
      </div>
    </AppShell>
  );
}
