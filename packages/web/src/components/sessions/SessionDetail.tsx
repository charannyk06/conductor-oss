"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  Globe,
  LayoutDashboard,
  Puzzle,
  PanelLeftOpen,
  SquareTerminal,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useSession } from "@/hooks/useSession";
import { getDefaultSessionPrimaryTab, isProjectDispatcherSession } from "@/lib/sessionKinds";
import type { DashboardSession } from "@/lib/types";
import { SessionOverview } from "./SessionOverview";
import { SessionProjectOpenMenu } from "./SessionProjectOpenMenu";
import type { TerminalInsertRequest } from "./terminalInsert";
import { shouldAutoOpenPreviewTab } from "./sessionDetailBehavior";

const SessionTerminal = dynamic(
  () => import("./SessionTerminal").then((mod) => mod.SessionTerminal),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading terminal...
      </div>
    ),
  },
);

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

const SessionChatDock = dynamic(
  () => import("./SessionChatDock").then((mod) => mod.SessionChatDock),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading chat...
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

type SessionTab = "overview" | "chat" | "terminal" | "preview" | "skills";

function resolveSessionTab(
  value: string | null,
  session: Pick<DashboardSession, "metadata"> | null | undefined,
): SessionTab {
  const defaultTab = getDefaultSessionPrimaryTab(session);
  if (value === "overview" || value === "preview" || value === "skills") {
    return value;
  }
  if (value === "chat" || value === "terminal") {
    return "chat";
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
    handleTabChange("chat");
  }, [handleTabChange]);
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
  const previewTabActive = active && activeTab === "preview";
  const tabTriggerClass = "min-h-[38px] gap-1.5 px-2.5 text-[12px] sm:min-h-0 sm:px-3";

  const sessionTabs = (
    <TabsList className="flex w-full overflow-x-auto sm:w-fit sm:inline-flex">
      <TabsTrigger value="overview" className={tabTriggerClass}>
        <LayoutDashboard className="h-3.5 w-3.5" />
        Overview
      </TabsTrigger>
      <TabsTrigger value="chat" className={tabTriggerClass}>
        <Bot className="h-3.5 w-3.5" />
        Chat
      </TabsTrigger>
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
      className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-y-auto overscroll-contain lg:overflow-hidden"
    >
      <Tabs
        key={sessionId}
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-1 p-1 lg:gap-2 lg:p-3"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 sm:flex-nowrap">
          {sessionTabs}
          <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
            <div className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}${statusAnimated ? " animate-pulse" : ""}`} />
              <span className="text-[11px] text-[var(--vk-text-muted)]">{compactStatusLabel}</span>
              <span className="hidden font-mono text-[10px] text-[var(--vk-text-muted)] sm:inline">· {sessionId.slice(0, 7)}</span>
            </div>
            {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} bridgeId={session.bridgeId ?? null} /> : null}
          </div>
        </div>

        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <TabsContent value="overview" className="min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0">
            <SessionOverview session={session} sessionId={sessionId} active={active && activeTab === "overview"} />
          </TabsContent>

          <TabsContent
            value="chat"
            forceMount
            className="min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
          >
            <SessionChatDock
              session={session}
              bridgeId={session.bridgeId ?? bridgeId}
              className="h-full w-full border-0 xl:w-full"
              hideOpenSessionAction
              composerInsert={pendingTerminalInsert}
            />
          </TabsContent>
          <TabsContent
            value="preview"
            className="min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
          >
            {previewTabActive ? (
              <SessionPreview
                key={sessionId}
                sessionId={sessionId}
                active={previewTabActive}
                onQueueTerminalInsert={queueTerminalInsert}
                onConnectionChange={handlePreviewConnectionChange}
              />
            ) : null}
          </TabsContent>

          <TabsContent
            value="skills"
            className="min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
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
