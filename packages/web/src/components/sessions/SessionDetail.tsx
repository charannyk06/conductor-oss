"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  FileCode,
  Globe,
  LayoutDashboard,
  SquareTerminal,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { useSession } from "@/hooks/useSession";
import type { DashboardSession } from "@/lib/types";
import { SessionOverview } from "./SessionOverview";
import { SessionDiff } from "./SessionDiff";
import { SessionPreview } from "./SessionPreview";
import { SessionProjectOpenMenu } from "./SessionProjectOpenMenu";
import { SessionTerminal } from "./SessionTerminal";
import type { TerminalInsertRequest } from "./terminalInsert";

interface SessionDetailProps {
  sessionId: string;
  initialSession?: DashboardSession | null;
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

export function SessionDetail({ sessionId, initialSession = null }: SessionDetailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId, initialSession);
  const terminalInsertNonceRef = useRef(0);
  const autoPreviewOpenedRef = useRef(false);
  const [pendingTerminalInsert, setPendingTerminalInsert] = useState<TerminalInsertRequest | null>(null);
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
  useEffect(() => {
    autoPreviewOpenedRef.current = false;
    terminalInsertNonceRef.current = 0;
    setPendingTerminalInsert(null);
  }, [sessionId]);
  const handlePreviewConnectionChange = useCallback((connected: boolean) => {
    if (!connected || activeTab !== "terminal" || autoPreviewOpenedRef.current) {
      return;
    }
    autoPreviewOpenedRef.current = true;
    handleTabChange("preview");
  }, [activeTab, handleTabChange]);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs key={sessionId} value={activeTab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5 sm:gap-2 sm:p-3">
        <div className="flex min-w-0 flex-col gap-1.5 sm:gap-2">
          <TabsList className="grid w-full grid-cols-4 sm:w-fit sm:inline-flex">
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

        <div className="relative min-h-0 flex-1">
          <TabsContent value="overview" className="min-h-0 h-full overflow-auto">
            <SessionOverview key={sessionId} session={session} />
          </TabsContent>

          <TabsContent
            value="terminal"
            forceMount
            className="min-h-0 h-full overflow-hidden rounded-[3px] border border-[var(--vk-border)] bg-[#212121] focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
          >
            <SessionTerminal
              key={sessionId}
              sessionId={sessionId}
              agentName={agentName}
              projectId={session.projectId}
              sessionModel={sessionModel}
              sessionReasoningEffort={sessionReasoningEffort}
              sessionState={status}
              active={activeTab === "terminal"}
              pendingInsert={pendingTerminalInsert}
            />
          </TabsContent>

          <TabsContent
            value="preview"
            className="min-h-0 h-full overflow-auto focus-visible:outline-none [&[hidden]]:block data-[state=inactive]:pointer-events-none data-[state=inactive]:absolute data-[state=inactive]:inset-0 data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
          >
            {activeTab === "preview" ? (
              <SessionPreview
                key={sessionId}
                sessionId={sessionId}
                active
                onQueueTerminalInsert={queueTerminalInsert}
                onConnectionChange={handlePreviewConnectionChange}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="diff" className="min-h-0 h-full overflow-auto">
            <SessionDiff key={sessionId} sessionId={sessionId} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
