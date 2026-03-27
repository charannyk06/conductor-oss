"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Bot,
  ExternalLink,
  Eye,
  Loader2,
  Send,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { buildSessionHref } from "@/lib/dashboardHref";
import type { DashboardSession } from "@/lib/types";
import type { SessionRuntimeStatus } from "@/lib/sessionRuntimeStatus";
import { SessionProjectOpenMenu } from "./SessionProjectOpenMenu";

type FeedEntryKind = "assistant" | "status" | "system" | "tool" | "user";

type SessionFeedEntry = {
  id: string;
  kind: FeedEntryKind;
  label: string;
  text: string;
  createdAt: string | null;
  attachments: unknown[];
  source: string;
  streaming: boolean;
  metadata: Record<string, unknown>;
};

type SessionParserState = {
  kind: string;
  message: string;
  command: string | null;
};

type SessionFeedPayload = {
  entries: SessionFeedEntry[];
  totalEntries: number;
  windowLimit: number;
  truncated: boolean;
  sessionStatus: string | null;
  parserState: SessionParserState | null;
  runtimeStatus: SessionRuntimeStatus | null;
  source: string | null;
  error: string | null;
};

type FeedDeltaEvent =
  | {
      type: "append";
      entries: SessionFeedEntry[];
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: string | null;
      parserState: SessionParserState | null;
      runtimeStatus: SessionRuntimeStatus | null;
      source: string | null;
      error: string | null;
    }
  | {
      type: "replace";
      payload: SessionFeedPayload;
    };

type SessionChatDockProps = {
  session: DashboardSession;
  bridgeId?: string | null;
  onClose?: () => void;
  className?: string;
};

const EMPTY_FEED_PAYLOAD: SessionFeedPayload = {
  entries: [],
  totalEntries: 0,
  windowLimit: 120,
  truncated: false,
  sessionStatus: null,
  parserState: null,
  runtimeStatus: null,
  source: null,
  error: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
    parserState: normalizeParserState(record.parserState),
    runtimeStatus: normalizeRuntimeStatus(record.runtimeStatus),
    source: readString(record.source),
    error: readString(record.error),
  };
}

function normalizeFeedDelta(value: unknown): FeedDeltaEvent | null {
  const record = asRecord(value);
  const type = readString(record.type);
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
      parserState: payload.parserState,
      runtimeStatus: payload.runtimeStatus,
      source: payload.source,
      error: payload.error,
    };
  }
  return null;
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

function resolveToolStatusTone(status: string | null): string {
  switch (status) {
    case "success":
    case "done":
    case "completed":
      return "bg-[#54b04f]";
    case "error":
    case "failed":
      return "bg-[#d25151]";
    case "running":
    case "working":
    case "pending":
      return "bg-[#d08c1d]";
    default:
      return "bg-[#6f6f6f]";
  }
}

function resolveEntryLabel(entry: SessionFeedEntry, session: DashboardSession): string {
  if (entry.kind === "assistant" && entry.source === "runtime") {
    return "Thinking";
  }
  if (entry.kind === "assistant") {
    return session.metadata.agent?.trim() || "Assistant";
  }
  return entry.label || "Session";
}

function formatAgentName(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        pre: ({ children }) => (
          <pre className="mb-3 overflow-x-auto rounded-[3px] border border-[var(--vk-border)] bg-[#191919] p-3 text-[12px] text-[var(--vk-text-normal)] last:mb-0">
            {children}
          </pre>
        ),
        code: ({ children, className }) => (
          <code
            className={cn(
              "rounded-[3px] bg-[#191919] px-1.5 py-0.5 font-mono text-[12px] text-[var(--vk-text-normal)]",
              className,
            )}
          >
            {children}
          </code>
        ),
        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function SessionFeedMessage({
  entry,
  session,
}: {
  entry: SessionFeedEntry;
  session: DashboardSession;
}) {
  const toolStatus = readString(entry.metadata.toolStatus)?.toLowerCase() ?? null;
  const timestamp = formatEntryTime(entry.createdAt);
  const label = resolveEntryLabel(entry, session);
  const attachments = entry.attachments
    .map((attachment) => {
      const record = asRecord(attachment);
      return readString(record.name) ?? readString(record.path) ?? (typeof attachment === "string" ? attachment : null);
    })
    .filter((value): value is string => Boolean(value));

  if (entry.kind === "tool") {
    const title = readString(entry.metadata.toolTitle) ?? entry.text;
    return (
      <div className="flex items-start gap-2 text-[13px] text-[var(--vk-text-muted)]">
        <div className="relative mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#232323] text-[var(--vk-text-muted)]">
          <Wrench className="h-3.5 w-3.5" />
          <span className={cn("absolute -bottom-[2px] -left-[2px] h-[6px] w-[6px] rounded-full", resolveToolStatusTone(toolStatus))} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
            <span>Tool</span>
            {timestamp ? <span className="normal-case tracking-normal text-[10px]">{timestamp}</span> : null}
          </div>
          <p className="mt-1 truncate text-[13px] leading-[21px] text-[var(--vk-text-muted)]" title={title}>
            {title}
          </p>
        </div>
      </div>
    );
  }

  const Icon = entry.kind === "user"
    ? UserRound
    : entry.kind === "assistant"
      ? Bot
      : entry.kind === "status"
        ? Sparkles
        : AlertCircle;
  const cardClassName = entry.kind === "user"
    ? "border border-[var(--vk-border)] bg-[#1f1f1f] px-3 py-3"
    : entry.kind === "status" || entry.kind === "system"
      ? "border border-[var(--vk-border)] bg-[#1a1a1a] px-3 py-2.5"
      : "bg-transparent px-0 py-0";

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#232323] text-[var(--vk-text-muted)]">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
          <span>{label}</span>
          {timestamp ? <span className="normal-case tracking-normal text-[10px]">{timestamp}</span> : null}
        </div>
        <div className={cn("rounded-[3px] text-[14px] leading-[21px] text-[var(--vk-text-normal)]", cardClassName)}>
          <MarkdownMessage text={entry.text} />
        </div>
        {attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <span
                key={`${entry.id}-${attachment}`}
                className="inline-flex items-center rounded-[999px] border border-[var(--vk-border)] bg-[#232323] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]"
              >
                {attachment}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SessionChatDock({
  session,
  bridgeId = null,
  onClose,
  className,
}: SessionChatDockProps) {
  const router = useRouter();
  const [payload, setPayload] = useState<SessionFeedPayload>(EMPTY_FEED_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [setupScript, setSetupScript] = useState<string | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [composerValue, setComposerValue] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const sessionLabel = useMemo(() => {
    if (session.metadata.sessionKind === "project_dispatcher") {
      return `${session.projectId} / dispatcher`;
    }
    const primary = session.issueId?.trim() || session.projectId;
    const secondary = session.branch?.trim() || session.id.slice(0, 8);
    return `${primary} / ${secondary}`;
  }, [session.branch, session.id, session.issueId, session.metadata.sessionKind, session.projectId]);
  const agentLabel = useMemo(
    () => formatAgentName(session.metadata.agent?.trim() || "agent"),
    [session.metadata.agent],
  );
  const statusLabel = useMemo(
    () => payload.sessionStatus?.trim() || session.status,
    [payload.sessionStatus, session.status],
  );
  const canContinue = session.status !== "archived";

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setLoadingError(null);
    try {
      const response = await fetch(
        withBridgeQuery(`/api/sessions/${encodeURIComponent(session.id)}/feed?limit=120`, bridgeId),
        { cache: "no-store" },
      );
      const nextPayload = normalizeFeedPayload(await response.json().catch(() => null));
      if (!response.ok) {
        throw new Error(nextPayload.error ?? `Failed to load session feed (${response.status})`);
      }
      setPayload(nextPayload);
    } catch (error) {
      setLoadingError(error instanceof Error ? error.message : "Failed to load session feed");
      setPayload(EMPTY_FEED_PAYLOAD);
    } finally {
      setLoading(false);
    }
  }, [bridgeId, session.id]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    setSetupLoading(true);
    setSetupScript(null);
    let cancelled = false;

    void fetch(
      withBridgeQuery(`/api/repositories/${encodeURIComponent(session.projectId)}`, bridgeId),
      { cache: "no-store" },
    )
      .then((response) => response.json().catch(() => null).then((body) => ({ ok: response.ok, body })))
      .then(({ ok, body }) => {
        if (cancelled || !ok) {
          return;
        }
        const record = asRecord(body);
        setSetupScript(readString(record.setupScript));
      })
      .finally(() => {
        if (!cancelled) {
          setSetupLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeId, session.projectId]);

  useEffect(() => {
    const nextUrl = withBridgeQuery(`/api/sessions/${encodeURIComponent(session.id)}/feed/stream?limit=120`, bridgeId);
    const source = new EventSource(nextUrl);

    source.onmessage = (event) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        void loadFeed();
        return;
      }

      const delta = normalizeFeedDelta(parsed);
      if (!delta) {
        return;
      }

      setPayload((current) => {
        if (delta.type === "replace") {
          return delta.payload;
        }

        return {
          entries: [...current.entries, ...delta.entries],
          totalEntries: delta.totalEntries,
          windowLimit: delta.windowLimit,
          truncated: delta.truncated,
          sessionStatus: delta.sessionStatus,
          parserState: delta.parserState,
          runtimeStatus: delta.runtimeStatus,
          source: delta.source,
          error: delta.error,
        };
      });
    };

    source.addEventListener("refresh", () => {
      void loadFeed();
    });

    source.onerror = () => {
      source.close();
      void loadFeed();
    };

    return () => {
      source.close();
    };
  }, [bridgeId, loadFeed, session.id]);

  useEffect(() => {
    const node = feedRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [payload.entries.length]);

  const handleSend = useCallback(async () => {
    const message = composerValue.trim();
    if (!message || sending) {
      return;
    }

    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(
        withBridgeQuery(`/api/sessions/${encodeURIComponent(session.id)}/feedback`, bridgeId),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readString(asRecord(body).error) ?? `Failed to send message (${response.status})`);
      }
      setComposerValue("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [bridgeId, composerValue, sending, session.id]);

  return (
    <aside className={cn(
      "flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-[var(--vk-border)] bg-[var(--vk-bg-panel)] xl:w-[405px] xl:border-l xl:border-t-0",
      className,
    )}>
      <div className="flex h-[33px] items-center gap-2 border-b border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-muted)]">
        <span className="min-w-0 flex-1 truncate">{sessionLabel}</span>
        <button
          type="button"
          onClick={() => router.push(buildSessionHref(session.id, { bridgeId, tab: "terminal" }))}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
          aria-label="Open full session"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
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

      <div className="border-b border-[var(--vk-border)] px-3 py-3">
        <div className="rounded-[3px] border border-[var(--vk-border)] bg-[#202020] px-3 py-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Setup Script</span>
          </div>
          {setupLoading ? (
            <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--vk-text-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading workspace setup…</span>
            </div>
          ) : setupScript ? (
            <pre className="mt-2 overflow-x-auto rounded-[3px] border border-[var(--vk-border)] bg-[#1a1a1a] p-3 font-mono text-[12px] leading-5 text-[var(--vk-text-normal)]">
              {setupScript}
            </pre>
          ) : (
            <p className="mt-2 text-[13px] leading-[20px] text-[var(--vk-text-muted)]">
              No setup script configured. Setup scripts run before the coding agent starts.
            </p>
          )}
          {payload.parserState ? (
            <div className="mt-3 rounded-[3px] border border-[var(--vk-border)] bg-[#1a1a1a] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
              <div className="font-medium uppercase tracking-[0.08em] text-[10px] text-[var(--vk-text-muted)]">
                {payload.parserState.kind}
              </div>
              {payload.parserState.message ? (
                <p className="mt-1 leading-[18px]">{payload.parserState.message}</p>
              ) : null}
              {payload.parserState.command ? (
                <p className="mt-1 truncate font-mono text-[11px] text-[var(--vk-text-normal)]" title={payload.parserState.command}>
                  {payload.parserState.command}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div
        ref={feedRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading session activity…
          </div>
        ) : loadingError ? (
          <div className="rounded-[3px] border border-[color:color-mix(in_srgb,var(--vk-red)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[13px] text-[var(--vk-red)]">
            {loadingError}
          </div>
        ) : (
          <div className="space-y-5">
            {payload.truncated ? (
              <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                Showing the latest {payload.windowLimit} entries
              </div>
            ) : null}

            {payload.entries.length === 0 ? (
              <div className="rounded-[3px] border border-[var(--vk-border)] bg-[#1f1f1f] px-3 py-3 text-[13px] text-[var(--vk-text-muted)]">
                No session feed entries yet.
              </div>
            ) : (
              payload.entries.map((entry) => (
                <SessionFeedMessage key={entry.id} entry={entry} session={session} />
              ))
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-3">
        <div className="mb-3 flex items-center gap-2">
          <SessionProjectOpenMenu
            projectId={session.projectId}
            bridgeId={bridgeId}
            label="Open Workspace"
            triggerClassName="h-[30px] rounded-[3px] border-[var(--vk-accent)] bg-[var(--vk-accent)] px-3 text-[13px] text-white hover:bg-[var(--accent-hover)] hover:text-white"
          />
          <button
            type="button"
            onClick={() => router.push(buildSessionHref(session.id, { bridgeId, tab: "terminal" }))}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[3px] border border-[var(--vk-border)] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Open terminal view"
            title="Open terminal"
          >
            <SquareTerminal className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => router.push(buildSessionHref(session.id, { bridgeId, tab: "preview" }))}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[3px] border border-[var(--vk-border)] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Open preview view"
            title="Open preview"
          >
            <Eye className="h-4 w-4" />
          </button>
          <div className="ml-auto flex items-center gap-2">
            <AgentTileIcon
              seed={{ label: agentLabel }}
              className="h-6 w-6 border-none bg-transparent"
            />
            <div className="flex flex-col items-end text-right">
              <span className="text-[12px] text-[var(--vk-text-normal)]">{agentLabel}</span>
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
                {statusLabel}
              </span>
            </div>
          </div>
        </div>

        {sendError ? (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--vk-red)]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{sendError}</span>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
          className="rounded-[3px] border border-[var(--vk-border)] bg-[#1f1f1f] px-3 py-3"
        >
          <textarea
            value={composerValue}
            onChange={(event) => setComposerValue(event.target.value)}
            placeholder={session.metadata.sessionKind === "project_dispatcher"
              ? "Ask the dispatcher to shape work, create tasks, or update the board..."
              : "Continue working on this task..."}
            disabled={!canContinue || sending}
            rows={2}
            className="w-full resize-none bg-transparent text-[16px] leading-6 text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)] disabled:opacity-60"
          />
          <div className="mt-3 flex items-center justify-end">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={!canContinue || sending || composerValue.trim().length === 0}
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
          </div>
        </form>
      </div>
    </aside>
  );
}
