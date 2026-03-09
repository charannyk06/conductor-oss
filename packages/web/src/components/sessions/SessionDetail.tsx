"use client";

import { useCallback, useMemo } from "react";
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
import { SessionOverview } from "./SessionOverview";
import { SessionDiff } from "./SessionDiff";
import { SessionPreview } from "./SessionPreview";
import { SessionTerminal } from "./SessionTerminal";

interface SessionDetailProps {
  sessionId: string;
}

type SessionTab = "overview" | "terminal" | "diff" | "preview";

function resolveSessionTab(value: string | null): SessionTab {
  if (value === "overview" || value === "terminal" || value === "diff" || value === "preview") {
    return value;
  }
  return "terminal";
}

export function SessionDetail({ sessionId }: SessionDetailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col gap-2 p-2 sm:p-3">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="overview">
              <LayoutDashboard className="h-3.5 w-3.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <SquareTerminal className="h-3.5 w-3.5" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="preview">
              <Globe className="h-3.5 w-3.5" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="diff">
              <FileCode className="h-3.5 w-3.5" />
              Diff
            </TabsTrigger>
          </TabsList>
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="outline" className="h-[23px]">
              {status}
            </Badge>
            <span className="min-w-0 truncate font-mono text-[10px] text-[var(--vk-text-muted)]">{sessionId}</span>
          </div>
        </div>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
          <SessionOverview session={session} />
        </TabsContent>

        <TabsContent
          value="terminal"
          forceMount
          className="min-h-0 flex-1 overflow-hidden rounded-[3px] border border-[var(--vk-border)] bg-[#212121] data-[state=inactive]:hidden"
        >
          <SessionTerminal
            sessionId={sessionId}
            agentName={agentName}
            projectId={session.projectId}
            sessionModel={sessionModel}
            sessionReasoningEffort={sessionReasoningEffort}
            sessionState={status}
            active={activeTab === "terminal"}
          />
        </TabsContent>

        <TabsContent value="preview" className="min-h-0 flex-1 overflow-auto">
          <SessionPreview
            sessionId={sessionId}
            projectId={session.projectId}
          />
        </TabsContent>

        <TabsContent value="diff" className="min-h-0 flex-1 overflow-auto">
          <SessionDiff sessionId={sessionId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
