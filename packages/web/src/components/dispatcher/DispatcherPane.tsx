"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ListTodo, Loader2, PencilLine, Trash2 } from "lucide-react";
import { DispatcherPreferenceChips } from "@/components/dispatcher/DispatcherPreferenceChips";
import { DispatcherSessionPane } from "@/components/dispatcher/DispatcherSessionPane";
import { Button } from "@/components/ui/Button";
import {
  buildModelSelection,
  resolveModelSelectionValue,
  resolveReasoningSelectionValue,
  type ModelSelectionState,
} from "@/lib/agentModelSelection";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";
import type { DashboardSession } from "@/lib/types";

type DispatcherPaneProps = {
  thread: DashboardSession;
  threads?: DashboardSession[];
  projectId: string;
  bridgeId?: string | null;
  modelAccess?: ModelAccessPreferences;
  runtimeModelCatalogs?: Record<string, RuntimeAgentModelCatalog>;
  onSelectThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void | Promise<void>;
  deletingThreadId?: string | null;
  onStartNewConversation?: () => void;
  creatingConversation?: boolean;
  onToggleCollapse?: () => void;
  className?: string;
};

function readMetadataValue(
  thread: DashboardSession,
  key: string,
  fallback = "",
): string {
  const value = thread.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function formatRelativeTimestamp(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "Recently";
  }

  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return "Just now";
  }
  if (elapsedSeconds < 3600) {
    return `${Math.floor(elapsedSeconds / 60)}m ago`;
  }
  if (elapsedSeconds < 86400) {
    return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  }
  return `${Math.floor(elapsedSeconds / 86400)}d ago`;
}

function normalizeThreadSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeThread(thread: DashboardSession): string {
  const summary = normalizeThreadSummary(thread.summary?.trim() || thread.metadata.summary?.trim() || "");
  if (summary) {
    return summary;
  }
  if (thread.status === "needs_input") {
    return "Waiting for follow-up";
  }
  if (thread.status === "working") {
    return "Working";
  }
  return `Thread ${thread.id.slice(0, 8)}`;
}

type DeleteDispatcherThreadDialogProps = {
  thread: DashboardSession;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

function DeleteDispatcherThreadDialog({
  thread,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DeleteDispatcherThreadDialogProps) {
  if (typeof document === "undefined") {
    return null;
  }

  const summary = summarizeThread(thread);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4"
      onClick={() => {
        if (deleting) return;
        onCancel();
      }}
    >
      <div
        className="surface-card w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_28px_90px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dispatcher-thread-title"
      >
        <div className="border-b border-[var(--vk-border)] px-4 py-3">
          <h2
            id="delete-dispatcher-thread-title"
            className="text-[17px] font-medium text-[var(--vk-text-strong)]"
          >
            Delete Dispatcher Thread
          </h2>
          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
            Delete thread <span className="font-medium text-[var(--vk-text-normal)]">{thread.id.slice(0, 8)}</span> from this project.
          </p>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-[13px] leading-5 text-[var(--vk-text-normal)]">
            This removes the dispatcher conversation and its saved thread state. Repository files on disk are not changed.
          </p>

          <div className="rounded-[var(--radius-md)] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
              Thread summary
            </p>
            <p className="mt-1 line-clamp-4 text-[13px] leading-5 text-[var(--vk-text-normal)]">
              {summary}
            </p>
          </div>

          {error ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--vk-red)]/35 bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={() => void onConfirm()} disabled={deleting}>
            {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Delete Thread
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function DispatcherPane({
  thread,
  threads = [],
  projectId,
  bridgeId,
  modelAccess = {} as ModelAccessPreferences,
  runtimeModelCatalogs = {},
  onSelectThread,
  onDeleteThread,
  deletingThreadId = null,
  onStartNewConversation,
  creatingConversation = false,
  onToggleCollapse,
  className,
}: DispatcherPaneProps) {
  const preferredImplementationAgent = useMemo(
    () => readMetadataValue(thread, "acpImplementationAgent", "codex"),
    [thread],
  );
  const preferredImplementationModel = useMemo(
    () => readMetadataValue(thread, "acpImplementationModel"),
    [thread],
  );
  const preferredImplementationReasoning = useMemo(
    () => readMetadataValue(thread, "acpImplementationReasoningEffort"),
    [thread],
  );
  const [implementationAgent, setImplementationAgent] = useState(preferredImplementationAgent);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [confirmDeleteThreadId, setConfirmDeleteThreadId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelectionState>(() =>
    buildModelSelection(
      preferredImplementationAgent,
      modelAccess,
      runtimeModelCatalogs,
      preferredImplementationModel || null,
      preferredImplementationReasoning || null,
    ));
  const [updatingPreferences, setUpdatingPreferences] = useState(false);
  const showPreferenceEditor = Object.keys(runtimeModelCatalogs).length > 0;

  useEffect(() => {
    setImplementationAgent(preferredImplementationAgent);
    setModelSelection(
      buildModelSelection(
        preferredImplementationAgent,
        modelAccess,
        runtimeModelCatalogs,
        preferredImplementationModel || null,
        preferredImplementationReasoning || null,
      ),
    );
  }, [
    modelAccess,
    preferredImplementationAgent,
    preferredImplementationModel,
    preferredImplementationReasoning,
    runtimeModelCatalogs,
  ]);

  const confirmDeleteThread = useMemo(
    () => threads.find((candidate) => candidate.id === confirmDeleteThreadId) ?? null,
    [confirmDeleteThreadId, threads],
  );

  useEffect(() => {
    if (confirmDeleteThreadId && !confirmDeleteThread) {
      setConfirmDeleteThreadId(null);
      setDeleteError(null);
    }
  }, [confirmDeleteThread, confirmDeleteThreadId]);

  const threadQuery = useMemo(
    () => `threadId=${encodeURIComponent(thread.id)}`,
    [thread.id],
  );
  const showThreadMenu = threads.length > 0 && (threads.length > 1 || Boolean(onDeleteThread));

  const persistPreferences = useCallback(
    async (nextAgent: string, nextSelection: ModelSelectionState) => {
      setUpdatingPreferences(true);
      try {
        const response = await fetch(
          withBridgeQuery(
            `/api/projects/${projectId}/dispatcher/preferences?${threadQuery}`,
            bridgeId,
          ),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              implementationAgent: nextAgent,
              implementationModel: resolveModelSelectionValue(nextSelection) ?? "",
              implementationReasoningEffort:
                resolveReasoningSelectionValue(nextSelection) ?? "",
            }),
          },
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "Failed to update dispatcher preferences");
        }
      } finally {
        setUpdatingPreferences(false);
      }
    },
    [bridgeId, projectId, threadQuery],
  );

  const handleImplementationAgentChange = useCallback(
    (nextAgent: string) => {
      const nextSelection = buildModelSelection(
        nextAgent,
        modelAccess,
        runtimeModelCatalogs,
        null,
        null,
      );
      setImplementationAgent(nextAgent);
      setModelSelection(nextSelection);
      void persistPreferences(nextAgent, nextSelection);
    },
    [modelAccess, persistPreferences, runtimeModelCatalogs],
  );

  const handleModelSelectionChange = useCallback(
    (nextSelection: ModelSelectionState) => {
      setModelSelection(nextSelection);
      void persistPreferences(implementationAgent, nextSelection);
    },
    [implementationAgent, persistPreferences],
  );

  const handleConfirmDeleteThread = useCallback(async () => {
    if (!confirmDeleteThread || !onDeleteThread) {
      return;
    }

    setDeleteError(null);
    try {
      await onDeleteThread(confirmDeleteThread.id);
      setConfirmDeleteThreadId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete dispatcher thread");
    }
  }, [confirmDeleteThread, onDeleteThread]);

  const headerActions = (
    <>
      {showThreadMenu ? (
        <DropdownMenu.Root open={threadMenuOpen} onOpenChange={setThreadMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] sm:h-6 sm:w-6 sm:rounded-[3px]"
              aria-label="Open dispatcher threads"
              title="Open dispatcher threads"
            >
              <ListTodo className="h-3.5 w-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              collisionPadding={8}
              sideOffset={8}
              className="z-50 w-[calc(100vw-1rem)] max-w-[26rem] overflow-hidden rounded-[12px] border border-[rgba(255,255,255,0.08)] bg-[#1c1a19] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
            >
              <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
                Threads
              </div>
              <div className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
                {threads.map((candidate) => {
                  const selected = candidate.id === thread.id;
                  const deleting = deletingThreadId === candidate.id;
                  const summary = summarizeThread(candidate);
                  return (
                    <div key={candidate.id} className="flex items-stretch gap-2">
                      <DropdownMenu.Item asChild>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectThread?.(candidate.id);
                            setThreadMenuOpen(false);
                          }}
                          disabled={deleting}
                          className="flex min-h-[64px] min-w-0 flex-1 items-start gap-3 rounded-[10px] px-3 py-3 text-left text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[rgba(255,255,255,0.72)]">
                            {selected ? <Check className="h-3 w-3" /> : <ListTodo className="h-3 w-3" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block line-clamp-2 break-words text-[13px] font-medium leading-5">
                              {summary}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[rgba(255,255,255,0.58)]">
                              <span>{formatRelativeTimestamp(candidate.lastActivityAt)}</span>
                              <span className="truncate">{candidate.id.slice(0, 8)}</span>
                            </span>
                          </span>
                        </button>
                      </DropdownMenu.Item>
                      {onDeleteThread ? (
                        <button
                          type="button"
                          onClick={() => {
                            setThreadMenuOpen(false);
                            setDeleteError(null);
                            setConfirmDeleteThreadId(candidate.id);
                          }}
                          disabled={Boolean(deletingThreadId)}
                          className="inline-flex w-11 shrink-0 items-center justify-center rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[rgba(255,255,255,0.68)] transition hover:border-[rgba(210,81,81,0.4)] hover:bg-[rgba(210,81,81,0.12)] hover:text-[#f08b8b] disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Delete dispatcher thread ${candidate.id.slice(0, 8)}`}
                          title="Delete thread"
                        >
                          {deleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
      {onStartNewConversation ? (
        <button
          type="button"
          onClick={onStartNewConversation}
          disabled={creatingConversation}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] disabled:cursor-not-allowed disabled:opacity-60 sm:h-6 sm:w-6 sm:rounded-[3px]"
          aria-label="Start new dispatcher thread"
          title="Start new dispatcher thread"
        >
          {creatingConversation ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PencilLine className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
    </>
  );

  const composerToolbar = showPreferenceEditor ? (
    <DispatcherPreferenceChips
      implementationAgent={implementationAgent}
      modelSelection={modelSelection}
      modelAccess={modelAccess}
      runtimeModelCatalogs={runtimeModelCatalogs}
      disabled={updatingPreferences}
      onImplementationAgentChange={handleImplementationAgentChange}
      onModelSelectionChange={handleModelSelectionChange}
    />
  ) : null;

  return (
    <>
      <DispatcherSessionPane
        session={thread}
        bridgeId={bridgeId}
        onToggleCollapse={onToggleCollapse}
        className={className}
        hideOpenSessionAction
        hideRepositoryControls
        hideSessionStatusBadge
        headerActions={headerActions}
        composerToolbar={composerToolbar}
        apiPaths={{
          feed: `/api/projects/${encodeURIComponent(projectId)}/dispatcher/feed?limit=120&${threadQuery}`,
          stream: `/api/projects/${encodeURIComponent(projectId)}/dispatcher/feed/stream?limit=120&${threadQuery}`,
          send: `/api/projects/${encodeURIComponent(projectId)}/dispatcher/send?${threadQuery}`,
          interrupt: `/api/projects/${encodeURIComponent(projectId)}/dispatcher/interrupt?${threadQuery}`,
        }}
      />
      {confirmDeleteThread ? (
        <DeleteDispatcherThreadDialog
          thread={confirmDeleteThread}
          deleting={deletingThreadId === confirmDeleteThread.id}
          error={deleteError}
          onCancel={() => {
            if (deletingThreadId) return;
            setConfirmDeleteThreadId(null);
            setDeleteError(null);
          }}
          onConfirm={handleConfirmDeleteThread}
        />
      ) : null}
    </>
  );
}
