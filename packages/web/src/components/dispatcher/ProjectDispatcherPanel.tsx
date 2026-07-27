"use client";

import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ChevronLeft, Loader2 } from "lucide-react";
import { DispatcherPreferenceChips } from "@/components/dispatcher/DispatcherPreferenceChips";
import { DispatcherPane } from "@/components/dispatcher/DispatcherPane";
import {
  resolveSelectedDispatcherThreadId,
  sortDispatcherThreadsByActivity,
  upsertDispatcherThread,
} from "@/components/dispatcher/threadState";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  buildModelSelection,
  type ModelSelectionState,
} from "@/lib/agentModelSelection";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import {
  buildNewDispatcherConversationDefaults,
  DISPATCHER_HANDOFF_AGENT_OPTIONS,
  DISPATCHER_RUNTIME_AGENT_OPTIONS,
} from "@/lib/dispatcherPreferences";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";
import type { DashboardSession } from "@/lib/types";

type ProjectDispatcherPanelProps = {
  projectId: string;
  bridgeId?: string | null;
  defaultAgent: string;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onBackToBoard?: () => void;
};

type CreateDispatcherConversationDialogProps = {
  creating: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  runtimeAgent: string;
  runtimeModelSelection: ModelSelectionState;
  implementationAgent: string;
  implementationModelSelection: ModelSelectionState;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  onRuntimeAgentChange: (nextAgent: string) => void;
  onRuntimeModelSelectionChange: (nextSelection: ModelSelectionState) => void;
  onImplementationAgentChange: (nextAgent: string) => void;
  onImplementationModelSelectionChange: (nextSelection: ModelSelectionState) => void;
};

function CreateDispatcherConversationDialog({
  creating,
  error,
  onCancel,
  onConfirm,
  runtimeAgent,
  runtimeModelSelection,
  implementationAgent,
  implementationModelSelection,
  modelAccess,
  runtimeModelCatalogs,
  onRuntimeAgentChange,
  onRuntimeModelSelectionChange,
  onImplementationAgentChange,
  onImplementationModelSelectionChange,
}: CreateDispatcherConversationDialogProps) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-[720px] rounded-[14px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_28px_90px_rgba(0,0,0,0.55)]">
        <div className="border-b border-[var(--vk-border)] px-5 py-4">
          <h2 className="text-[18px] font-semibold text-[var(--vk-text-strong)]">
            Start new dispatcher conversation
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
            Choose the runtime agent for the conversation and the default agent for implementation handoffs.
          </p>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div className="rounded-[12px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.16)] p-3">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
              Dispatcher runtime
            </p>
            <DispatcherPreferenceChips
              agent={runtimeAgent}
              agentOptions={DISPATCHER_RUNTIME_AGENT_OPTIONS}
              agentLabel="Runtime agent"
              modelSelection={runtimeModelSelection}
              modelAccess={modelAccess}
              runtimeModelCatalogs={runtimeModelCatalogs}
              disabled={creating}
              onAgentChange={onRuntimeAgentChange}
              onModelSelectionChange={onRuntimeModelSelectionChange}
            />
          </div>
          <div className="rounded-[12px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.16)] p-3">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
              Default task handoff
            </p>
            <DispatcherPreferenceChips
              agent={implementationAgent}
              agentOptions={DISPATCHER_HANDOFF_AGENT_OPTIONS}
              agentLabel="Handoff agent"
              modelSelection={implementationModelSelection}
              modelAccess={modelAccess}
              runtimeModelCatalogs={runtimeModelCatalogs}
              disabled={creating}
              onAgentChange={onImplementationAgentChange}
              onModelSelectionChange={onImplementationModelSelectionChange}
            />
          </div>
          {error ? (
            <div className="rounded-[10px] border border-[rgba(210,81,81,0.35)] bg-[rgba(210,81,81,0.08)] px-3 py-2 text-[12px] text-[#d25151]">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-5 py-4">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={creating}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Start conversation
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProjectDispatcherPanel({
  projectId,
  bridgeId,
  defaultAgent,
  modelAccess,
  runtimeModelCatalogs,
  collapsed = false,
  onToggleCollapsed,
  onBackToBoard,
}: ProjectDispatcherPanelProps) {
  const [dispatcherThreads, setDispatcherThreads] = useState<DashboardSession[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultConversationAgents = useMemo(
    () => buildNewDispatcherConversationDefaults(defaultAgent),
    [defaultAgent],
  );
  const [draftRuntimeAgent, setDraftRuntimeAgent] = useState(defaultConversationAgents.runtimeAgent);
  const [draftRuntimeModelSelection, setDraftRuntimeModelSelection] = useState<ModelSelectionState>(() =>
    buildModelSelection(
      defaultConversationAgents.runtimeAgent,
      modelAccess,
      runtimeModelCatalogs,
      null,
      null,
    ));
  const [draftImplementationAgent, setDraftImplementationAgent] = useState(defaultConversationAgents.implementationAgent);
  const [draftImplementationModelSelection, setDraftImplementationModelSelection] = useState<ModelSelectionState>(() =>
    buildModelSelection(
      defaultConversationAgents.implementationAgent,
      modelAccess,
      runtimeModelCatalogs,
      null,
      null,
    ));

  const dispatcherSession = useMemo(() => {
    if (!selectedThreadId) {
      return dispatcherThreads[0] ?? null;
    }
    return dispatcherThreads.find((thread) => thread.id === selectedThreadId) ?? dispatcherThreads[0] ?? null;
  }, [dispatcherThreads, selectedThreadId]);

  const resetCreateDraft = useCallback(() => {
    const defaults = buildNewDispatcherConversationDefaults(defaultAgent);
    setDraftRuntimeAgent(defaults.runtimeAgent);
    setDraftRuntimeModelSelection(
      buildModelSelection(defaults.runtimeAgent, modelAccess, runtimeModelCatalogs, null, null),
    );
    setDraftImplementationAgent(defaults.implementationAgent);
    setDraftImplementationModelSelection(
      buildModelSelection(defaults.implementationAgent, modelAccess, runtimeModelCatalogs, null, null),
    );
  }, [defaultAgent, modelAccess, runtimeModelCatalogs]);

  useEffect(() => {
    resetCreateDraft();
  }, [resetCreateDraft]);

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
        ? sortDispatcherThreadsByActivity(payload.threads as DashboardSession[])
        : [];
      const activeThreadId = typeof payload?.activeThreadId === "string" && payload.activeThreadId.trim().length > 0
        ? payload.activeThreadId
        : null;

      setDispatcherThreads(threads);
      setSelectedThreadId((current) =>
        resolveSelectedDispatcherThreadId(current, threads, activeThreadId)
      );
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
      const runtimeModel =
        draftRuntimeModelSelection.customModel.trim() || draftRuntimeModelSelection.catalogModel;
      const implementationModel =
        draftImplementationModelSelection.customModel.trim()
        || draftImplementationModelSelection.catalogModel;
      const response = await fetch(withBridgeQuery(`/api/projects/${projectId}/dispatcher`, bridgeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forceNew,
          dispatcherAgent: draftRuntimeAgent,
          dispatcherModel: runtimeModel,
          dispatcherReasoningEffort: draftRuntimeModelSelection.reasoningEffort,
          implementationAgent: draftImplementationAgent,
          implementationModel,
          implementationReasoningEffort: draftImplementationModelSelection.reasoningEffort,
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
      setDispatcherThreads((current) => upsertDispatcherThread(current, session));
      setSelectedThreadId(session.id);
      setShowCreateDialog(false);
      resetCreateDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start dispatcher");
    } finally {
      setCreating(false);
    }
  }, [
    bridgeId,
    draftImplementationAgent,
    draftImplementationModelSelection.catalogModel,
    draftImplementationModelSelection.customModel,
    draftImplementationModelSelection.reasoningEffort,
    draftRuntimeAgent,
    draftRuntimeModelSelection.catalogModel,
    draftRuntimeModelSelection.customModel,
    draftRuntimeModelSelection.reasoningEffort,
    projectId,
    resetCreateDraft,
  ]);

  const handleOpenCreateDialog = useCallback(() => {
    resetCreateDraft();
    setError(null);
    setShowCreateDialog(true);
  }, [resetCreateDraft]);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    setDeletingThreadId(threadId);
    setError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(
        withBridgeQuery(
          `/api/projects/${projectId}/dispatcher?threadId=${encodeURIComponent(threadId)}`,
          bridgeId,
        ),
        {
          method: "DELETE",
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to delete dispatcher thread");
      }
      setDispatcherThreads((current) =>
        sortDispatcherThreadsByActivity(current.filter((candidate) => candidate.id !== threadId)),
      );
      setSelectedThreadId((current) => (current === threadId ? null : current));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        const timeoutError = new Error("Delete timed out after 15s. The backend may be busy.");
        setError(timeoutError.message);
        throw timeoutError;
      }
      const message = err instanceof Error ? err.message : "Failed to delete dispatcher thread";
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setDeletingThreadId((current) => current === threadId ? null : current);
    }
  }, [bridgeId, projectId]);

  const rootClassName = cn(
    "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--vk-bg-main)]",
  );
  const mobileBackButton = onBackToBoard ? (
    <button
      type="button"
      onClick={onBackToBoard}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] xl:hidden"
      aria-label="Back to board"
      title="Back to board"
    >
      <ChevronLeft className="h-4 w-4" />
    </button>
  ) : null;

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
      <section className={rootClassName}>
        {mobileBackButton ? (
          <div className="flex h-[33px] items-center gap-2 border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 text-[12px] text-[var(--vk-text-muted)] xl:hidden">
            {mobileBackButton}
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Dispatcher</span>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading dispatcher...
        </div>
      </section>
    );
  }

  if (!dispatcherSession) {
    return (
      <section className={rootClassName}>
        <div className="flex h-[33px] items-center gap-2 border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 text-[12px] text-[var(--vk-text-muted)]">
          {mobileBackButton}
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
                Dispatcher runtime
              </p>
              <DispatcherPreferenceChips
                agent={draftRuntimeAgent}
                agentOptions={DISPATCHER_RUNTIME_AGENT_OPTIONS}
                agentLabel="Runtime agent"
                modelSelection={draftRuntimeModelSelection}
                modelAccess={modelAccess}
                runtimeModelCatalogs={runtimeModelCatalogs}
                disabled={creating}
                onAgentChange={(nextAgent) => {
                  setDraftRuntimeAgent(nextAgent);
                  setDraftRuntimeModelSelection(
                    buildModelSelection(nextAgent, modelAccess, runtimeModelCatalogs, null, null),
                  );
                }}
                onModelSelectionChange={setDraftRuntimeModelSelection}
              />
            </div>
            <div className="mt-3 rounded-[12px] border border-[var(--vk-border)] bg-[rgba(0,0,0,0.16)] p-3 text-left">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                Default task handoff
              </p>
              <DispatcherPreferenceChips
                agent={draftImplementationAgent}
                agentOptions={DISPATCHER_HANDOFF_AGENT_OPTIONS}
                agentLabel="Handoff agent"
                modelSelection={draftImplementationModelSelection}
                modelAccess={modelAccess}
                runtimeModelCatalogs={runtimeModelCatalogs}
                disabled={creating}
                onAgentChange={(nextAgent) => {
                  setDraftImplementationAgent(nextAgent);
                  setDraftImplementationModelSelection(
                    buildModelSelection(nextAgent, modelAccess, runtimeModelCatalogs, null, null),
                  );
                }}
                onModelSelectionChange={setDraftImplementationModelSelection}
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
    <section className={rootClassName}>
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
          onThreadUpdated={(thread) => {
            setDispatcherThreads((current) => upsertDispatcherThread(current, thread));
          }}
          deletingThreadId={deletingThreadId}
          onStartNewConversation={handleOpenCreateDialog}
          creatingConversation={creating}
          onToggleCollapse={onToggleCollapsed}
          onBackToBoard={onBackToBoard}
          className="w-full border-l-0 border-t-0 xl:w-full"
        />
      </div>
      {showCreateDialog ? (
        <CreateDispatcherConversationDialog
          creating={creating}
          error={error}
          onCancel={() => {
            if (!creating) {
              setShowCreateDialog(false);
            }
          }}
          onConfirm={() => void handleCreate(true)}
          runtimeAgent={draftRuntimeAgent}
          runtimeModelSelection={draftRuntimeModelSelection}
          implementationAgent={draftImplementationAgent}
          implementationModelSelection={draftImplementationModelSelection}
          modelAccess={modelAccess}
          runtimeModelCatalogs={runtimeModelCatalogs}
          onRuntimeAgentChange={(nextAgent) => {
            setDraftRuntimeAgent(nextAgent);
            setDraftRuntimeModelSelection(
              buildModelSelection(nextAgent, modelAccess, runtimeModelCatalogs, null, null),
            );
          }}
          onRuntimeModelSelectionChange={setDraftRuntimeModelSelection}
          onImplementationAgentChange={(nextAgent) => {
            setDraftImplementationAgent(nextAgent);
            setDraftImplementationModelSelection(
              buildModelSelection(nextAgent, modelAccess, runtimeModelCatalogs, null, null),
            );
          }}
          onImplementationModelSelectionChange={setDraftImplementationModelSelection}
        />
      ) : null}
    </section>
  );
}
