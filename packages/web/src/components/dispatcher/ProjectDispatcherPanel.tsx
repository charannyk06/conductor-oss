"use client";

import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ChevronLeft, Loader2 } from "lucide-react";
import { DispatcherPreferenceChips } from "@/components/dispatcher/DispatcherPreferenceChips";
import { DispatcherPane } from "@/components/dispatcher/DispatcherPane";
import { Button } from "@/components/ui/Button";
import {
  buildModelSelection,
  type ModelSelectionState,
} from "@/lib/agentModelSelection";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";
import type { DashboardSession } from "@/lib/types";

function compareSessionsByActivity(left: DashboardSession, right: DashboardSession): number {
  return new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
}

function readMetadataValue(
  thread: DashboardSession,
  key: string,
  fallback = "",
): string {
  const value = thread.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

type ProjectDispatcherPanelProps = {
  projectId: string;
  bridgeId?: string | null;
  defaultAgent: string;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

export function ProjectDispatcherPanel({
  projectId,
  bridgeId,
  defaultAgent,
  modelAccess,
  runtimeModelCatalogs,
  collapsed = false,
  onToggleCollapsed,
}: ProjectDispatcherPanelProps) {
  const [dispatcherThreads, setDispatcherThreads] = useState<DashboardSession[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [implementationAgent, setImplementationAgent] = useState(defaultAgent);
  const [modelSelection, setModelSelection] = useState<ModelSelectionState>(() =>
    buildModelSelection(defaultAgent, modelAccess, runtimeModelCatalogs, null, null));

  const dispatcherSession = useMemo(() => {
    if (!selectedThreadId) {
      return dispatcherThreads[0] ?? null;
    }
    return dispatcherThreads.find((thread) => thread.id === selectedThreadId) ?? dispatcherThreads[0] ?? null;
  }, [dispatcherThreads, selectedThreadId]);

  useEffect(() => {
    if (!dispatcherSession) {
      setImplementationAgent(defaultAgent);
      setModelSelection(buildModelSelection(defaultAgent, modelAccess, runtimeModelCatalogs, null, null));
      return;
    }

    const nextAgent = readMetadataValue(dispatcherSession, "acpImplementationAgent", defaultAgent);
    setImplementationAgent(nextAgent);
    setModelSelection(
      buildModelSelection(
        nextAgent,
        modelAccess,
        runtimeModelCatalogs,
        readMetadataValue(dispatcherSession, "acpImplementationModel") || null,
        readMetadataValue(dispatcherSession, "acpImplementationReasoningEffort") || null,
      ),
    );
  }, [defaultAgent, dispatcherSession, modelAccess, runtimeModelCatalogs]);

  const loadDispatcherThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const response = await fetch(withBridgeQuery(`/api/projects/${projectId}/dispatchers`, bridgeId), {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to load dispatcher sessions");
      }
      const threads = Array.isArray(payload?.threads)
        ? ([...(payload.threads as DashboardSession[])]).sort(compareSessionsByActivity)
        : [];
      const activeThreadId = typeof payload?.activeThreadId === "string" && payload.activeThreadId.trim().length > 0
        ? payload.activeThreadId
        : null;

      setDispatcherThreads(threads);
      setSelectedThreadId((current) => {
        if (current && threads.some((thread) => thread.id === current)) {
          return current;
        }
        if (activeThreadId && threads.some((thread) => thread.id === activeThreadId)) {
          return activeThreadId;
        }
        return threads[0]?.id ?? null;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dispatcher sessions");
    } finally {
      setLoadingThreads(false);
    }
  }, [bridgeId, projectId]);

  useEffect(() => {
    void loadDispatcherThreads();
  }, [loadDispatcherThreads]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadDispatcherThreads();
    }, 15_000);
    return () => window.clearInterval(intervalId);
  }, [loadDispatcherThreads]);

  const handleCreate = useCallback(async (forceNew: boolean) => {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(withBridgeQuery(`/api/projects/${projectId}/dispatcher`, bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forceNew,
          implementationAgent,
          implementationModel: modelSelection.customModel.trim() || modelSelection.catalogModel,
          implementationReasoningEffort: modelSelection.reasoningEffort,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to start dispatcher");
      }
      const session = (payload?.thread ?? null) as DashboardSession | null;
      if (!session?.id) {
        throw new Error("Dispatcher response did not include a thread");
      }
      setDispatcherThreads((current) =>
        [session, ...current.filter((candidate) => candidate.id !== session.id)].sort(compareSessionsByActivity),
      );
      setSelectedThreadId(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start dispatcher");
    } finally {
      setCreating(false);
    }
  }, [bridgeId, implementationAgent, modelSelection.catalogModel, modelSelection.customModel, modelSelection.reasoningEffort, projectId]);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    setDeletingThreadId(threadId);
    setError(null);
    try {
      const response = await fetch(
        withBridgeQuery(
          `/api/projects/${projectId}/dispatcher?threadId=${encodeURIComponent(threadId)}`,
          bridgeId,
        ),
        {
          method: "DELETE",
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to delete dispatcher thread");
      }

      const remainingThreads = dispatcherThreads
        .filter((candidate) => candidate.id !== threadId)
        .sort(compareSessionsByActivity);
      setDispatcherThreads(remainingThreads);
      setSelectedThreadId((current) => {
        if (current && current !== threadId && remainingThreads.some((candidate) => candidate.id === current)) {
          return current;
        }
        return remainingThreads[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete dispatcher thread");
    } finally {
      setDeletingThreadId((current) => current === threadId ? null : current);
    }
  }, [bridgeId, dispatcherThreads, projectId]);

  if (collapsed) {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--vk-bg-panel)]">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-[33px] w-full items-center gap-2 border-b border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] xl:h-full xl:flex-col xl:justify-start xl:px-0 xl:py-3"
          aria-label="Expand dispatcher"
          title="Expand dispatcher"
        >
          <Bot className="h-4 w-4 shrink-0" />
          <span className="truncate xl:hidden">Dispatcher</span>
          <ChevronLeft className="ml-auto h-4 w-4 shrink-0 xl:ml-0" />
        </button>
      </section>
    );
  }

  if (loadingThreads && !dispatcherSession) {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading dispatcher...
        </div>
      </section>
    );
  }

  if (!dispatcherSession) {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
        <div className="flex h-[33px] items-center gap-2 border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 text-[12px] text-[var(--vk-text-muted)]">
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Dispatcher</span>
          {onToggleCollapsed ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="hidden h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] xl:inline-flex"
              aria-label="Collapse dispatcher"
              title="Collapse dispatcher"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6">
          <div className="w-full max-w-[520px] rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-5 text-center shadow-[0_16px_48px_rgba(0,0,0,0.18)]">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]">
              <Bot className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-[18px] font-semibold text-[var(--vk-text-strong)]">
              Start dispatcher
            </h2>
            <p className="mt-2 text-[13px] leading-6 text-[var(--vk-text-muted)]">
              Use the dispatcher to review the current repo state, shape work, and propose board changes.
            </p>
            <div className="mt-5 rounded-[12px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.16)] p-3 text-left">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                Default task handoff
              </p>
              <DispatcherPreferenceChips
                implementationAgent={implementationAgent}
                modelSelection={modelSelection}
                modelAccess={modelAccess}
                runtimeModelCatalogs={runtimeModelCatalogs}
                disabled={creating}
                onImplementationAgentChange={(nextAgent) => {
                  setImplementationAgent(nextAgent);
                  setModelSelection(buildModelSelection(nextAgent, modelAccess, runtimeModelCatalogs, null, null));
                }}
                onModelSelectionChange={setModelSelection}
              />
            </div>
            {error ? <div className="mt-4 text-[13px] text-[#d25151]">{error}</div> : null}
            <div className="mt-5 flex items-center justify-center gap-3">
              <Button onClick={() => void handleCreate(false)} disabled={creating}>
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Start dispatcher
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
      {error ? (
        <div className="border-b border-[var(--vk-border)] bg-[rgba(210,81,81,0.08)] px-3 py-2 text-[12px] text-[#d25151]">
          {error}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <DispatcherPane
          thread={dispatcherSession}
          threads={dispatcherThreads}
          projectId={projectId}
          bridgeId={bridgeId}
          modelAccess={modelAccess}
          runtimeModelCatalogs={runtimeModelCatalogs}
          onSelectThread={setSelectedThreadId}
          onDeleteThread={(threadId) => void handleDeleteThread(threadId)}
          deletingThreadId={deletingThreadId}
          onStartNewConversation={() => void handleCreate(true)}
          creatingConversation={creating}
          onToggleCollapse={onToggleCollapsed}
          className="w-full border-l-0 border-t-0 xl:w-full"
        />
      </div>
    </section>
  );
}
