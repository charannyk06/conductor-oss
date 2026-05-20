"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  ListTodo,
  Loader2,
  LoaderCircle,
  PencilLine,
  Search,
  Send,
  Sparkles,
  Terminal,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { Button } from "@/components/ui/Button";
import { getDisplaySessionId } from "@/lib/bridgeSessionIds";
import { cn } from "@/lib/cn";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { buildSessionHref } from "@/lib/dashboardHref";
import {
  dispatchProjectBoardRefresh,
  findDispatcherBoardRefreshReason,
} from "@/lib/dispatcherBoardRefresh";
import { getKnownAgent, KNOWN_AGENTS } from "@/lib/knownAgents";
import { useAgents, type Agent } from "@/hooks/useAgents";
import { iterateSseFrames } from "@/lib/sseFetch";
import { isDispatcherFeedNearBottom } from "@/components/dispatcher/dispatcherFeedScroll";
import type { TerminalInsertRequest } from "@/components/sessions/terminalInsert";
import type { DashboardSession } from "@/lib/types";
import type { SessionRuntimeStatus } from "@/lib/sessionRuntimeStatus";
import {
  EMPTY_FEED_PAYLOAD,
  applyFeedDelta,
  type DispatcherFeedIntegration,
  type FeedDeltaEvent,
  type FeedEntryKind,
  type SessionFeedEntry,
  type SessionFeedPayload,
  type SessionParserState,
} from "./dispatcherFeedState";

type DispatcherSessionPaneProps = {
  session: DashboardSession;
  bridgeId?: string | null;
  active?: boolean;
  onClose?: () => void;
  onToggleCollapse?: () => void;
  className?: string;
  hideOpenSessionAction?: boolean;
  hideRepositoryControls?: boolean;
  hideSessionStatusBadge?: boolean;
  headerActions?: ReactNode;
  composerInsert?: TerminalInsertRequest | null;
  composerToolbar?: ReactNode;
  apiPaths: DispatcherSessionPaneApiPaths;
};

type DispatcherSessionPaneApiPaths = {
  feed: string;
  stream: string;
  send: string;
  interrupt?: string | null;
  approve?: string | null;
  reject?: string | null;
  repositories?: string;
  /** PATCH OpenClaw (or other orchestrator) thread/session binding */
  integration?: string;
};

type RepositoryPathHealth = {
  exists: boolean;
  isGitRepository: boolean;
  suggestedPath: string | null;
};

type RepositorySettingsPayload = {
  id: string;
  displayName: string;
  repo: string;
  path: string;
  agent: string;
  agentPermissions: string;
  agentModel: string;
  agentReasoningEffort: string;
  workspaceMode: string;
  runtimeMode: string;
  scmMode: string;
  defaultWorkingDirectory: string;
  defaultBranch: string;
  devServerScript: string;
  devServerCwd: string;
  devServerUrl: string;
  devServerPort: string;
  devServerHost: string;
  devServerPath: string;
  devServerHttps: boolean;
  setupScript: string;
  runSetupInParallel: boolean;
  cleanupScript: string;
  archiveScript: string;
  copyFiles: string;
  pathHealth: RepositoryPathHealth;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map((item) => readString(item))
      .filter((item): item is string => item !== null)
    : [];
}

function normalizeFeedEntry(value: unknown): SessionFeedEntry | null {
  const record = asRecord(value);
  const id = readString(record.id);
  const kind = readString(record.kind) as FeedEntryKind | null;
  const text = typeof record.text === "string" ? record.text : "";
  if (!id || !kind) {
    return null;
  }

  return {
    id,
    kind,
    label: readString(record.label) ?? "Session",
    text,
    createdAt: readString(record.createdAt),
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    source: readString(record.source) ?? "session",
    streaming: record.streaming === true,
    metadata: asRecord(record.metadata),
  };
}

function normalizeParserState(value: unknown): SessionParserState | null {
  const record = asRecord(value);
  const kind = readString(record.kind);
  if (!kind) {
    return null;
  }

  return {
    kind,
    message: typeof record.message === "string" ? record.message : "",
    command: readString(record.command),
  };
}

function normalizeRuntimeStatus(value: unknown): SessionRuntimeStatus | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return record as SessionRuntimeStatus;
}

function normalizeIntegration(value: unknown): DispatcherFeedIntegration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const oc = asRecord(record.openclaw);
  const hb = asRecord(record.heartbeat);
  const mem = asRecord(record.memory);
  const projectId = readString(record.projectId);
  const threadId = readString(record.threadId);
  if (!projectId || !threadId) {
    return null;
  }
  return {
    projectId,
    threadId,
    bridgeId: record.bridgeId === null ? null : readString(record.bridgeId),
    openclaw: {
      threadId: oc.threadId === null ? null : readString(oc.threadId),
      sessionId: oc.sessionId === null ? null : readString(oc.sessionId),
    },
    heartbeat: {
      state: hb.state === null ? null : readString(hb.state),
      nextAt: hb.nextAt === null ? null : readString(hb.nextAt),
    },
    memory: {
      projectPath: mem.projectPath === null ? null : readString(mem.projectPath),
      sessionPath: mem.sessionPath === null ? null : readString(mem.sessionPath),
    },
  };
}

function normalizeFeedPayload(value: unknown): SessionFeedPayload {
  const record = asRecord(value);
  return {
    entries: Array.isArray(record.entries)
      ? record.entries.map(normalizeFeedEntry).filter((entry): entry is SessionFeedEntry => entry !== null)
      : [],
    totalEntries: typeof record.totalEntries === "number" ? record.totalEntries : 0,
    windowLimit: typeof record.windowLimit === "number" ? record.windowLimit : 120,
    truncated: record.truncated === true,
    sessionStatus: readString(record.sessionStatus),
    approvalState: readString(record.approvalState),
    parserState: normalizeParserState(record.parserState),
    runtimeStatus: normalizeRuntimeStatus(record.runtimeStatus),
    source: readString(record.source),
    error: readString(record.error),
    integration: normalizeIntegration(record.integration),
  };
}

function normalizeFeedDelta(value: unknown): FeedDeltaEvent | null {
  const record = asRecord(value);
  const type = readString(record.type);
  /** Backend sends the first SSE frame as a raw feed JSON object (no `type` field). */
  if (!type && Array.isArray(record.entries)) {
    return { type: "replace", payload: normalizeFeedPayload(value) };
  }
  if (type === "replace") {
    return {
      type,
      payload: normalizeFeedPayload(record.payload),
    };
  }
  if (type === "append") {
    const payload = normalizeFeedPayload(record);
    return {
      type,
      entries: payload.entries,
      totalEntries: payload.totalEntries,
      windowLimit: payload.windowLimit,
      truncated: payload.truncated,
      sessionStatus: payload.sessionStatus,
      approvalState: payload.approvalState,
      parserState: payload.parserState,
      runtimeStatus: payload.runtimeStatus,
      source: payload.source,
      error: payload.error,
      integration: payload.integration,
    };
  }
  if (type === "patch") {
    const entryId = readString(record.entryId);
    if (!entryId) {
      return null;
    }
    return {
      type,
      entryId,
      entry: normalizeFeedEntry(record.entry),
      textDelta: typeof record.textDelta === "string" ? record.textDelta : null,
      totalEntries: typeof record.totalEntries === "number" ? record.totalEntries : 0,
      windowLimit: typeof record.windowLimit === "number" ? record.windowLimit : 120,
      truncated: record.truncated === true,
      sessionStatus: readString(record.sessionStatus),
      approvalState: readString(record.approvalState),
      parserState: normalizeParserState(record.parserState),
      runtimeStatus: normalizeRuntimeStatus(record.runtimeStatus),
      source: readString(record.source),
      error: readString(record.error),
      integration: normalizeIntegration(record.integration),
    };
  }
  return null;
}

function normalizeRepositorySettings(value: unknown): RepositorySettingsPayload | null {
  const record = asRecord(value);
  const id = readString(record.id);
  const repo = readString(record.repo);
  const path = readString(record.path);
  if (!id || !repo || !path) {
    return null;
  }

  const pathHealthRecord = asRecord(record.pathHealth);
  return {
    id,
    displayName: readString(record.displayName) ?? id,
    repo,
    path,
    agent: readString(record.agent) ?? "codex",
    agentPermissions: readString(record.agentPermissions) ?? "skip",
    agentModel: readString(record.agentModel) ?? "",
    agentReasoningEffort: readString(record.agentReasoningEffort) ?? "",
    workspaceMode: readString(record.workspaceMode) ?? "local",
    runtimeMode: readString(record.runtimeMode) ?? "direct",
    scmMode: readString(record.scmMode) ?? "git",
    defaultWorkingDirectory: readString(record.defaultWorkingDirectory) ?? "",
    defaultBranch: readString(record.defaultBranch) ?? "main",
    devServerScript: readString(record.devServerScript) ?? "",
    devServerCwd: readString(record.devServerCwd) ?? "",
    devServerUrl: readString(record.devServerUrl) ?? "",
    devServerPort: readString(record.devServerPort) ?? "",
    devServerHost: readString(record.devServerHost) ?? "",
    devServerPath: readString(record.devServerPath) ?? "",
    devServerHttps: record.devServerHttps === true,
    setupScript: readString(record.setupScript) ?? "",
    runSetupInParallel: record.runSetupInParallel === true,
    cleanupScript: readString(record.cleanupScript) ?? "",
    archiveScript: readString(record.archiveScript) ?? "",
    copyFiles: readString(record.copyFiles) ?? "",
    pathHealth: {
      exists: pathHealthRecord.exists === true,
      isGitRepository: pathHealthRecord.isGitRepository === true,
      suggestedPath: readString(pathHealthRecord.suggestedPath),
    },
  };
}

function formatEntryTime(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) {
    return "just now";
  }
  if (diffMs < 3_600_000) {
    return `${Math.max(1, Math.floor(diffMs / 60_000))}m ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function truncateInline(value: string, maxLength = 84): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function ExpandableInlineText({
  value,
  maxLength = 84,
  className,
}: {
  value: string;
  maxLength?: number;
  className?: string;
}) {
  const normalized = value.trim();
  const canExpand = normalized.length > maxLength || value.includes("\n");
  const [expanded, setExpanded] = useState(false);

  if (!canExpand) {
    return <span className={className}>{normalized}</span>;
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded((current) => !current)}
      aria-expanded={expanded}
      title={expanded ? "Collapse text" : "Expand text"}
      className={cn(
        "max-w-full text-left transition-colors hover:bg-[rgba(255,255,255,0.08)]",
        expanded ? "whitespace-pre-wrap break-words" : "truncate",
        className,
      )}
    >
      {expanded ? normalized : truncateInline(normalized, maxLength)}
    </button>
  );
}

function formatAgentName(value: string): string {
  const known = getKnownAgent(value);
  if (known?.label) {
    return known.label;
  }
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatModelChip(agentName: string, modelValue: string | null): string | null {
  const trimmed = modelValue?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("claude-")) {
    const match = lower.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)/);
    if (match) {
      return `Claude ${match[1][0]?.toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`;
    }
  }
  if (lower.startsWith("gpt-")) {
    return trimmed.toUpperCase().replace(/-/g, " ");
  }
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") {
    return `${formatAgentName(agentName)} ${trimmed[0]?.toUpperCase()}${trimmed.slice(1)}`;
  }
  return trimmed;
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="min-w-0 break-words [overflow-wrap:anywhere]"
      components={{
        h1: ({ children }) => (
          <h1 className="mb-5 text-[22px] font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)] last:mb-0 sm:text-[28px] lg:text-[36px]">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-4 mt-8 text-[20px] font-semibold tracking-[-0.02em] text-[var(--vk-text-strong)] first:mt-0 last:mb-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-3 mt-6 text-[16px] font-semibold text-[var(--vk-text-normal)] first:mt-0 last:mb-0">
            {children}
          </h3>
        ),
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        hr: () => <hr className="my-8 border-0 border-t border-[var(--vk-border)]" />,
        pre: ({ children }) => (
          <pre className="mb-4 overflow-x-auto rounded-[10px] border border-[var(--vk-border)] bg-[#151413] p-3 text-[12px] text-[var(--vk-text-normal)] last:mb-0">
            {children}
          </pre>
        ),
        code: ({ children, className }) => (
          <code
            className={cn(
              "rounded-[6px] bg-[#171615] px-1.5 py-0.5 font-mono text-[12px] text-[var(--vk-text-normal)]",
              className,
            )}
          >
            {children}
          </code>
        ),
        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
        table: ({ children }) => (
          <div className="mb-4 overflow-x-auto rounded-[12px] border border-[var(--vk-border)]">
            <table className="min-w-full border-collapse text-left text-[13px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-[rgba(255,255,255,0.03)]">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-[var(--vk-border)] last:border-b-0">{children}</tr>,
        th: ({ children }) => (
          <th className="px-4 py-3 text-[12px] font-medium text-[var(--vk-text-normal)]">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-4 py-3 align-top text-[13px] text-[var(--vk-text-muted)]">{children}</td>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function AttachmentCard({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "prompt";
}) {
  return (
    <div
      className={cn(
        "mb-3 flex items-center gap-3 rounded-[10px] border px-3 py-2",
        tone === "prompt"
          ? "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.05)] text-[#f4ede7]"
          : "border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] text-[var(--vk-text-normal)]",
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[rgba(0,0,0,0.22)]">
        <FileText className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium">{label}</p>
        <p className="truncate text-[11px] text-[var(--vk-text-muted)]">Attached context</p>
      </div>
    </div>
  );
}

function ToolGlyph({
  toolKind,
  toolTitle,
  className = "h-4 w-4",
}: {
  toolKind: string | null;
  toolTitle: string;
  className?: string;
}) {
  const normalizedTitle = toolTitle.trim().toLowerCase();
  const normalizedKind = toolKind?.trim().toLowerCase() ?? "";

  if (normalizedKind === "thinking" || normalizedTitle === "thinking") {
    return <Braces className={cn(className, "text-[var(--vk-text-normal)]")} />;
  }
  if (
    normalizedKind === "read" ||
    normalizedTitle.startsWith("read ") ||
    normalizedTitle.includes("review request")
  ) {
    return <FileText className={className} />;
  }
  if (
    normalizedKind === "write" ||
    normalizedKind === "edit" ||
    normalizedKind === "multiedit" ||
    normalizedTitle.startsWith("write") ||
    normalizedTitle.startsWith("edit")
  ) {
    return <PencilLine className={className} />;
  }
  if (normalizedKind === "grep" || normalizedKind === "search" || normalizedKind === "find") {
    return <Search className={className} />;
  }
  if (normalizedKind === "ls" || normalizedKind === "glob" || normalizedKind === "open") {
    return <FolderOpen className={className} />;
  }
  if (normalizedKind === "websearch" || normalizedKind === "webfetch") {
    return <Globe className={className} />;
  }
  if (normalizedKind === "task" || normalizedKind === "todowrite") {
    return <ListTodo className={className} />;
  }
  if (
    normalizedTitle.includes("diff") ||
    normalizedTitle.includes("workspace diff") ||
    normalizedTitle.includes("git diff")
  ) {
    return <GitBranch className={className} />;
  }
  if (
    normalizedKind === "bash" ||
    normalizedKind === "command" ||
    normalizedTitle.startsWith("get diff") ||
    normalizedTitle.startsWith("run ")
  ) {
    return <TerminalSquare className={className} />;
  }

  return <Wrench className={className} />;
}

type DispatcherLifecycleEvent = {
  operation: "create" | "update" | "handoff";
  taskId: string;
  taskRef: string;
  taskTitle: string;
  taskRoleLabel: string | null;
  taskAgent: string | null;
  taskType: string | null;
};

function readDispatcherLifecycleEvent(entry: SessionFeedEntry): DispatcherLifecycleEvent | null {
  if (entry.kind !== "system") {
    return null;
  }

  const eventType = readString(entry.metadata.eventType);
  let operation: DispatcherLifecycleEvent["operation"] | null = null;
  if (eventType === "dispatcher_task_created") {
    operation = "create";
  } else if (eventType === "dispatcher_task_updated") {
    operation = "update";
  } else if (eventType === "dispatcher_task_handed_off") {
    operation = "handoff";
  }

  if (!operation) {
    return null;
  }

  const taskId = readString(entry.metadata.taskId);
  const taskRef = readString(entry.metadata.taskRef) ?? taskId;
  const taskTitle = readString(entry.metadata.taskTitle);
  if (!taskId || !taskRef || !taskTitle) {
    return null;
  }

  return {
    operation,
    taskId,
    taskRef,
    taskTitle,
    taskRoleLabel: readString(entry.metadata.taskRoleLabel),
    taskAgent: readString(entry.metadata.taskAgent),
    taskType: readString(entry.metadata.taskType),
  };
}

function dispatcherLifecycleHeadline(operation: DispatcherLifecycleEvent["operation"]): string {
  switch (operation) {
    case "create":
      return "Task created";
    case "update":
      return "Task updated";
    case "handoff":
      return "Task handed off";
  }
}

function SessionFeedMessage({
  entry,
  session,
}: {
  entry: SessionFeedEntry;
  session: DashboardSession;
}) {
  const timestamp = formatEntryTime(entry.createdAt);
  const label = entry.kind === "assistant"
    ? (entry.source === "runtime" ? "Thinking" : formatAgentName(session.metadata.agent?.trim() || "assistant"))
    : entry.label || "Session";
  const attachments = entry.attachments
    .map((attachment) => {
      const record = asRecord(attachment);
      return readString(record.name) ?? readString(record.path) ?? (typeof attachment === "string" ? attachment : null);
    })
    .filter((value): value is string => Boolean(value));
  const toolTitle = readString(entry.metadata.toolTitle) ?? entry.text;
  const toolKind = readString(entry.metadata.toolKind)?.toLowerCase() ?? null;
  const toolContent = readStringArray(entry.metadata.toolContent);
  const toolPrimary = toolContent[0] ?? null;
  const toolSecondary = toolContent[1] ?? null;
  const isRuntimeThinking = entry.kind === "assistant" && entry.source === "runtime";
  const isSessionStatus = entry.kind === "status" && entry.source === "session-status";
  const lifecycleEvent = readDispatcherLifecycleEvent(entry);

  if (entry.kind === "tool") {
    return (
      <div className="flex items-start gap-3 text-[13px] text-[var(--vk-text-muted)]">
        <div className="mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center text-[var(--vk-text-muted)]">
          <ToolGlyph toolKind={toolKind} toolTitle={toolTitle} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[var(--vk-text-normal)]">{toolTitle || "Tool call"}</span>
            {toolPrimary ? (
              <ExpandableInlineText
                value={toolPrimary}
                maxLength={72}
                className="rounded-[6px] bg-[rgba(255,255,255,0.05)] px-2 py-0.5 font-mono text-[11px] text-[var(--vk-text-muted)]"
              />
            ) : null}
            {timestamp ? (
              <span className="ml-auto text-[11px] text-[var(--vk-text-muted)]">{timestamp}</span>
            ) : null}
          </div>
          {toolSecondary ? (
            <ExpandableInlineText
              value={toolSecondary}
              maxLength={140}
              className="block rounded-[6px] bg-[rgba(255,255,255,0.03)] px-2 py-1 text-[12px] leading-5 text-[var(--vk-text-muted)]"
            />
          ) : null}
        </div>
      </div>
    );
  }

  if (lifecycleEvent) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[12px] text-[var(--vk-text-muted)]">
          <ListTodo className="h-3.5 w-3.5" />
          <span>{dispatcherLifecycleHeadline(lifecycleEvent.operation)}</span>
          {timestamp ? <span className="ml-auto text-[11px]">{timestamp}</span> : null}
        </div>
        <div className="rounded-[12px] border border-[rgba(129,101,83,0.35)] bg-[rgba(62,47,40,0.72)] px-4 py-3 text-[15px] leading-6 text-[#efe4dc]">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
                {dispatcherLifecycleHeadline(lifecycleEvent.operation)}
              </p>
              <p className="mt-1 break-words text-[16px] font-semibold text-[#fff5ee]">
                {lifecycleEvent.taskTitle}
              </p>
            </div>
            <span className="rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.06)] px-2.5 py-1 text-[11px] font-medium text-[#fff5ee]">
              {lifecycleEvent.taskRef}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[rgba(255,255,255,0.72)]">
            {lifecycleEvent.taskRoleLabel ? (
              <span className="rounded-full bg-[rgba(255,255,255,0.08)] px-2.5 py-1">
                {lifecycleEvent.taskRoleLabel}
              </span>
            ) : null}
            {lifecycleEvent.taskAgent ? (
              <span className="rounded-full bg-[rgba(255,255,255,0.08)] px-2.5 py-1">
                {formatAgentName(lifecycleEvent.taskAgent)}
              </span>
            ) : null}
            {lifecycleEvent.taskType ? (
              <span className="rounded-full bg-[rgba(255,255,255,0.08)] px-2.5 py-1">
                {lifecycleEvent.taskType}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (isRuntimeThinking) {
    return (
      <div className="flex items-start gap-3 text-[13px] text-[var(--vk-text-muted)]">
        <div className="mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center text-[var(--vk-text-muted)]">
          <Braces className="h-4 w-4 text-[var(--vk-text-normal)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[var(--vk-text-normal)]">Thinking</span>
            {entry.text.trim().length > 0 ? (
              <ExpandableInlineText
                value={entry.text}
                maxLength={96}
                className="rounded-[6px] bg-[rgba(255,255,255,0.05)] px-2 py-0.5 font-mono text-[11px] text-[var(--vk-text-muted)]"
              />
            ) : null}
            {timestamp ? (
              <span className="ml-auto text-[11px] text-[var(--vk-text-muted)]">{timestamp}</span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (isSessionStatus) {
    return (
      <div className="space-y-2">
        <div className="rounded-[22px] border border-[rgba(113,84,68,0.45)] bg-[rgba(54,40,34,0.9)] px-4 py-3 text-[15px] leading-7 text-[#efe4dc] shadow-[0_8px_18px_rgba(0,0,0,0.14)]">
          <MarkdownMessage text={entry.text} />
        </div>
        {timestamp ? <div className="text-right text-[11px] text-[var(--vk-text-muted)]">{timestamp}</div> : null}
      </div>
    );
  }

  if (entry.kind === "user") {
    return (
      <div className="ml-auto max-w-[88%]">
        <div className="rounded-[14px] border border-[rgba(124,94,78,0.45)] bg-[rgba(52,39,35,0.92)] px-4 py-3 text-[#f1e7e0] shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
          {attachments.map((attachment) => (
            <AttachmentCard key={`${entry.id}-${attachment}`} label={attachment} tone="prompt" />
          ))}
          <div className="text-[15px] leading-7 text-[#f4ede7]">
            <MarkdownMessage text={entry.text} />
          </div>
        </div>
        {timestamp ? <div className="mt-1 text-right text-[11px] text-[var(--vk-text-muted)]">{timestamp}</div> : null}
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="space-y-2">
        <div className="text-[15px] leading-8 text-[var(--vk-text-normal)]">
          {attachments.map((attachment) => (
            <AttachmentCard key={`${entry.id}-${attachment}`} label={attachment} />
          ))}
          <MarkdownMessage text={entry.text} />
        </div>
        {timestamp ? <div className="text-[11px] text-[var(--vk-text-muted)]">{timestamp}</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px] text-[var(--vk-text-muted)]">
        {entry.kind === "status" ? <Sparkles className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
        <span>{label}</span>
        {timestamp ? <span className="ml-auto text-[11px]">{timestamp}</span> : null}
      </div>
      <div
        className={cn(
          "rounded-[12px] border px-4 py-3 text-[15px] leading-7",
          "border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] text-[var(--vk-text-muted)]",
        )}
      >
        {attachments.map((attachment) => (
          <AttachmentCard key={`${entry.id}-${attachment}`} label={attachment} />
        ))}
        <MarkdownMessage text={entry.text} />
      </div>
    </div>
  );
}

function ProjectAgentSelect({
  project,
  disabled = false,
  saving = false,
  agents = [],
  onChange,
}: {
  project: RepositorySettingsPayload | null;
  disabled?: boolean;
  saving?: boolean;
  agents?: Agent[];
  onChange: (value: string) => void;
}) {
  const activeAgent = project?.agent?.trim() || "codex";

  // Check if active agent is installed
  const activeAgentInfo = agents.find(
    (a) => a.name.toLowerCase() === activeAgent.toLowerCase()
  );
  const isActiveInstalled = activeAgentInfo ? (activeAgentInfo.installed ?? true) : true;

  const agentsList = agents && agents.length > 0 ? agents : KNOWN_AGENTS;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled || !project}
          className="inline-flex h-10 w-full min-w-0 max-w-full items-center justify-between gap-3 rounded-[8px] border border-[var(--vk-accent)] bg-[color:color-mix(in_srgb,var(--vk-accent)_88%,black_12%)] px-3 text-left text-[13px] text-white shadow-[0_10px_24px_rgba(0,0,0,0.18)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-[220px] sm:w-auto"
          aria-label="Select coding agent"
          title={project ? `Coding agent: ${formatAgentName(activeAgent)}` : "Project agent unavailable"}
        >
          <span className="flex min-w-0 items-center gap-2">
            <AgentTileIcon
              seed={{ label: activeAgent }}
              className="h-5 w-5 border-none bg-transparent"
            />
            <span className="truncate flex items-center gap-1.5">
              {saving ? "Saving agent…" : `Coding Agent · ${formatAgentName(activeAgent)}`}
              {!isActiveInstalled && (
                <span className="inline-flex h-2 w-2 rounded-full bg-[var(--vk-orange)] animate-pulse" title="Not installed" />
              )}
            </span>
          </span>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={8}
          className="z-50 min-w-[250px] max-w-[calc(100vw-2rem)] rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-[#1c1a19] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
        >
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
            Coding agent
          </p>
          {agentsList.map((agent) => {
            const selected = agent.name === activeAgent;
            const isInstalled = (agent as Agent).installed ?? true;

            return (
              <DropdownMenu.Item
                key={agent.name}
                onSelect={() => onChange(agent.name)}
                className="flex min-h-[46px] cursor-default items-center gap-3 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)]"
              >
                <AgentTileIcon
                  seed={{ label: agent.name }}
                  className="h-5 w-5 border-none bg-transparent"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13px] font-medium">{agent.label || agent.name}</p>
                    {isInstalled ? (
                      <span className="inline-flex items-center rounded-full bg-[color:color-mix(in_srgb,var(--vk-green)_15%,transparent)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--vk-green)] border border-[color:color-mix(in_srgb,var(--vk-green)_25%,transparent)]">
                        Ready
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-[color:color-mix(in_srgb,var(--vk-text-muted)_20%,transparent)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--vk-text-muted)] border border-[rgba(255,255,255,0.05)]">
                        Not Installed
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-[rgba(255,255,255,0.6)]">{agent.description}</p>
                </div>
                {selected ? <Check className="h-4 w-4 text-white" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const DISPATCHER_APPROVAL_REQUIRED = "approval_required";
const INTERRUPTIBLE_SESSION_STATUSES = new Set(["queued", "spawning", "running", "working"]);
const DISPATCHER_APPROVAL_READY_SECTION_MARKERS = [
  "## proposed plan",
  "## intended board mutations",
  "## intended tool calls",
  "## task packet",
  "task packet",
  "board mutations",
];
const DISPATCHER_APPROVAL_READY_PROMPT_MARKERS = [
  "approve this plan",
  "approve the plan",
  "approve this proposal",
  "request changes",
  "plan-only mode",
  "paused before mutating the board",
  "approve it or request changes",
  "ask for explicit approval",
  "explicit approval",
];

function looksLikeDispatcherApprovalProposal(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length < 160) {
    return false;
  }

  const sectionMatches = DISPATCHER_APPROVAL_READY_SECTION_MARKERS.reduce(
    (count, marker) => count + (normalized.includes(marker) ? 1 : 0),
    0,
  );
  const promptMatches = DISPATCHER_APPROVAL_READY_PROMPT_MARKERS.reduce(
    (count, marker) => count + (normalized.includes(marker) ? 1 : 0),
    0,
  );

  return sectionMatches >= 2 && promptMatches >= 1;
}

function shouldShowDispatcherApprovalBanner(
  entries: SessionFeedEntry[],
  approvalState: string | null,
  sessionStatus: string | null,
  parserState: SessionParserState | null,
): boolean {
  if (approvalState !== DISPATCHER_APPROVAL_REQUIRED) {
    return false;
  }
  if (parserState?.kind === DISPATCHER_APPROVAL_REQUIRED) {
    return true;
  }
  if (sessionStatus?.trim().toLowerCase() !== "needs_input") {
    return false;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === "tool" || entry.kind === "status" || entry.kind === "system") {
      continue;
    }
    if (entry.kind === "user") {
      return false;
    }
    if (entry.kind === "assistant") {
      return looksLikeDispatcherApprovalProposal(entry.text);
    }
  }
  return false;
}

export function DispatcherSessionPane({
  session,
  bridgeId = null,
  active = true,
  onClose,
  onToggleCollapse,
  className,
  hideOpenSessionAction = false,
  hideRepositoryControls = false,
  hideSessionStatusBadge = false,
  headerActions = null,
  composerInsert = null,
  composerToolbar = null,
  apiPaths,
}: DispatcherSessionPaneProps) {
  const router = useRouter();
  const [payload, setPayload] = useState<SessionFeedPayload>(EMPTY_FEED_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [repository, setRepository] = useState<RepositorySettingsPayload | null>(null);
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const { agents: fetchedAgents = [] } = useAgents(bridgeId);
  const [commandCopied, setCommandCopied] = useState(false);

  const activeAgentName = useMemo(
    () => repository?.agent?.trim() || session.metadata.agent?.trim() || "codex",
    [repository?.agent, session.metadata.agent],
  );

  const activeAgentInfo = useMemo(() => {
    return fetchedAgents.find(
      (a) => a.name.toLowerCase() === activeAgentName.toLowerCase()
    );
  }, [fetchedAgents, activeAgentName]);

  const isActiveInstalled = useMemo(() => {
    return activeAgentInfo ? (activeAgentInfo.installed ?? true) : true;
  }, [activeAgentInfo]);

  useEffect(() => {
    setCommandCopied(false);
  }, [activeAgentName]);

  const feedRef = useRef<HTMLDivElement>(null);
  const feedContentRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);
  const previousEntryIdsRef = useRef<string[]>([]);
  const [pageVisible, setPageVisible] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [newEntryCount, setNewEntryCount] = useState(0);
  const shouldRunLiveUpdates = active && pageVisible;
  const mountedAtRef = useRef(Date.now());
  const firstFeedLoadedAtRef = useRef<number | null>(null);
  const lastFeedLoadedAtRef = useRef<number | null>(null);
  const lastStreamEventAtRef = useRef<number | null>(null);
  const loadFeedCountRef = useRef(0);
  const loadFeedFailureCountRef = useRef(0);
  const streamConnectCountRef = useRef(0);
  const streamReconnectCountRef = useRef(0);
  const streamFallbackReloadCountRef = useRef(0);
  const streamConnectGenerationRef = useRef(0);
  const deltaAppendCountRef = useRef(0);
  const deltaPatchCountRef = useRef(0);
  const deltaReplaceCountRef = useRef(0);
  const liveUpdatePauseCountRef = useRef(0);
  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(!document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    mountedAtRef.current = Date.now();
    firstFeedLoadedAtRef.current = null;
    lastFeedLoadedAtRef.current = null;
    lastStreamEventAtRef.current = null;
    loadFeedCountRef.current = 0;
    loadFeedFailureCountRef.current = 0;
    streamConnectCountRef.current = 0;
    streamReconnectCountRef.current = 0;
    streamFallbackReloadCountRef.current = 0;
    streamConnectGenerationRef.current += 1;
    deltaAppendCountRef.current = 0;
    deltaPatchCountRef.current = 0;
    deltaReplaceCountRef.current = 0;
    liveUpdatePauseCountRef.current = 0;
    previousEntryIdsRef.current = [];
    setShowJumpToLatest(false);
    setNewEntryCount(0);
  }, [session.id]);

  const sessionApiPaths = useMemo(() => ({
    feed: apiPaths.feed,
    stream: apiPaths.stream,
    send: apiPaths.send,
    interrupt: apiPaths.interrupt ?? null,
    approve: apiPaths.approve ?? null,
    reject: apiPaths.reject ?? null,
    repositories: apiPaths.repositories ?? "/api/repositories",
  }), [apiPaths]);

  const sessionLabel = useMemo(() => {
    if (session.metadata.sessionKind === "project_dispatcher") {
      return `Dispatcher / ${session.projectId}`;
    }
    const primary = session.issueId?.trim() || session.projectId;
    const secondary = session.branch?.trim() || getDisplaySessionId(session.id).slice(0, 8);
    return `${primary} / ${secondary}`;
  }, [session.branch, session.id, session.issueId, session.metadata.sessionKind, session.projectId]);
  const agentLabel = useMemo(
    () => formatAgentName(repository?.agent?.trim() || session.metadata.agent?.trim() || "agent"),
    [repository?.agent, session.metadata.agent],
  );
  const statusLabel = useMemo(
    () => payload.sessionStatus?.trim() || session.status,
    [payload.sessionStatus, session.status],
  );
  const normalizedStatusLabel = useMemo(
    () => statusLabel.trim().toLowerCase(),
    [statusLabel],
  );
  const isDispatcher = session.metadata.sessionKind === "project_dispatcher";
  const approvalState = payload.approvalState ?? session.metadata.acpPlanApprovalState ?? null;
  const awaitingApproval = useMemo(
    () => isDispatcher && shouldShowDispatcherApprovalBanner(
      payload.entries,
      approvalState,
      payload.sessionStatus ?? session.status,
      payload.parserState,
    ),
    [approvalState, isDispatcher, payload.entries, payload.parserState, payload.sessionStatus, session.status],
  );
  const showInterruptAction = Boolean(sessionApiPaths.interrupt)
    && INTERRUPTIBLE_SESSION_STATUSES.has(normalizedStatusLabel);
  const showComposerStopAction = isDispatcher && showInterruptAction;
  const showRowStopAction = showInterruptAction && !showComposerStopAction;
  const showMetaRow = !hideRepositoryControls || !hideSessionStatusBadge || showRowStopAction;
  const canContinue = session.status !== "archived" && !(isDispatcher && showInterruptAction);
  const loadRepository = useCallback(async () => {
    if (hideRepositoryControls) {
      setRepository(null);
      setRepositoryError(null);
      setRepositoryLoading(false);
      return;
    }
    setRepositoryLoading(true);
    setRepositoryError(null);
    try {
      const response = await fetch(withBridgeQuery(sessionApiPaths.repositories, bridgeId), { cache: "no-store" });
      const body = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(readString(body.error) ?? `Failed to load project settings (${response.status})`);
      }
      const nextRepository = Array.isArray(body.repositories)
        ? body.repositories
          .map(normalizeRepositorySettings)
          .find((item): item is RepositorySettingsPayload => item !== null && item.id === session.projectId) ?? null
        : null;
      setRepository(nextRepository);
      if (!nextRepository) {
        setRepositoryError("Project settings were not found for this session.");
      }
    } catch (error) {
      setRepository(null);
      setRepositoryError(error instanceof Error ? error.message : "Failed to load project settings");
    } finally {
      setRepositoryLoading(false);
    }
  }, [bridgeId, hideRepositoryControls, session.projectId, sessionApiPaths.repositories]);

  const loadFeed = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    loadFeedCountRef.current += 1;
    if (showLoading) {
      setLoading(true);
    }
    setLoadingError(null);
    try {
      const response = await fetch(withBridgeQuery(sessionApiPaths.feed, bridgeId), { cache: "no-store" });
      const nextPayload = normalizeFeedPayload(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(nextPayload.error ?? `Failed to load session feed (${response.status})`);
      }
      const now = Date.now();
      if (firstFeedLoadedAtRef.current === null) {
        firstFeedLoadedAtRef.current = now;
      }
      lastFeedLoadedAtRef.current = now;
      setPayload(nextPayload);
    } catch (error) {
      loadFeedFailureCountRef.current += 1;
      setLoadingError(error instanceof Error ? error.message : "Failed to load session feed");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [bridgeId, sessionApiPaths.feed]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void loadFeed();
  }, [active, loadFeed]);

  useEffect(() => {
    if (!active || hideRepositoryControls) {
      return;
    }
    void loadRepository();
  }, [active, hideRepositoryControls, loadRepository]);

  useEffect(() => {
    if (!shouldRunLiveUpdates) {
      liveUpdatePauseCountRef.current += 1;
      return;
    }

    let cancelled = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    const streamAbortRef = { current: null as AbortController | null };

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const applySseData = (raw: string) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        streamFallbackReloadCountRef.current += 1;
        void loadFeed();
        return;
      }

      const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
      if (record?.type === "refresh") {
        streamFallbackReloadCountRef.current += 1;
        dispatchProjectBoardRefresh({
          projectId: session.projectId,
          reason: "dispatcher_feed_refresh",
        });
        void loadFeed();
        return;
      }

      const delta = normalizeFeedDelta(parsed);
      if (!delta) {
        streamFallbackReloadCountRef.current += 1;
        void loadFeed();
        return;
      }

      lastStreamEventAtRef.current = Date.now();
      if (delta.type === "append") {
        deltaAppendCountRef.current += delta.entries.length;
      } else if (delta.type === "patch") {
        deltaPatchCountRef.current += 1;
      } else {
        deltaReplaceCountRef.current += 1;
      }

      const boardRefreshReason = delta.type === "append"
        ? findDispatcherBoardRefreshReason(delta.entries)
        : null;
      if (boardRefreshReason) {
        dispatchProjectBoardRefresh({
          projectId: session.projectId,
          reason: boardRefreshReason,
        });
      }

      setPayload((current) => applyFeedDelta(current, delta));
    };

    const scheduleReconnect = () => {
      if (cancelled) {
        return;
      }
      clearReconnect();
      const delay =
        reconnectAttempt === 0
          ? 250
          : Math.min(500 * 2 ** (reconnectAttempt - 1), 12_000);
      reconnectAttempt += 1;
      streamReconnectCountRef.current += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled) {
        return;
      }
      const myGeneration = streamConnectGenerationRef.current + 1;
      streamConnectGenerationRef.current = myGeneration;
      const isCurrentConnection = () => !cancelled && streamConnectGenerationRef.current === myGeneration;
      streamAbortRef.current?.abort();
      const ac = new AbortController();
      streamAbortRef.current = ac;
      const streamUrl = withBridgeQuery(sessionApiPaths.stream, bridgeId);
      try {
        streamConnectCountRef.current += 1;
        const res = await fetch(streamUrl, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!isCurrentConnection()) {
          return;
        }
        if (!res.ok || !res.body) {
          streamFallbackReloadCountRef.current += 1;
          void loadFeed();
          scheduleReconnect();
          return;
        }
        reconnectAttempt = 0;
        for await (const frame of iterateSseFrames(res.body, ac.signal)) {
          if (!isCurrentConnection()) {
            return;
          }
          applySseData(frame.data);
        }
        if (isCurrentConnection()) {
          streamFallbackReloadCountRef.current += 1;
          void loadFeed();
          scheduleReconnect();
        }
      } catch {
        if (isCurrentConnection() && !ac.signal.aborted) {
          streamFallbackReloadCountRef.current += 1;
          void loadFeed();
          scheduleReconnect();
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      streamConnectGenerationRef.current += 1;
      clearReconnect();
      streamAbortRef.current?.abort();
    };
  }, [bridgeId, loadFeed, session.projectId, sessionApiPaths.stream, shouldRunLiveUpdates]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    window.__conductorDispatcherDebug = {
      sessionId: session.id,
      getState: () => ({
        sessionId: session.id,
        active,
        pageVisible,
        shouldRunLiveUpdates,
        entries: payload.entries.length,
        loading,
        loadingError,
        metrics: {
          mountedAt: new Date(mountedAtRef.current).toISOString(),
          mountedAgeMs: Date.now() - mountedAtRef.current,
          firstFeedLoadLatencyMs: firstFeedLoadedAtRef.current === null
            ? null
            : firstFeedLoadedAtRef.current - mountedAtRef.current,
          lastFeedLoadedAt: lastFeedLoadedAtRef.current === null
            ? null
            : new Date(lastFeedLoadedAtRef.current).toISOString(),
          lastStreamEventAt: lastStreamEventAtRef.current === null
            ? null
            : new Date(lastStreamEventAtRef.current).toISOString(),
          loadFeedCount: loadFeedCountRef.current,
          loadFeedFailureCount: loadFeedFailureCountRef.current,
          streamConnectCount: streamConnectCountRef.current,
          streamReconnectCount: streamReconnectCountRef.current,
          streamFallbackReloadCount: streamFallbackReloadCountRef.current,
          deltaAppendCount: deltaAppendCountRef.current,
          deltaPatchCount: deltaPatchCountRef.current,
          deltaReplaceCount: deltaReplaceCountRef.current,
          liveUpdatePauseCount: liveUpdatePauseCountRef.current,
        },
      }),
    };

    return () => {
      if (window.__conductorDispatcherDebug?.sessionId === session.id) {
        delete window.__conductorDispatcherDebug;
      }
    };
  }, [active, loading, loadingError, pageVisible, payload.entries.length, session.id, shouldRunLiveUpdates]);

  useEffect(() => {
    autoScrollEnabledRef.current = true;
  }, [session.id]);

  useEffect(() => {
    const nextIds = payload.entries.map((entry) => entry.id);
    const previousIds = previousEntryIdsRef.current;

    if (previousIds.length > 0) {
      const previousIdSet = new Set(previousIds);
      let appendedCount = 0;
      for (const id of nextIds) {
        if (!previousIdSet.has(id)) {
          appendedCount += 1;
        }
      }

      if (appendedCount > 0) {
        if (autoScrollEnabledRef.current) {
          setNewEntryCount(0);
        } else {
          setNewEntryCount((current) => current + appendedCount);
          setShowJumpToLatest(true);
        }
      }
    }

    previousEntryIdsRef.current = nextIds;
  }, [payload.entries, session.id]);

  useEffect(() => {
    const node = feedRef.current;
    if (!node) {
      return;
    }

    if (!autoScrollEnabledRef.current) {
      if (payload.entries.length > 0) {
        setShowJumpToLatest(true);
      }
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const nextNode = feedRef.current;
      if (!nextNode || !autoScrollEnabledRef.current) {
        return;
      }
      nextNode.scrollTo({ top: nextNode.scrollHeight });
      autoScrollEnabledRef.current = isDispatcherFeedNearBottom(nextNode);
      setShowJumpToLatest(false);
      setNewEntryCount(0);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [payload, payload.entries.length]);

  useEffect(() => {
    const node = feedRef.current;
    const content = feedContentRef.current;
    if (!node || !content || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!autoScrollEnabledRef.current) {
        return;
      }
      node.scrollTo({ top: node.scrollHeight });
      autoScrollEnabledRef.current = isDispatcherFeedNearBottom(node);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [loading, loadingError, session.id]);

  const handleFeedScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nearBottom = isDispatcherFeedNearBottom(event.currentTarget);
    autoScrollEnabledRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
    if (nearBottom) {
      setNewEntryCount(0);
    }
  }, []);

  useEffect(() => {
    if (!composerInsert) {
      return;
    }
    setComposerValue((current) => {
      const next = composerInsert.draftText.trim();
      if (!next) {
        return current;
      }
      const trimmedCurrent = current.trim();
      if (!trimmedCurrent) {
        return next;
      }
      if (trimmedCurrent.includes(next)) {
        return current;
      }
      return `${current.trimEnd()}\n\n${next}`;
    });
  }, [composerInsert]);

  const sendMessage = useCallback(async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || sending) {
      return false;
    }
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(withBridgeQuery(sessionApiPaths.send, bridgeId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: trimmed }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readString(asRecord(body).error) ?? `Failed to send message (${response.status})`);
      }
      void loadFeed({ showLoading: false });
      return true;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send message");
      return false;
    } finally {
      setSending(false);
    }
  }, [bridgeId, loadFeed, sending, sessionApiPaths.send]);

  const handleSend = useCallback(async () => {
    const message = composerValue.trim();
    if (!message) {
      return;
    }
    const sent = await sendMessage(message);
    if (sent) {
      setComposerValue("");
    }
  }, [composerValue, sendMessage]);

  const handleApprovalAction = useCallback(async (action: "approve" | "reject") => {
    const approvalPath = action === "approve" ? sessionApiPaths.approve : sessionApiPaths.reject;
    if (!approvalPath) {
      await sendMessage(action);
      return;
    }

    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(withBridgeQuery(approvalPath, bridgeId), {
        method: "POST",
      });
      const payload = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(readString(payload.error) ?? `Failed to ${action} plan (${response.status})`);
      }
      setComposerValue("");
      void loadFeed({ showLoading: false });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : `Failed to ${action} plan`);
    } finally {
      setSending(false);
    }
  }, [bridgeId, loadFeed, sendMessage, sessionApiPaths.approve, sessionApiPaths.reject]);

  const handleAgentChange = useCallback(async (nextAgent: string) => {
    if (!repository || savingAgent || nextAgent === repository.agent) {
      return;
    }

    setSavingAgent(true);
    setRepositoryError(null);
    try {
      const response = await fetch(withBridgeQuery(sessionApiPaths.repositories, bridgeId), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...repository,
          agent: nextAgent,
        }),
      });
      const body = asRecord(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(readString(body.error) ?? `Failed to update coding agent (${response.status})`);
      }
      const updated = normalizeRepositorySettings(body.repository);
      if (updated) {
        setRepository(updated);
      } else {
        setRepository((current) => current ? { ...current, agent: nextAgent } : current);
      }
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : "Failed to update coding agent");
    } finally {
      setSavingAgent(false);
    }
  }, [bridgeId, repository, savingAgent, sessionApiPaths.repositories]);

  const handleInterrupt = useCallback(async () => {
    if (!sessionApiPaths.interrupt) {
      return;
    }

    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(withBridgeQuery(sessionApiPaths.interrupt, bridgeId), {
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readString(asRecord(body).error) ?? `Failed to interrupt session (${response.status})`);
      }
      void loadFeed({ showLoading: false });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to interrupt session");
    } finally {
      setSending(false);
    }
  }, [bridgeId, loadFeed, sessionApiPaths.interrupt]);

  return (
    <aside className={cn(
      "flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col overflow-hidden border-t border-[var(--vk-border)] bg-[var(--vk-bg-panel)] xl:w-[405px] xl:border-l xl:border-t-0",
      className,
    )}>
      <div className="flex h-[33px] items-center gap-2 border-b border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-muted)]">
        <span className="min-w-0 flex-1 truncate">{sessionLabel}</span>
        <span className={cn(
          "inline-flex items-center rounded-[999px] px-2 py-0.5 text-[10px] uppercase tracking-wide",
          shouldRunLiveUpdates
            ? "bg-[color:color-mix(in_srgb,var(--vk-green)_18%,transparent)] text-[var(--vk-green)]"
            : "bg-[color:color-mix(in_srgb,var(--vk-text-muted)_12%,transparent)] text-[var(--vk-text-muted)]",
        )}>
          {shouldRunLiveUpdates ? "live" : "paused"}
        </span>
        {headerActions}
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="hidden h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] xl:inline-flex"
            aria-label="Collapse dispatcher"
            title="Collapse dispatcher"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {!hideOpenSessionAction ? (
          <button
            type="button"
            onClick={() => router.push(buildSessionHref(session.id, { bridgeId, tab: null }))}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Open full session"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Close docked session"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div
        ref={feedRef}
        onScroll={handleFeedScroll}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-4"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading dispatcher activity...
          </div>
        ) : loadingError ? (
          <div className="rounded-[3px] border border-[color:color-mix(in_srgb,var(--vk-red)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[13px] text-[var(--vk-red)]">
            {loadingError}
          </div>
        ) : (
          <div ref={feedContentRef} className="space-y-5">
            {payload.parserState || payload.truncated ? (
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-[var(--vk-text-muted)]">
                {payload.parserState ? (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-[999px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-2 py-0.5">
                      <LoaderCircle className="h-3 w-3" />
                      <span>{payload.parserState.kind}</span>
                    </span>
                    {payload.parserState.command ? (
                      <ExpandableInlineText
                        value={payload.parserState.command}
                        maxLength={72}
                        className="rounded-[6px] bg-[rgba(255,255,255,0.05)] px-2 py-0.5 font-mono text-[11px]"
                      />
                    ) : null}
                  </>
                ) : null}
                {payload.truncated ? (
                  <>
                    {payload.parserState ? <span className="text-[var(--vk-text-dim)]">•</span> : null}
                    <span>Showing latest {payload.windowLimit}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            {payload.entries.length === 0 ? (
              !isActiveInstalled ? (
                <div className="rounded-[16px] border border-[color:color-mix(in_srgb,var(--vk-orange)_25%,rgba(255,255,255,0.06))] bg-[rgba(25,23,22,0.65)] backdrop-blur-md p-5 shadow-[0_15px_40px_rgba(0,0,0,0.35)] relative overflow-hidden transition-all duration-300 hover:border-[color:color-mix(in_srgb,var(--vk-orange)_40%,rgba(255,255,255,0.1))]">
                  <div className="absolute top-0 right-0 h-40 w-40 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--vk-orange)_12%,transparent),transparent_70%)] pointer-events-none" />
                  
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-[10px] bg-[color:color-mix(in_srgb,var(--vk-orange)_15%,transparent)] border border-[color:color-mix(in_srgb,var(--vk-orange)_25%,transparent)] text-[var(--vk-orange)] shrink-0">
                      <AlertCircle className="h-5 w-5 animate-pulse" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-[14px] font-semibold text-[#f5ebd7] tracking-wide">
                        Coding Agent Setup Required
                      </h4>
                      <p className="mt-1.5 text-[12px] leading-5 text-[rgba(255,255,255,0.7)]">
                        The selected agent <strong className="text-white">{formatAgentName(activeAgentName)}</strong> is not installed or configured on your system. Conductor orchestrates tasks by dispatching them to this agent.
                      </p>
                    </div>
                  </div>

                  {/* Install instruction section */}
                  {activeAgentInfo?.installHint || getKnownAgent(activeAgentName)?.installHint ? (
                    <div className="mt-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--vk-text-muted)] mb-2">
                        Installation Command
                      </div>
                      <div className="flex items-center gap-2 rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(0,0,0,0.25)] p-2 font-mono text-[12px] text-[#e0dacb]">
                        <Terminal className="h-3.5 w-3.5 text-[rgba(255,255,255,0.4)] shrink-0" />
                        <span className="flex-1 truncate select-all">{activeAgentInfo?.installHint || getKnownAgent(activeAgentName)?.installHint}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const cmd = activeAgentInfo?.installHint || getKnownAgent(activeAgentName)?.installHint;
                            if (cmd) {
                              void navigator.clipboard.writeText(cmd);
                              setCommandCopied(true);
                              setTimeout(() => setCommandCopied(false), 2000);
                            }
                          }}
                          className="p-1 rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[rgba(255,255,255,0.06)] hover:text-white transition"
                          title="Copy install command"
                        >
                          {commandCopied ? (
                            <Check className="h-3.5 w-3.5 text-[var(--vk-green)]" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* Help links */}
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-[rgba(255,255,255,0.06)] pt-3.5">
                    {activeAgentInfo?.homepage || getKnownAgent(activeAgentName)?.homepage ? (
                      <a
                        href={activeAgentInfo?.homepage || getKnownAgent(activeAgentName)?.homepage || undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[11px] text-[var(--vk-accent)] hover:underline"
                      >
                        <span>Visit homepage</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                    
                    {activeAgentInfo?.setupUrl || getKnownAgent(activeAgentName)?.setupUrl ? (
                      <a
                        href={activeAgentInfo?.setupUrl || getKnownAgent(activeAgentName)?.setupUrl || undefined}
                        target="_blank"
rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[11px] text-[var(--vk-accent)] hover:underline"
                      >
                        <span>Setup credentials</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>

                  {/* Quick switcher to ready/installed agents */}
                  {fetchedAgents.filter(a => a.installed !== false && a.name !== activeAgentName).length > 0 ? (
                    <div className="mt-4 border-t border-[rgba(255,255,255,0.06)] pt-3">
                      <div className="text-[11px] text-[rgba(255,255,255,0.5)] mb-2">
                        Or switch to an installed agent ready on your system:
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {fetchedAgents
                          .filter(a => a.installed !== false && a.name !== activeAgentName)
                          .map(a => (
                            <button
                              key={a.name}
                              type="button"
                              onClick={() => void handleAgentChange(a.name)}
                              className="inline-flex items-center gap-1.5 rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-2 py-1 text-[11px] text-[#f3efea] transition hover:bg-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.15)]"
                            >
                              <AgentTileIcon seed={{ label: a.name }} className="h-3.5 w-3.5 border-none bg-transparent" />
                              <span>{a.label || a.name}</span>
                              <ArrowRight className="h-2.5 w-2.5 opacity-60 ml-0.5" />
                            </button>
                          ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-[12px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.02)] px-4 py-4 text-[13px] text-[var(--vk-text-muted)]">
                  No dispatcher activity yet.
                </div>
              )
            ) : (
              payload.entries.map((entry) => (
                <SessionFeedMessage key={entry.id} entry={entry} session={session} />
              ))
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:px-4 sm:pb-4">
        {showMetaRow ? (
          <div className="mb-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {!hideRepositoryControls ? (
              <ProjectAgentSelect
                project={repository}
                disabled={repositoryLoading}
                saving={savingAgent}
                agents={fetchedAgents}
                onChange={(value) => void handleAgentChange(value)}
              />
            ) : null}
            {!hideSessionStatusBadge ? (
              <div
                className={cn(
                  "inline-flex w-fit max-w-full items-center gap-2 rounded-[999px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-3 py-1 text-[11px] text-[var(--vk-text-muted)]",
                  hideRepositoryControls ? null : "sm:ml-auto",
                )}
              >
                <AgentTileIcon
                  seed={{ label: agentLabel }}
                  className="h-4 w-4 border-none bg-transparent"
                />
                <span>{agentLabel}</span>
                <span className="text-[var(--vk-text-dim)]">•</span>
                <span>{statusLabel}</span>
              </div>
            ) : null}
            {showRowStopAction ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sending}
                onClick={() => void handleInterrupt()}
                className="h-[31px] rounded-[6px] border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.03)] px-3 text-[13px] text-[#f3ead8] hover:bg-[rgba(255,255,255,0.08)]"
              >
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                <span>Stop</span>
              </Button>
            ) : null}
          </div>
        ) : null}

        {showJumpToLatest ? (
          <div className="mb-2 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const node = feedRef.current;
                if (!node) return;
                node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
                autoScrollEnabledRef.current = true;
                setShowJumpToLatest(false);
                setNewEntryCount(0);
              }}
              className="h-[30px] rounded-[999px] border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 text-[12px]"
            >
              Jump to latest{newEntryCount > 0 ? ` · ${newEntryCount} new` : ""}
            </Button>
          </div>
        ) : null}

        {repositoryError ? (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--vk-red)]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{repositoryError}</span>
          </div>
        ) : null}

        {sendError ? (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--vk-red)]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{sendError}</span>
          </div>
        ) : null}

        {awaitingApproval ? (
          <div className="mb-3 rounded-[12px] border border-[rgba(204,163,92,0.35)] bg-[rgba(64,49,27,0.58)] px-3 py-3 text-[12px] text-[#f1e3bf]">
            <div className="flex items-center gap-2 text-[13px] font-medium text-[#f6ead0]">
              <AlertCircle className="h-4 w-4" />
              <span>Plan-only review ready</span>
            </div>
            <p className="mt-2 leading-5 text-[#dccba1]">
              The dispatcher is paused before mutating the board for this turn. Review the proposal above, then approve it or request changes.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!canContinue || sending}
                onClick={() => void handleApprovalAction("approve")}
                className="h-[31px] rounded-[6px] border-[rgba(255,255,255,0.08)] bg-[#e6c786] px-3 text-[13px] text-[#22170d] hover:bg-[#edd39d]"
              >
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                <span>Approve plan</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canContinue || sending}
                onClick={() => void handleApprovalAction("reject")}
                className="h-[31px] rounded-[6px] border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.03)] px-3 text-[13px] text-[#f3ead8] hover:bg-[rgba(255,255,255,0.08)]"
              >
                <X className="h-3.5 w-3.5" />
                <span>Request changes</span>
              </Button>
            </div>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
          className="rounded-[3px] border border-[var(--vk-border)] bg-[#1f1f1f] px-2.5 py-2.5 sm:px-3 sm:py-3"
          style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
        >
          {composerToolbar ? <div className="mb-2.5 sm:mb-3">{composerToolbar}</div> : null}
          <textarea
            value={composerValue}
            onChange={(event) => setComposerValue(event.target.value)}
            placeholder={
              !isActiveInstalled
                ? `Please install ${formatAgentName(activeAgentName)} or switch agents to send messages...`
                : "Ask the dispatcher to shape work, create tasks, or update the board..."
            }
            disabled={!canContinue || sending || !isActiveInstalled}
            rows={2}
            className="w-full resize-none bg-transparent text-[15px] leading-5 text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)] disabled:opacity-60 sm:text-[16px] sm:leading-6"
          />
          <div className="mt-2.5 flex items-center justify-end sm:mt-3">
            {showComposerStopAction ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sending}
                onClick={() => void handleInterrupt()}
                className="h-[29px] rounded-[3px] border-[var(--vk-border)] bg-[#292929] px-3 text-[14px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
              >
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                <span>Stop</span>
              </Button>
            ) : (
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!canContinue || sending || composerValue.trim().length === 0 || !isActiveInstalled}
                className="h-[29px] rounded-[3px] border-[var(--vk-border)] bg-[#292929] px-3 text-[14px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <span>Send</span>
                    <Send className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
}
