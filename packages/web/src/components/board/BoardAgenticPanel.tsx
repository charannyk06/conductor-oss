"use client";

import { useEffect, useMemo, useState } from "react";
import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { buildSessionHref } from "@/lib/dashboardHref";
import { buildBoardTaskPlanningPrompt, type BoardTaskLaunchPayload } from "./boardAgentic";

type BoardAgenticPanelProps = {
  task: BoardTaskLaunchPayload | null;
  projectId: string | null;
  bridgeId?: string | null;
  defaultAgent: string;
  modelAccess: ModelAccessPreferences | null;
  onLaunchTask?: (task: BoardTaskLaunchPayload) => Promise<void> | void;
  onOpenSession?: (sessionId: string, tab?: "chat" | "terminal") => void;
};

type PlanningSessionState = {
  sessionId: string | null;
  sessionLabel: string | null;
};

const BOARD_PLANNING_SESSION_KIND = "board_planning";

export function BoardAgenticPanel({
  task,
  projectId,
  bridgeId,
  defaultAgent,
  modelAccess,
  onLaunchTask,
  onOpenSession,
}: BoardAgenticPanelProps) {
  const [planning, setPlanning] = useState<PlanningSessionState>({ sessionId: null, sessionLabel: null });
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlanning({ sessionId: task?.linkedSessionId ?? null, sessionLabel: task?.linkedSessionLabel ?? null });
    setOutput("");
    setMessage("");
    setError(null);
  }, [task?.id, task?.linkedSessionId, task?.linkedSessionLabel]);

  useEffect(() => {
    if (!planning.sessionId) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(
          withBridgeQuery(`/api/sessions/${encodeURIComponent(planning.sessionId ?? "")}/output`, bridgeId ?? undefined),
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        const nextOutput = typeof payload?.output === "string" ? payload.output : "";
        if (!cancelled) {
          setOutput(nextOutput);
        }
      } catch {
      }
    };

    void refresh();
    const handle = window.setInterval(() => {
      void refresh();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [bridgeId, planning.sessionId]);

  const selectedAgent = useMemo(() => task?.agent?.trim() || defaultAgent, [defaultAgent, task?.agent]);
  const modelAccessLabel = useMemo(() => {
    if (!selectedAgent) return null;
    const value = (modelAccess as Record<string, string | undefined> | null)?.[selectedAgent];
    return value ? `${selectedAgent} via ${value}` : selectedAgent;
  }, [modelAccess, selectedAgent]);

  const createPlanningSession = async () => {
    if (!task || !projectId) return null;

    const response = await fetch(withBridgeQuery("/api/sessions", bridgeId ?? undefined), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        issueId: task.issueId,
        name: `Plan: ${task.title}`,
        prompt: buildBoardTaskPlanningPrompt(task),
        agent: selectedAgent,
        permissionMode: "plan",
        sessionKind: BOARD_PLANNING_SESSION_KIND,
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to create planning session");
    }

    const sessionId = payload?.session_id ?? payload?.id ?? payload?.session?.id ?? null;
    const sessionLabel = payload?.name ?? payload?.session?.name ?? `Plan: ${task.title}`;
    if (!sessionId) {
      throw new Error("Planning session response did not include a session id");
    }

    const next = { sessionId, sessionLabel };
    setPlanning(next);
    return next;
  };

  const sendMessage = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      const activeSession = planning.sessionId ? planning : await createPlanningSession();
      if (!activeSession?.sessionId) return;
      const text = message.trim();
      if (text) {
        const response = await fetch(
          withBridgeQuery(`/api/sessions/${encodeURIComponent(activeSession.sessionId)}/feedback`, bridgeId ?? undefined),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text }),
          },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error ?? "Failed to send message to planning session");
        }
      }
      setMessage("");
      if (onOpenSession) {
        onOpenSession(activeSession.sessionId, "chat");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const startPlanning = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      const activeSession = await createPlanningSession();
      if (activeSession?.sessionId && onOpenSession) {
        onOpenSession(activeSession.sessionId, "chat");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const launchTask = async () => {
    if (!task || !onLaunchTask) return;
    setBusy(true);
    setError(null);
    try {
      await onLaunchTask(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch task session");
    } finally {
      setBusy(false);
    }
  };

  const openInSessionView = (tab: "chat") => {
    if (!planning.sessionId) return;
    if (onOpenSession) {
      onOpenSession(planning.sessionId, tab);
      return;
    }
    window.location.href = buildSessionHref(planning.sessionId, {
      bridgeId: bridgeId ?? undefined,
      tab,
    });
  };

  return (
    <aside className="flex h-full min-h-[540px] w-full max-w-[380px] flex-col rounded-xl border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]">
      <div className="border-b border-[var(--vk-border)] px-4 py-3">
        <div className="text-sm font-semibold text-[var(--vk-text-strong)]">Board Agentic Chat</div>
        <div className="mt-1 text-xs text-[var(--vk-text-muted)]">
          Board-first planning, same runtime underneath. Use chat to scope it, then launch the task run.
        </div>
      </div>
      {!task ? (
        <div className="p-4 text-sm text-[var(--vk-text-muted)]">
          Select a board task to plan, break down, launch, or continue with the agentic panel.
        </div>
      ) : (
        <>
          <div className="space-y-3 px-4 py-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--vk-text-muted)]">Selected task</div>
              <div className="mt-1 font-medium text-[var(--vk-text-strong)]">{task.title}</div>
              <div className="mt-1 text-xs text-[var(--vk-text-muted)]">{task.issueId}</div>
            </div>
            <div className="rounded-lg border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-3 text-xs text-[var(--vk-text-muted)]">
              <div><span className="font-medium text-[var(--vk-text-normal)]">Agent:</span> {selectedAgent || "Not set"}</div>
              {modelAccessLabel ? <div className="mt-1"><span className="font-medium text-[var(--vk-text-normal)]">Access:</span> {modelAccessLabel}</div> : null}
              {planning.sessionId ? <div className="mt-1"><span className="font-medium text-[var(--vk-text-normal)]">Planning session:</span> {planning.sessionLabel || planning.sessionId}</div> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md bg-[var(--vk-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
                disabled={busy || !projectId}
                onClick={() => {
                  void startPlanning();
                }}
              >
                Start planning
              </button>
              <button
                type="button"
                className="rounded-md border border-[var(--vk-border)] px-3 py-2 text-xs font-medium text-[var(--vk-text-normal)] disabled:opacity-60"
                disabled={busy || !onLaunchTask}
                onClick={() => {
                  void launchTask();
                }}
              >
                Launch task session
              </button>
            </div>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask the board agent to break this down, suggest sub-tasks, or plan the next move"
              className="min-h-[112px] w-full rounded-lg border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3 text-sm text-[var(--vk-text-normal)] outline-none"
            />
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="rounded-md border border-[var(--vk-border)] px-3 py-2 text-xs font-medium text-[var(--vk-text-normal)] disabled:opacity-60"
                disabled={busy || message.trim().length === 0}
                onClick={() => {
                  void sendMessage();
                }}
              >
                Send to agentic chat
              </button>
              {planning.sessionId ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-[var(--vk-border)] px-3 py-2 text-xs font-medium text-[var(--vk-text-normal)]"
                    onClick={() => openInSessionView("chat")}
                  >
                    Open chat
                  </button>
                </div>
              ) : null}
            </div>
            {error ? <div className="text-xs text-red-400">{error}</div> : null}
          </div>
          <div className="min-h-0 flex-1 border-t border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--vk-text-muted)]">Latest session output</div>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--vk-text-normal)]">{output || "No planning session output yet."}</pre>
          </div>
        </>
      )}
    </aside>
  );
}
