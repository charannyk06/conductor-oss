"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  FileCode,
  Globe,
  SquareTerminal,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";

import { useSession } from "@/hooks/useSession";
import type { DashboardSession } from "@/lib/types";

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
  immersiveShell?: boolean;
  active?: boolean;
}

type SessionTab = "terminal" | "diff" | "preview";

function resolveSessionTab(value: string | null): SessionTab {
  if (value === "terminal" || value === "diff" || value === "preview") {
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
  active = true,
}: SessionDetailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId, initialSession, { enabled: active });
  const autoPreviewOpenedRef = useRef(false);

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

  useEffect(() => {
    autoPreviewOpenedRef.current = false;
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
  const terminalTabActive = active && activeTab === "terminal";
  const previewTabActive = active && activeTab === "preview";

  return (
    <div className="flex h-full min-h-0 w-full overflow-clip bg-[#060404]">
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-clip">
        <Tabs
          key={sessionId}
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex min-h-0 flex-1 flex-col gap-0 p-0"
        >
          {/* When on preview or diff tab, show the normal tab strip so users can navigate back */}
          {activeTab !== "terminal" ? (
            <div className="flex min-w-0 items-center justify-between gap-2 px-3 pt-3 pb-1">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="terminal" className="min-h-[44px] justify-center px-2 text-[11px] sm:min-h-0 sm:px-2.5 sm:text-[12px]">
                  <SquareTerminal className="h-3.5 w-3.5" />
                  Terminal
                </TabsTrigger>
                <TabsTrigger value="preview" className="min-h-[44px] justify-center px-2 text-[11px] sm:min-h-0 sm:px-2.5 sm:text-[12px]">
                  <Globe className="h-3.5 w-3.5" />
                  Preview
                </TabsTrigger>
                <TabsTrigger value="diff" className="min-h-[44px] justify-center px-2 text-[11px] sm:min-h-0 sm:px-2.5 sm:text-[12px]">
                  <FileCode className="h-3.5 w-3.5" />
                  Diff
                </TabsTrigger>
              </TabsList>
            </div>
          ) : null}

          <div className="relative min-h-0 flex-1 overflow-clip">
            {/* Minimal floating pill in top-right: always visible but subtle.
                Stays out of the way of terminal content while keeping preview/diff accessible. */}
            {activeTab === "terminal" ? (
              <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-full border border-white/8 bg-[#141010]/80 px-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-sm transition-opacity duration-200 opacity-40 hover:opacity-100">
                <span className="px-2 text-[11px] text-[#efe8e1]/70">{compactStatusLabel}</span>
                <button
                  type="button"
                  onClick={() => handleTabChange("preview")}
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full text-[#efe8e1]/60 transition hover:bg-white/10 hover:text-[#efe8e1]"
                  aria-label="Switch to preview tab"
                >
                  <Globe className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleTabChange("diff")}
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full text-[#efe8e1]/60 transition hover:bg-white/10 hover:text-[#efe8e1]"
                  aria-label="Switch to diff tab"
                >
                  <FileCode className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}

            <TabsContent
              value="terminal"
              className="flex min-h-0 h-full flex-col overflow-clip bg-[#060404] focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
            >
              <SessionTerminal
                key={sessionId}
                sessionId={sessionId}
                sessionState={status}
                active={terminalTabActive}
              />
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
    </div>
  );
}
