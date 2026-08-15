"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  GitCompare,
  Globe,
  LayoutDashboard,
  Puzzle,
  PanelLeftOpen,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useSession } from "@/hooks/useSession";
import { getDisplaySessionId } from "@/lib/bridgeSessionIds";
import { getDefaultSessionPrimaryTab, isProjectDispatcherSession } from "@/lib/sessionKinds";
import type { DashboardSession } from "@/lib/types";
import { SessionOverview } from "./SessionOverview";
import { SessionProjectOpenMenu } from "./SessionProjectOpenMenu";
import type { TerminalInsertRequest } from "./terminalInsert";
import { shouldAutoOpenPreviewTab } from "./sessionDetailBehavior";
import { getSessionDetailRootClassName } from "./sessionMobileScroll";
import {
  loadSessionTerminalComponent,
  SESSION_TERMINAL_IMPLEMENTATION,
} from "./sessionTerminalRouting";

const SessionTerminal = dynamic(loadSessionTerminalComponent, {
  loading: () => (
    <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
      Loading terminal...
    </div>
  ),
});

const SessionPreview = dynamic(
  () => import("./SessionPreview").then((mod) => mod.SessionPreview),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading preview...
      </div>
    ),
  },
);

const SessionDiff = dynamic(
  () => import("./SessionDiff").then((mod) => mod.SessionDiff),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading review…
      </div>
    ),
    ssr: false,
  },
);

const SessionSkills = dynamic(
  () => import("./SessionSkills").then((mod) => mod.SessionSkills),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading skills...
      </div>
    ),
  },
);

const DispatcherPane = dynamic(
  () => import("../dispatcher/DispatcherPane").then((mod) => mod.DispatcherPane),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading dispatcher...
      </div>
    ),
  },
);

interface SessionDetailProps {
  sessionId: string;
  initialSession?: DashboardSession | null;
  bridgeId?: string | null;
  immersiveMobileMode?: boolean;
  active?: boolean;
  suppressPreviewAutoOpen?: boolean;
  onOpenSidebar?: () => void;
}

type SessionTab = "overview" | "diff" | "dispatcher" | "terminal" | "preview" | "skills";

const STANDARD_TAB_PANEL_CLASS_NAME = "min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=active]:relative data-[state=active]:z-10 data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:z-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0";
// Keep terminal-like surfaces painted with opacity only. `visibility:hidden` was causing browser-level
// suspension / blanking on tab switches even though the panels stayed force-mounted.
const PRESERVE_LIVE_SURFACE_TAB_PANEL_CLASS_NAME = "min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=active]:relative data-[state=active]:z-10 data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:z-0 data-[state=inactive]:opacity-0 data-[state=inactive]:select-none";

function resolveSessionTab(
  value: string | null,
  session: Pick<DashboardSession, "metadata"> | null | undefined,
): SessionTab {
  const defaultTab = getDefaultSessionPrimaryTab(session);
  if (value === "overview" || value === "preview" || value === "skills" || value === "diff") {
    return value;
  }
  if (value === "dispatcher") {
    return defaultTab === "dispatcher" ? "dispatcher" : "terminal";
  }
  if (value === "terminal") {
    return defaultTab === "dispatcher" ? "dispatcher" : "terminal";
  }
  return defaultTab;
}

function getCompactSessionStatusLabel(status: string): string {
  switch (status) {
    case "needs_input":
      return "needs input";
    case "working":
      return "working";
    case "running":
      return "running";
    case "spawning":
      return "spawning";
    case "queued":
      return "queued";
    default:
      return status.replace(/[_-]+/g, " ");
  }
}

function getStatusDotClass(status: string): string {
  switch (status) {
    case "working":
    case "running":
      return "bg-amber-400";
    case "needs_input":
      return "bg-blue-400";
    case "spawning":
    case "queued":
      return "bg-gray-400";
    case "done":
      return "bg-emerald-400";
    case "errored":
      return "bg-red-400";
    case "stuck":
      return "bg-[var(--vk-accent)]";
    case "terminated":
    case "killed":
      return "bg-gray-500";
    default:
      return "bg-gray-400";
  }
}

function isStatusAnimated(status: string): boolean {
  return status === "working" || status === "running" || status === "spawning" || status === "queued" || status === "needs_input";
}

export function SessionDetail({
  sessionId,
  initialSession = null,
  bridgeId = null,
  immersiveMobileMode = false,
  active = true,
  suppressPreviewAutoOpen = false,
  onOpenSidebar,
}: SessionDetailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId, initialSession, {
    enabled: active,
    bridgeId,
  });
  const terminalInsertNonceRef = useRef(0);
  const autoPreviewOpenedRef = useRef(false);
  const [pendingTerminalInsert, setPendingTerminalInsert] = useState<TerminalInsertRequest | null>(null);
  const activeTab = useMemo(
    () => resolveSessionTab(searchParams.get("tab"), session),
    [searchParams, session],
  );
  const handleTabChange = useCallback((value: string) => {
    const nextTab = resolveSessionTab(value, session);
    const defaultTab = getDefaultSessionPrimaryTab(session);
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === defaultTab) {
      params.delete("tab");
    } else {
      params.set("tab", nextTab);
    }
    const nextQuery = params.toString();
    const nextUrl = nextQuery.length > 0 ? `${pathname}?${nextQuery}` : pathname;
    router.replace(nextUrl, { scroll: false });
  }, [pathname, router, searchParams, session]);
  useEffect(() => {
    if (!session) {
      return;
    }

    const requestedTab = searchParams.get("tab");
    const resolvedTab = resolveSessionTab(requestedTab, session);
    const defaultTab = getDefaultSessionPrimaryTab(session);
    const canonicalTab = resolvedTab === defaultTab ? null : resolvedTab;
    const currentTab = requestedTab?.trim() ? requestedTab : null;

    if (currentTab === canonicalTab) {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    if (canonicalTab) {
      params.set("tab", canonicalTab);
    } else {
      params.delete("tab");
    }
    const nextQuery = params.toString();
    const nextUrl = nextQuery.length > 0 ? `${pathname}?${nextQuery}` : pathname;
    router.replace(nextUrl, { scroll: false });
  }, [pathname, router, searchParams, session]);
  const queueTerminalInsert = useCallback((request: Omit<TerminalInsertRequest, "nonce">) => {
    terminalInsertNonceRef.current += 1;
    setPendingTerminalInsert({
      nonce: terminalInsertNonceRef.current,
      ...request,
    });
  }, []);
  useEffect(() => {
    autoPreviewOpenedRef.current = false;
    terminalInsertNonceRef.current = 0;
    setPendingTerminalInsert(null);
  }, [sessionId]);
  const handlePreviewConnectionChange = useCallback((connected: boolean) => {
    if (!shouldAutoOpenPreviewTab({
      active,
      activeTab,
      alreadyOpened: autoPreviewOpenedRef.current,
      connected,
      suppressAutoOpen: suppressPreviewAutoOpen,
    })) {
      return;
    }
    autoPreviewOpenedRef.current = true;
    handleTabChange("preview");
  }, [active, activeTab, handleTabChange, suppressPreviewAutoOpen]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="py-7 text-center text-[13px] text-[var(--text-muted)]">
            Loading session workspace...
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-md border-[color:color-mix(in_srgb,var(--status-error)_45%,transparent)]">
          <CardContent className="py-7 text-center text-[13px] text-[var(--status-error)]">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="py-7 text-center text-[13px] text-[var(--text-muted)]">
            Session not found
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = typeof session.status === "string" ? session.status : "unknown";
  const dispatcherSession = isProjectDispatcherSession(session);
  const compactStatusLabel = getCompactSessionStatusLabel(status);
  const statusDotClass = getStatusDotClass(status);
  const statusAnimated = isStatusAnimated(status);
  const showProjectOpenMenu = status !== "queued" && status !== "spawning";
  const immersiveTerminalActive = active && immersiveMobileMode && activeTab === "terminal";
  const previewTabActive = active && activeTab === "preview";
  const reviewTabActive = active && activeTab === "diff";
  const tabTriggerClass = "min-h-11 gap-1.5 px-2.5 text-[12px] sm:min-h-[34px] sm:px-3";
  const compactDisplaySessionId = getDisplaySessionId(sessionId).slice(0, 7);

  const sessionTabs = (
    <TabsList className="flex w-full overflow-x-auto sm:w-fit sm:inline-flex">
      <TabsTrigger value="overview" className={tabTriggerClass}>
        <LayoutDashboard className="h-3.5 w-3.5" />
        Overview
      </TabsTrigger>
      <TabsTrigger value="diff" className={tabTriggerClass}>
        <GitCompare className="h-3.5 w-3.5" />
        Review
      </TabsTrigger>
      {dispatcherSession ? (
        <TabsTrigger value="dispatcher" className={tabTriggerClass}>
          <Sparkles className="h-3.5 w-3.5" />
          Dispatcher
        </TabsTrigger>
      ) : (
        <TabsTrigger value="terminal" className={tabTriggerClass}>
          <SquareTerminal className="h-3.5 w-3.5" />
          Terminal
        </TabsTrigger>
      )}
      <TabsTrigger value="preview" className={tabTriggerClass}>
        <Globe className="h-3.5 w-3.5" />
        Preview
      </TabsTrigger>
      <TabsTrigger value="skills" className={tabTriggerClass}>
        <Puzzle className="h-3.5 w-3.5" />
        Skills
      </TabsTrigger>
    </TabsList>
  );

  return (
    <div
      className={getSessionDetailRootClassName(immersiveTerminalActive)}
      data-conductor-session-terminal={SESSION_TERMINAL_IMPLEMENTATION}
    >
      <Tabs
        key={sessionId}
        value={activeTab}
        onValueChange={handleTabChange}
        className={immersiveTerminalActive ? "flex min-h-0 min-w-0 w-full flex-1 flex-col gap-0 p-0" : "flex min-h-0 min-w-0 w-full flex-1 flex-col gap-1 p-1 lg:gap-2 lg:p-3"}
      >
        {immersiveTerminalActive ? (
          <div className="flex shrink-0 flex-col border-b border-white/10 bg-[#0d0908]">
            <div className="flex h-10 items-center gap-2 px-2">
              {onOpenSidebar ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
                  onClick={onOpenSidebar}
                  aria-label="Open workspace panel"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </Button>
              ) : null}
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}${statusAnimated ? " animate-pulse" : ""}`} />
                <span className="text-[12px] font-medium text-[#efe8e1]">{compactStatusLabel}</span>
                <span className="font-mono text-[10px] text-[#8e847d]">· {compactDisplaySessionId}</span>
              </div>
              {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} bridgeId={session.bridgeId ?? null} /> : null}
            </div>
            <div className="px-1.5 pb-1.5">
              {sessionTabs}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 sm:flex-nowrap">
            {sessionTabs}
            <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
              <div className="flex items-center gap-1.5">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}${statusAnimated ? " animate-pulse" : ""}`} />
                <span className="text-[11px] text-[var(--vk-text-muted)]">{compactStatusLabel}</span>
                <span className="hidden font-mono text-[10px] text-[var(--vk-text-muted)] sm:inline">· {compactDisplaySessionId}</span>
              </div>
              {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} bridgeId={session.bridgeId ?? null} /> : null}
            </div>
          </div>
        )}

        <div className="relative min-h-0 min-w-0 h-0 flex-1 overflow-hidden">
          <TabsContent value="overview" className={STANDARD_TAB_PANEL_CLASS_NAME}>
            <SessionOverview session={session} sessionId={sessionId} active={active && activeTab === "overview"} />
          </TabsContent>

          <TabsContent
            value="diff"
            className={`${STANDARD_TAB_PANEL_CLASS_NAME} flex min-h-0 flex-col`}
          >
            <SessionDiff sessionId={sessionId} active={reviewTabActive} />
          </TabsContent>

          {dispatcherSession ? (
            <TabsContent
              value="dispatcher"
              forceMount
              className={PRESERVE_LIVE_SURFACE_TAB_PANEL_CLASS_NAME}
            >
              <DispatcherPane
                thread={session}
                projectId={session.projectId}
                bridgeId={session.bridgeId ?? bridgeId}
                active={active && activeTab === "dispatcher"}
                className="h-full w-full border-0 xl:w-full"
              />
            </TabsContent>
          ) : (
            <TabsContent
              value="terminal"
              forceMount
              className={immersiveTerminalActive
                ? `flex min-h-0 h-full min-w-0 w-full flex-col overflow-hidden bg-[#060404] ${PRESERVE_LIVE_SURFACE_TAB_PANEL_CLASS_NAME}`
                : `flex min-h-0 h-full min-w-0 w-full flex-col overflow-hidden bg-transparent ${PRESERVE_LIVE_SURFACE_TAB_PANEL_CLASS_NAME}`}
            >
              <SessionTerminal
                sessionId={sessionId}
                projectId={session.projectId}
                bridgeId={session.bridgeId ?? null}
                sessionState={status}
                runtimeMode={session.metadata["runtimeMode"]?.trim() ?? null}
                pendingInsert={pendingTerminalInsert}
                immersiveMobileMode={immersiveTerminalActive}
                panelVisible={active && activeTab === "terminal"}
                onPendingInsertConsumed={() => setPendingTerminalInsert(null)}
              />
            </TabsContent>
          )}
          <TabsContent
            value="preview"
            forceMount
            className={`${PRESERVE_LIVE_SURFACE_TAB_PANEL_CLASS_NAME} flex min-h-0 flex-col`}
          >
            <SessionPreview
              key={sessionId}
              sessionId={sessionId}
              active={previewTabActive}
              onQueueTerminalInsert={queueTerminalInsert}
              onConnectionChange={handlePreviewConnectionChange}
            />
          </TabsContent>

          <TabsContent
            value="skills"
            className={STANDARD_TAB_PANEL_CLASS_NAME}
          >
            <SessionSkills
              session={session}
              sessionId={sessionId}
              active={active && activeTab === "skills"}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
