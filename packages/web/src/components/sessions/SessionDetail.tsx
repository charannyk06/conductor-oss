"use client";

import { FileCode, MessageSquare, MonitorDot, LayoutDashboard } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { useSession } from "@/hooks/useSession";
import { TerminalView } from "@/components/TerminalView";
import { SessionOverview } from "./SessionOverview";
import { SessionDiff } from "./SessionDiff";
import { ChatPanel } from "./ChatPanel";

interface SessionDetailProps {
  sessionId: string;
}

export function SessionDetail({ sessionId }: SessionDetailProps) {
  const { session, loading, error } = useSession(sessionId);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-[var(--color-text-muted)]">Loading session...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-[var(--color-status-error)]">{error}</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-[var(--color-text-muted)]">Session not found</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border-default)] px-4 py-2.5">
        <span className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
          {session.agent}
        </span>
        <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
          {sessionId.slice(0, 8)}
        </span>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="flex flex-1 flex-col min-h-0">
        <TabsList>
          <TabsTrigger value="overview">
            <LayoutDashboard className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="chat">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="terminal">
            <MonitorDot className="h-3.5 w-3.5" />
            Terminal
          </TabsTrigger>
          <TabsTrigger value="diff">
            <FileCode className="h-3.5 w-3.5" />
            Diff
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex-1 min-h-0 overflow-auto">
          <SessionOverview session={session} />
        </TabsContent>

        <TabsContent value="chat" className="flex-1 min-h-0">
          <ChatPanel sessionId={sessionId} />
        </TabsContent>

        <TabsContent value="terminal" className="flex-1 min-h-0">
          <TerminalView sessionId={sessionId} />
        </TabsContent>

        <TabsContent value="diff" className="flex-1 min-h-0 overflow-auto">
          <SessionDiff sessionId={sessionId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
