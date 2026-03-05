"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  FileCode,
  LayoutDashboard,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { useSession } from "@/hooks/useSession";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { TerminalView } from "@/components/TerminalView";
import { SessionOverview } from "./SessionOverview";
import { SessionDiff } from "./SessionDiff";
import { ChatPanel } from "./ChatPanel";

interface SessionDetailProps {
  sessionId: string;
}

type SessionTab = "overview" | "chat" | "diff" | "terminal";

function resolveSessionTab(value: string | null): SessionTab {
  if (value === "chat" || value === "diff" || value === "terminal") {
    return value;
  }
  return "overview";
}

export function SessionDetail({ sessionId }: SessionDetailProps) {
  const searchParams = useSearchParams();
  const { session, loading, error } = useSession(sessionId);
  const initialTab = useMemo(
    () => resolveSessionTab(searchParams.get("tab")),
    [searchParams],
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs key={`${sessionId}-${initialTab}`} defaultValue={initialTab} className="flex min-h-0 flex-1 flex-col gap-2 p-2 sm:p-3">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="overview">
              <LayoutDashboard className="h-3.5 w-3.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="chat">
              {agentName
                ? <AgentTileIcon seed={{ label: agentName }} className="h-6 w-6" />
                : <MessageSquare className="h-3.5 w-3.5" />}
              Chat
            </TabsTrigger>
            <TabsTrigger value="diff">
              <FileCode className="h-3.5 w-3.5" />
              Diff
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <SquareTerminal className="h-3.5 w-3.5" />
              Terminal
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

        <TabsContent value="chat" className="min-h-0 flex-1 overflow-hidden">
          <Card className="h-full">
            <ChatPanel sessionId={sessionId} agentName={agentName} />
          </Card>
        </TabsContent>

        <TabsContent value="diff" className="min-h-0 flex-1 overflow-auto">
          <SessionDiff sessionId={sessionId} />
        </TabsContent>

        <TabsContent value="terminal" className="min-h-0 flex-1 overflow-hidden">
          <Card className="h-full">
            <TerminalView sessionId={sessionId} />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
