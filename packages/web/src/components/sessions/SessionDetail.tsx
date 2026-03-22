"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Globe,
  Loader2,
  LayoutDashboard,
  PanelLeftOpen,
  Share2,
  SquareTerminal,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
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


interface SessionDetailProps {
  sessionId: string;
  initialSession?: DashboardSession | null;
  immersiveMobileMode?: boolean;
  active?: boolean;
  onOpenSidebar?: () => void;
}

type SessionTab = "overview" | "terminal" | "preview";

function resolveSessionTab(value: string | null): SessionTab {
  if (value === "overview" || value === "terminal" || value === "preview") {
    return value;
  }
  return "terminal";
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
      return "bg-orange-500";
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
  immersiveMobileMode = false,
  active = true,
  onOpenSidebar,
}: SessionDetailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId, initialSession, { enabled: active });
  const terminalInsertNonceRef = useRef(0);
  const autoPreviewOpenedRef = useRef(false);
  const [pendingTerminalInsert, setPendingTerminalInsert] = useState<TerminalInsertRequest | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const activeTab = useMemo(
    () => resolveSessionTab(searchParams.get("tab")),
    [searchParams],
  );
  const handleTabChange = useCallback((value: string) => {
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
  const handleCreateShare = useCallback(async () => {
    if (!session?.bridgeId) {
      setShareError("Share links are only available for paired-device sessions.");
      return;
    }

    setShareBusy(true);
    setShareError(null);

    try {
      const response = await fetch("/api/bridge/shares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ device_id: session.bridgeId, session_id: sessionId }),
      });

      const payload = (await response.json().catch(() => null)) as {
        shareId?: string;
        error?: string;
      } | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to create share link (${response.status})`);
      }

      const shareId = payload?.shareId?.trim();
      if (!shareId) {
        throw new Error("Relay did not return a share id.");
      }

      const sharePagePath = `/bridge/share/${encodeURIComponent(shareId)}`;
      const absoluteShareUrl = typeof window !== "undefined"
        ? new URL(sharePagePath, window.location.origin).toString()
        : sharePagePath;

      try {
        await navigator.clipboard.writeText(absoluteShareUrl);
      } catch {
        // Clipboard access is best-effort.
      }

      const opened = window.open(sharePagePath, "_blank", "noopener,noreferrer");
      if (!opened) {
        window.location.assign(sharePagePath);
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to create share link.");
    } finally {
      setShareBusy(false);
    }
  }, [session?.bridgeId, sessionId]);
  useEffect(() => {
    autoPreviewOpenedRef.current = false;
    terminalInsertNonceRef.current = 0;
    setPendingTerminalInsert(null);
  }, [sessionId]);
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
  const compactStatusLabel = getCompactSessionStatusLabel(status);
  const statusDotClass = getStatusDotClass(status);
  const statusAnimated = isStatusAnimated(status);
  const showProjectOpenMenu = status !== "queued" && status !== "spawning";
  const immersiveTerminalActive = active && immersiveMobileMode && activeTab === "terminal";
  const previewTabActive = active && activeTab === "preview";
  const tabTriggerClass = "min-h-[38px] gap-1.5 px-2.5 text-[12px] sm:min-h-0 sm:px-3";
  const canCreateShare = Boolean(session.bridgeId);

  const sessionTabs = (
    <TabsList className="flex w-full overflow-x-auto sm:w-fit sm:inline-flex">
      <TabsTrigger value="overview" className={tabTriggerClass}>
        <LayoutDashboard className="h-3.5 w-3.5" />
        Overview
      </TabsTrigger>
      <TabsTrigger value="terminal" className={tabTriggerClass}>
        <SquareTerminal className="h-3.5 w-3.5" />
        Terminal
      </TabsTrigger>
      <TabsTrigger value="preview" className={tabTriggerClass}>
        <Globe className="h-3.5 w-3.5" />
        Preview
      </TabsTrigger>
    </TabsList>
  );

  return (
    <div className={`flex h-full min-h-0 min-w-0 w-full flex-col overflow-y-auto overscroll-contain lg:overflow-hidden ${immersiveTerminalActive ? "bg-[#060404]" : ""}`}>
      <Tabs
        key={sessionId}
        value={activeTab}
        onValueChange={handleTabChange}
        className={immersiveTerminalActive ? "flex min-h-0 min-w-0 w-full flex-1 flex-col gap-0 p-0" : "flex min-h-0 min-w-0 w-full flex-1 flex-col gap-1 p-1 lg:gap-2 lg:p-3"}
      >
        {immersiveTerminalActive ? (
          <div className="flex shrink-0 flex-col border-b border-white/10 bg-[#0d0908]">
            {/* compact info row */}
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
              {canCreateShare ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
                  onClick={() => {
                    void handleCreateShare();
                  }}
                  disabled={shareBusy}
                  aria-label="Create share link"
                >
                  {shareBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Share2 className="h-4 w-4" />
                  )}
                </Button>
              ) : null}
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}${statusAnimated ? " animate-pulse" : ""}`} />
                <span className="text-[12px] font-medium text-[#efe8e1]">{compactStatusLabel}</span>
                <span className="font-mono text-[10px] text-[#8e847d]">· {sessionId.slice(0, 7)}</span>
              </div>
              {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} bridgeId={session.bridgeId ?? null} /> : null}
            </div>
            {/* tab row */}
            <div className="px-1.5 pb-1.5">
              {sessionTabs}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 sm:flex-nowrap">
            {sessionTabs}
            <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
              <div className="flex items-center gap-1.5">
                {canCreateShare ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]"
                    onClick={() => {
                      void handleCreateShare();
                    }}
                    disabled={shareBusy}
                    aria-label="Create share link"
                    title="Create share link"
                  >
                    {shareBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Share2 className="h-4 w-4" />
                    )}
                  </Button>
                ) : null}
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}${statusAnimated ? " animate-pulse" : ""}`} />
                <span className="text-[11px] text-[var(--vk-text-muted)]">{compactStatusLabel}</span>
                <span className="hidden font-mono text-[10px] text-[var(--vk-text-muted)] sm:inline">· {sessionId.slice(0, 7)}</span>
              </div>
              {showProjectOpenMenu ? <SessionProjectOpenMenu projectId={session.projectId} bridgeId={session.bridgeId ?? null} /> : null}
            </div>
          </div>
        )}

        {shareError ? (
          <div className="px-2 pt-1 text-[11px] text-[var(--status-error)]">
            {shareError}
          </div>
        ) : null}

        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <TabsContent value="overview" className="min-h-0 h-full min-w-0 w-full overflow-hidden focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0">
            <SessionOverview session={session} sessionId={sessionId} active={active && activeTab === "overview"} />
          </TabsContent>

          <TabsContent
            value="terminal"
            forceMount
            className={immersiveTerminalActive
              ? "flex min-h-0 h-full min-w-0 w-full flex-col overflow-hidden bg-[#060404] focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
              : "flex min-h-0 h-full min-w-0 flex-col w-full overflow-hidden bg-transparent focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"}
          >
            <SessionTerminal
              sessionId={sessionId}
              bridgeId={session.bridgeId ?? null}
              sessionState={status}
              runtimeMode={session.metadata["runtimeMode"]?.trim() ?? null}
              pendingInsert={pendingTerminalInsert}
              immersiveMobileMode={immersiveTerminalActive}
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
        </div>
      </Tabs>
    </div>
  );
}
