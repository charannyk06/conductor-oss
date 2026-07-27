import type { SessionFeedEntry, SessionFeedPayload } from "./dispatcherFeedState";

export const ACTIVE_DISPATCHER_SESSION_STATUSES = new Set([
  "queued",
  "spawning",
  "running",
  "working",
]);

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

function readAttachmentPath(value: unknown): string | null {
  if (typeof value === "string") {
    return readString(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return readString(record.path) ?? readString(record.name);
}

export type PendingDispatcherUserEntry = {
  id: string;
  text: string;
  attachments: string[];
  createdAt: string;
  feedBaselineTotalEntries: number;
  feedBaselineLastEntryId: string | null;
};

export type DispatcherToolPresentation = {
  kind: string | null;
  title: string;
  status: "running" | "success" | "error" | "pending";
  lines: string[];
  preview: string | null;
};

export type DispatcherFeedLoadErrorOptions = {
  preserveExistingOnError?: boolean;
  pendingEntry?: PendingDispatcherUserEntry | null;
};

export function isDispatcherActiveStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase() ?? "";
  return ACTIVE_DISPATCHER_SESSION_STATUSES.has(normalized);
}

export function shouldClearLocalSessionStatus(
  localStatus: string | null | undefined,
  payloadStatus: string | null | undefined,
): boolean {
  const normalizedLocalStatus = localStatus?.trim().toLowerCase() ?? "";
  if (!normalizedLocalStatus) {
    return false;
  }

  const normalizedPayloadStatus = payloadStatus?.trim().toLowerCase() ?? "";
  if (!normalizedPayloadStatus) {
    return false;
  }

  if (normalizedPayloadStatus === normalizedLocalStatus) {
    return true;
  }

  if (isDispatcherActiveStatus(normalizedLocalStatus)) {
    return true;
  }

  return !isDispatcherActiveStatus(normalizedPayloadStatus);
}

export function isExplicitThinkingEntry(entry: SessionFeedEntry): boolean {
  const toolKind = readString(entry.metadata.toolKind)?.toLowerCase() ?? null;
  const toolTitle = readString(entry.metadata.toolTitle)?.toLowerCase() ?? null;
  if (entry.kind === "tool") {
    return toolKind === "thinking" || toolTitle === "thinking";
  }
  if (entry.kind === "status") {
    return toolKind === "thinking" || entry.label.trim().toLowerCase() === "thinking";
  }
  return false;
}

export function getDispatcherToolPresentation(entry: SessionFeedEntry): DispatcherToolPresentation | null {
  if (entry.kind !== "tool") {
    return null;
  }

  const lines = readStringArray(entry.metadata.toolContent);
  const rawStatus = readString(entry.metadata.toolStatus)?.trim().toLowerCase() ?? "";
  const status = rawStatus === "error" || rawStatus === "failed"
    ? "error"
    : rawStatus === "running" || rawStatus === "working"
      ? "running"
      : rawStatus === "success" || rawStatus === "completed" || rawStatus === "complete"
        ? "success"
        : entry.streaming
          ? "running"
          : "pending";

  return {
    kind: readString(entry.metadata.toolKind)?.toLowerCase() ?? null,
    title: readString(entry.metadata.toolTitle)?.trim() || entry.text.trim() || "Tool call",
    status,
    lines,
    preview: lines[0] ?? null,
  };
}

export function applyOptimisticInterruptRecovery(payload: SessionFeedPayload): SessionFeedPayload {
  let changed = false;
  const entries = payload.entries.map((entry) => {
    let nextEntry = entry;
    if (entry.streaming) {
      nextEntry = {
        ...nextEntry,
        streaming: false,
      };
    }

    if (entry.kind === "tool") {
      const toolStatus = readString(entry.metadata.toolStatus)?.trim().toLowerCase() ?? "";
      if (toolStatus === "running" || toolStatus === "working") {
        nextEntry = {
          ...nextEntry,
          metadata: {
            ...nextEntry.metadata,
            toolStatus: "error",
          },
        };
      }
    }

    if (nextEntry !== entry) {
      changed = true;
    }
    return nextEntry;
  });

  const sessionStatus = isDispatcherActiveStatus(payload.sessionStatus) ? "killed" : payload.sessionStatus;
  if (!changed && sessionStatus === payload.sessionStatus) {
    return payload;
  }

  return {
    ...payload,
    entries,
    parserState: null,
    sessionStatus,
  };
}

export function shouldReplaceFeedPayloadOnLoadError(
  feed: Pick<
    SessionFeedPayload,
    "entries" | "totalEntries" | "sessionStatus" | "approvalState" | "parserState" | "runtimeStatus" | "truncated" | "error"
  >,
  options: DispatcherFeedLoadErrorOptions = {},
): boolean {
  if (!options.preserveExistingOnError) {
    return true;
  }

  return !(
    feed.entries.length > 0
    || Boolean(options.pendingEntry)
    || feed.totalEntries > 0
    || isDispatcherActiveStatus(feed.sessionStatus)
    || Boolean(feed.approvalState)
    || Boolean(feed.parserState)
    || Boolean(feed.runtimeStatus)
    || feed.truncated
    || Boolean(feed.error)
  );
}

export function findLastUserEntryIndex(entries: readonly SessionFeedEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "user") {
      return index;
    }
  }
  return -1;
}

export function hasRuntimeActivityAfterLatestUser(entries: readonly SessionFeedEntry[]): boolean {
  const lastUserIndex = findLastUserEntryIndex(entries);
  if (lastUserIndex < 0) {
    return false;
  }

  for (let index = lastUserIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.kind === "user") {
      continue;
    }
    if (entry.kind === "assistant" || entry.kind === "tool" || entry.kind === "system") {
      return true;
    }
    if (entry.kind === "status" && (entry.text.trim().length > 0 || entry.streaming)) {
      return true;
    }
  }

  return false;
}

export function shouldShowDispatcherWorkingEntry(
  entries: readonly SessionFeedEntry[],
  sessionStatus: string | null | undefined,
): boolean {
  return isDispatcherActiveStatus(sessionStatus)
    && findLastUserEntryIndex(entries) >= 0
    && !hasRuntimeActivityAfterLatestUser(entries);
}

function getAbsoluteFeedIndex(feed: Pick<SessionFeedPayload, "entries" | "totalEntries">, index: number): number {
  return Math.max(feed.totalEntries - feed.entries.length, 0) + index;
}

function findEntryAfterBaseline(
  feed: Pick<SessionFeedPayload, "entries" | "totalEntries">,
  pending: PendingDispatcherUserEntry,
): SessionFeedEntry | null {
  const pendingAttachments = [...pending.attachments].sort();
  const baselineAnchorIndex = pending.feedBaselineLastEntryId
    ? feed.entries.findIndex((entry) => entry.id === pending.feedBaselineLastEntryId)
    : -1;

  for (let index = 0; index < feed.entries.length; index += 1) {
    const entry = feed.entries[index];
    if (entry?.kind !== "user") {
      continue;
    }
    const entryAttachments = entry.attachments
      .map((attachment) => readAttachmentPath(attachment))
      .filter((attachment): attachment is string => attachment !== null)
      .sort();
    const sameContent = entry.text.trim() === pending.text.trim()
      && entryAttachments.length === pendingAttachments.length
      && entryAttachments.every((attachment, attachmentIndex) => attachment === pendingAttachments[attachmentIndex]);
    if (!sameContent) {
      continue;
    }
    const absoluteIndex = getAbsoluteFeedIndex(feed, index);
    const isAfterBaseline = baselineAnchorIndex >= 0
      ? index > baselineAnchorIndex
      : absoluteIndex >= pending.feedBaselineTotalEntries;
    if (isAfterBaseline) {
      return entry;
    }
  }

  return null;
}

export function isPendingDispatcherEntryConfirmed(
  feed: Pick<SessionFeedPayload, "entries" | "totalEntries">,
  pending: PendingDispatcherUserEntry | null,
): boolean {
  if (!pending) {
    return true;
  }

  return findEntryAfterBaseline(feed, pending) !== null;
}

export function mergePendingDispatcherEntry(
  feed: Pick<SessionFeedPayload, "entries" | "totalEntries">,
  pending: PendingDispatcherUserEntry | null,
): SessionFeedEntry[] {
  if (!pending || isPendingDispatcherEntryConfirmed(feed, pending)) {
    return [...feed.entries];
  }

  return [
    ...feed.entries,
    {
      id: pending.id,
      kind: "user",
      label: "You",
      text: pending.text,
      createdAt: pending.createdAt,
      attachments: pending.attachments.map((path) => ({ path })),
      source: "optimistic",
      streaming: false,
      metadata: {},
    },
  ];
}
