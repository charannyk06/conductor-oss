"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  FileCode,
  Globe,
  LayoutDashboard,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { useSession } from "@/hooks/useSession";
import type { DashboardSession } from "@/lib/types";
import { SessionOverview } from "./SessionOverview";
import { SessionProjectOpenMenu } from "./SessionProjectOpenMenu";
import type { TerminalInsertRequest } from "./terminalInsert";

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

const SessionDiff = dynamic(
  () => import("./SessionDiff").then((mod) => mod.SessionDiff),
  {
    loading: () => (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading diff...
      </div>
    ),
  },
);

interface SessionDetailProps {
  sessionId: string;
  initialSession?: DashboardSession | null;
  immersiveMobileMode?: boolean;
  active?: boolean;
}

type SessionTab = "overview" | "terminal" | "diff" | "preview";

function resolveSessionTab(value: string | null): SessionTab {
  if (value === "overview" || value === "terminal" || value === "diff" || value === "preview") {
    return value;
  }
  return "terminal";
}

function getCompactSessionStatusLabel(status: string): string {
  switch (status) {
    case "needs_input":
      return "input";
    case "working":
      return "working";
    case "running":
      return "running";
    case "spawning":
      return "spawn";
    case "queued":
      return "queued";
    default:
      return status.replace(/[_-]+/g, " ");
  }
}

export function SessionDetail({
  sessionId,
  initialSession = null,
  immersiveMobileMode = false,
  active = true,
}: SessionDetailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId, initialSession, { enabled: active });
  const terminalInsertNonceRef = useRef(0);
  const autoPreviewOpenedRef = useRef(false);
  const [pendingTerminalInsert, setPendingTerminalInsert] = useState<TerminalInsertRequest | null>(null);
  const [mobileTerminalPanelOpen, setMobileTerminalPanelOpen] = useState(false);
  const activeTab = useMemo(
    () => resolveSessionTab(searchParams.get("tab")),
    [searchParams],
  );
  const handleTabChange = useCallback((value: string) => {
    setMobileTerminalPanelOpen(false);
    const nextTab = resolveSessionTab(value);
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === "terminal") {
      params.delete("tab");
    } else {
      params.set("tab", nextTab);
    }
    const nextQuery = params.toString();
    const nextUrl = nextQuery.length > 0 ? `${pathname}?${nextQuery}` : pathname;
    router.replace(nextUrl, { scroll: false });
  }, [pathname, router, searchParams]);
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
  useEffect(() => {
    if (!immersiveMobileMode || activeTab !== "terminal") {
      setMobileTerminalPanelOpen(false);
    }
  }, [activeTab, immersiveMobileMode, sessionId]);
  useEffect(() => {
    if (!active) {
      setMobileTerminalPanelOpen(false);
    }
  }, [active]);
  const handlePreviewConnectionChange = useCallback((connected: boolean) => {
    if (!connected || !active || activeTab !== "terminal" || autoPreviewOpenedRef.current) {
      return;
    }
    autoPreviewOpenedRef.current = true;
    handleTabChange("preview");
  }, [active, activeTab, handleTabChange]);

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
  const agentName = session.metadata["agent"]?.trim() ?? "";
  const sessionModel = session.metadata["model"]?.trim() ?? "";
  const sessionReasoningEffort = session.metadata["reasoningEffort"]?.trim() ?? "";
  const compactStatusLabel = getCompactSessionStatusLabel(status);
  const showProjectOpenMenu = status !== "queued" && status !== "spawning";
  const immersiveTerminalActive = active && immersiveMobileMode && activeTab === "terminal";
  const terminalTabActive = active && activeTab === "terminal";
  const previewTabActive = active && activeTab === "preview";
  const sessionTabs = (
    <TabsList className={immersiveTerminalActive ? "grid w-full grid-cols-4" : "grid w-full grid-cols-4 sm:w-fit sm:inline-flex"}>
      <TabsTrigger value="overview" className="justify-center px-2 text-[11px] sm:px-2.5 sm:text-[12px]">
        <LayoutDashboard className="h-3.5 w-3.5" />
        Overview
      </TabsTrigger>
      <TabsTrigger value="terminal" className="justify-center px-2 text-[11px] sm:px-2.5 sm:text-[12px]">
        <SquareTerminal className="h-3.5 w-3.5" />
        Terminal
      </TabsTrigger>
      <TabsTrigger value="preview" className="justify-center px-2 text-[11px] sm:px-2.5 sm:text-[12px]">
        <Globe className="h-3.5 w-3.5" />
        Preview
      </TabsTrigger>
      <TabsTrigger value="diff" className="justify-center px-2 text-[11px] sm:px-2.5 sm:text-[12px]">
        <FileCode className="h-3.5 w-3.5" />
        Diff
      </TabsTrigger>
    </TabsList>
  );

  return (
    <div className={`flex h-full min-h-0 flex-col ${immersiveTerminalActive ? "bg-[#060404]" : ""}`}>
      <Tabs
        key={sessionId}
        value={activeTab}
        onValueChange={handleTabChange}
        className={immersiveTerminalActive ? "flex min-h-0 flex-1 flex-col gap-0 p-0" : "flex min-h-0 flex-1 flex-col gap-1.5 p-1.5 sm:gap-2 sm:p-3"}
      >
        {immersiveTerminalActive ? null : (
          <div className="flex min-w-0 flex-col gap-1.5 sm:gap-2">
            {sessionTabs}
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="h-[23px] max-w-full">
                  <span className="sm:hidden">{compactStatusLabel}</span>
                  <span className="hidden sm:inline">{status}</span>
                </Badge>
                <span className="font-mono text-[10px] text-[var(--vk-text-muted)] sm:hidden">{sessionId.slice(0, 6)}</span>
                <span className="hidden min-w-0 truncate font-mono text-[10px] text-[var(--vk-text-muted)] sm:block">{sessionId}</span>
              </div>
              {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} /> : null}
            </div>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {immersiveTerminalActive ? (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-end gap-2">
              <Badge variant="outline" className="pointer-events-auto h-[30px] border-white/12 bg-[#141010]/92 px-2.5 text-[#efe8e1] shadow-[0_14px_28px_rgba(0,0,0,0.36)] backdrop-blur-sm">
                {compactStatusLabel}
              </Badge>
              <button
                type="button"
                onClick={() => setMobileTerminalPanelOpen((current) => !current)}
                className="pointer-events-auto inline-flex h-[30px] items-center gap-1.5 rounded-full border border-white/12 bg-[#141010]/92 px-3 text-[11px] font-medium text-[#efe8e1] shadow-[0_14px_28px_rgba(0,0,0,0.36)] backdrop-blur-sm transition hover:bg-[#201818]"
                aria-label={mobileTerminalPanelOpen ? "Close terminal session controls" : "Open terminal session controls"}
                aria-expanded={mobileTerminalPanelOpen}
              >
                {mobileTerminalPanelOpen ? <X className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
                Controls
              </button>
            </div>
          ) : null}
          {immersiveTerminalActive && mobileTerminalPanelOpen ? (
            <div className="absolute inset-x-3 top-14 z-20 rounded-[18px] border border-white/10 bg-[#120d0d]/96 p-3 shadow-[0_28px_60px_rgba(0,0,0,0.45)] backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[#8e847d]">Session</p>
                  <p className="truncate font-mono text-[11px] text-[#d7cec7]">{sessionId}</p>
                </div>
                {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} /> : null}
              </div>
              <div className="mt-3">
                {sessionTabs}
              </div>
            </div>
          ) : null}
          <TabsContent value="overview" className="min-h-0 h-full overflow-auto focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0">
            <SessionOverview session={session} />
          </TabsContent>

          <TabsContent
            value="terminal"
            className={immersiveTerminalActive
              ? "flex min-h-0 h-full flex-col overflow-hidden bg-[#060404] focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
              : "flex min-h-0 h-full flex-col overflow-hidden bg-transparent focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"}
          >
            {terminalTabActive ? (
              <SessionTerminal
                key={sessionId}
                sessionId={sessionId}
                agentName={agentName}
                projectId={session.projectId}
                sessionModel={sessionModel}
              sessionReasoningEffort={sessionReasoningEffort}
              sessionState={status}
              active={terminalTabActive}
              pendingInsert={pendingTerminalInsert}
              immersiveMobileMode={immersiveTerminalActive}
            />
          ) : null}
          </TabsContent>

          <TabsContent
            value="preview"
            className="min-h-0 h-full overflow-auto focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
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

          <TabsContent value="diff" className="min-h-0 h-full overflow-auto focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0">
            {activeTab === "diff" ? (
              <SessionDiff key={sessionId} sessionId={sessionId} active={active && activeTab === "diff"} />
            ) : null}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
