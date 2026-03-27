"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SessionChatDock } from "@/components/sessions/SessionChatDock";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import type { DashboardSession } from "@/lib/types";

const PROJECT_DISPATCHER_SESSION_KIND = "project_dispatcher";

function isProjectDispatcherSession(session: DashboardSession): boolean {
  return session.metadata.sessionKind === PROJECT_DISPATCHER_SESSION_KIND;
}

function compareSessionsByActivity(left: DashboardSession, right: DashboardSession): number {
  return new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
}

type ProjectDispatcherPanelProps = {
  projectId: string;
  bridgeId?: string | null;
  defaultAgent: string;
  projectSessions: DashboardSession[];
};

export function ProjectDispatcherPanel({
  projectId,
  bridgeId,
  defaultAgent,
  projectSessions,
}: ProjectDispatcherPanelProps) {
  const existingSession = useMemo(
    () => projectSessions.filter(isProjectDispatcherSession).sort(compareSessionsByActivity)[0] ?? null,
    [projectSessions],
  );
  const [localSession, setLocalSession] = useState<DashboardSession | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existingSession) {
      setLocalSession(existingSession);
      return;
    }
    setLocalSession((current) => (current && current.projectId === projectId ? current : null));
  }, [existingSession, projectId]);

  const dispatcherSession = existingSession ?? localSession;

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(withBridgeQuery("/api/sessions", bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          agent: defaultAgent,
          prompt: "",
          permissionMode: "plan",
          sessionKind: PROJECT_DISPATCHER_SESSION_KIND,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to start dispatcher session");
      }
      const session = (payload?.session ?? null) as DashboardSession | null;
      if (!session?.id) {
        throw new Error("Dispatcher session response did not include a session");
      }
      setLocalSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start dispatcher session");
    } finally {
      setCreating(false);
    }
  };

  if (!dispatcherSession) {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
        <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 py-3 sm:px-4">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">Dispatcher Chat</p>
          <p className="mt-1 text-[14px] text-[var(--vk-text-strong)]">Separate orchestrator session for {projectId}</p>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-[640px] rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 text-center shadow-[0_16px_48px_rgba(0,0,0,0.18)]">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
              <Bot className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-[24px] font-semibold text-[var(--vk-text-strong)]">Project dispatcher</h2>
            <p className="mt-3 text-[14px] leading-6 text-[var(--vk-text-muted)]">
              This is the master orchestration chat for the project. It should shape work, maintain the board,
              create or refine launchable tasks, and leave dedicated coding sessions to the implementation agents.
            </p>
            <div className="mt-5 rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4 text-left text-[13px] leading-6 text-[var(--vk-text-muted)]">
              <div className="flex items-center gap-2 text-[var(--vk-text-normal)]">
                <Sparkles className="h-4 w-4" />
                <span className="font-medium">What this chat is for</span>
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5">
                <li>Turn rough product requests into high-signal board tasks</li>
                <li>Keep long-lived project context in one orchestration session</li>
                <li>Act like the dispatcher or master puppeteer, not the coding terminal</li>
                <li>Hand work off to dedicated coding sessions launched from board tasks</li>
              </ul>
            </div>
            {error ? <div className="mt-4 text-[13px] text-[#d25151]">{error}</div> : null}
            <div className="mt-6 flex items-center justify-center gap-3">
              <Button onClick={() => void handleCreate()} disabled={creating}>
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Start dispatcher chat
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
      <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 py-3 sm:px-4">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">Dispatcher Chat</p>
        <p className="mt-1 text-[14px] text-[var(--vk-text-strong)]">
          Separate orchestration session with long-lived memory for {projectId}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SessionChatDock
          session={dispatcherSession}
          bridgeId={bridgeId}
          className="w-full border-l-0 border-t-0 xl:w-full"
        />
      </div>
    </section>
  );
}
