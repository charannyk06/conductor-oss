"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ListTodo, Loader2, PencilLine } from "lucide-react";
import { DispatcherPreferenceChips } from "@/components/dispatcher/DispatcherPreferenceChips";
import { SessionChatDock } from "@/components/sessions/SessionChatDock";
import {
  buildModelSelection,
  resolveModelSelectionValue,
  resolveReasoningSelectionValue,
  type ModelSelectionState,
} from "@/lib/agentModelSelection";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { cn } from "@/lib/cn";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";
import type { DashboardSession } from "@/lib/types";

type DispatcherChatDockProps = {
  thread: DashboardSession;
  threads: DashboardSession[];
  projectId: string;
  bridgeId?: string | null;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  onSelectThread?: (threadId: string) => void;
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

function baseName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
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

function summarizeThread(thread: DashboardSession): string {
  const summary = thread.summary?.trim() || thread.metadata.summary?.trim();
  if (summary) {
    return summary;
  }
  if (thread.status === "needs_input") {
    return "Waiting for follow-up";
  }
  if (thread.status === "working") {
    return "Working";
  }
  return `Conversation ${thread.id.slice(0, 8)}`;
}

function DispatcherBadge({
  label,
  title,
  tone = "neutral",
}: {
  label: string;
  title?: string;
  tone?: "neutral" | "active" | "warn";
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
        tone === "active" && "border-[rgba(120,194,142,0.28)] bg-[rgba(28,58,36,0.88)] text-[#c8e9d0]",
        tone === "warn" && "border-[rgba(214,163,126,0.28)] bg-[rgba(66,44,35,0.94)] text-[#f2d9cd]",
        tone === "neutral" && "border-[rgba(255,255,255,0.08)] bg-[#272220] text-[#d7d0c6]",
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

export function DispatcherChatDock({
  thread,
  threads,
  projectId,
  bridgeId,
  modelAccess,
  runtimeModelCatalogs,
  onSelectThread,
  onStartNewConversation,
  creatingConversation = false,
  onToggleCollapse,
  className,
}: DispatcherChatDockProps) {
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
  const heartbeatState = useMemo(
    () => readMetadataValue(thread, "acpHeartbeatState", "active").toLowerCase(),
    [thread],
  );
  const nextHeartbeatAt = useMemo(
    () => readMetadataValue(thread, "acpNextHeartbeatAt"),
    [thread],
  );
  const projectMemoryPath = useMemo(
    () => readMetadataValue(thread, "acpProjectMemoryPath"),
    [thread],
  );
  const sessionMemoryPath = useMemo(
    () => readMetadataValue(thread, "acpSessionMemoryPath"),
    [thread],
  );
  const [implementationAgent, setImplementationAgent] = useState(preferredImplementationAgent);
  const [modelSelection, setModelSelection] = useState<ModelSelectionState>(() =>
    buildModelSelection(
      preferredImplementationAgent,
      modelAccess,
      runtimeModelCatalogs,
      preferredImplementationModel || null,
      preferredImplementationReasoning || null,
    ));
  const [updatingPreferences, setUpdatingPreferences] = useState(false);

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

  const threadQuery = useMemo(
    () => `threadId=${encodeURIComponent(thread.id)}`,
    [thread.id],
  );

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

  const headerActions = (
    <>
      {threads.length > 1 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
              aria-label="Switch conversation"
              title="Switch conversation"
            >
              <ListTodo className="h-3.5 w-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="z-50 min-w-[300px] rounded-[12px] border border-[rgba(255,255,255,0.08)] bg-[#1c1a19] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
            >
              <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
                Conversations
              </div>
              {threads.map((candidate) => {
                const selected = candidate.id === thread.id;
                return (
                  <DropdownMenu.Item
                    key={candidate.id}
                    onSelect={() => onSelectThread?.(candidate.id)}
                    className="flex min-h-[52px] cursor-default items-start gap-3 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)]"
                  >
                    <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[rgba(255,255,255,0.72)]">
                      {selected ? <Check className="h-3 w-3" /> : <ListTodo className="h-3 w-3" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {summarizeThread(candidate)}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[rgba(255,255,255,0.58)]">
                        <span>{formatRelativeTimestamp(candidate.lastActivityAt)}</span>
                        <span className="truncate">{candidate.id.slice(0, 8)}</span>
                      </div>
                    </div>
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
      {onStartNewConversation ? (
        <button
          type="button"
          onClick={onStartNewConversation}
          disabled={creatingConversation}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Start new conversation"
          title="Start new conversation"
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

  const composerToolbar = (
    <div className="space-y-2">
      <DispatcherPreferenceChips
        implementationAgent={implementationAgent}
        modelSelection={modelSelection}
        modelAccess={modelAccess}
        runtimeModelCatalogs={runtimeModelCatalogs}
        disabled={updatingPreferences}
        onImplementationAgentChange={handleImplementationAgentChange}
        onModelSelectionChange={handleModelSelectionChange}
      />
      <div className="flex flex-wrap gap-2">
        <DispatcherBadge
          label={heartbeatState === "due" ? "Heartbeat due" : "Heartbeat active"}
          title={nextHeartbeatAt ? `Next heartbeat: ${nextHeartbeatAt}` : "ACP heartbeat status"}
          tone={heartbeatState === "due" ? "warn" : "active"}
        />
        {projectMemoryPath ? (
          <DispatcherBadge
            label={`Long-term memory: ${baseName(projectMemoryPath)}`}
            title={projectMemoryPath}
          />
        ) : null}
        {sessionMemoryPath ? (
          <DispatcherBadge
            label={`Short-term memory: ${baseName(sessionMemoryPath)}`}
            title={sessionMemoryPath}
          />
        ) : null}
      </div>
    </div>
  );

  return (
    <SessionChatDock
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
  );
}
