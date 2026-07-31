import type { SessionRuntimeStatus } from "@/lib/sessionRuntimeStatus";

export type FeedEntryKind = "assistant" | "status" | "system" | "tool" | "user";

export type SessionFeedEntry = {
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

export type SessionParserState = {
  kind: string;
  message: string;
  command: string | null;
};

export type DispatcherFeedIntegration = {
  projectId: string;
  threadId: string;
  bridgeId: string | null;
  openclaw: {
    threadId: string | null;
    sessionId: string | null;
  };
  heartbeat: {
    state: string | null;
    nextAt: string | null;
  };
  memory: {
    projectPath: string | null;
    sessionPath: string | null;
  };
};

export type SessionFeedPayload = {
  entries: SessionFeedEntry[];
  totalEntries: number;
  windowLimit: number;
  truncated: boolean;
  sessionStatus: string | null;
  approvalState: string | null;
  parserState: SessionParserState | null;
  runtimeStatus: SessionRuntimeStatus | null;
  source: string | null;
  error: string | null;
  integration: DispatcherFeedIntegration | null;
};

export type FeedDeltaEvent =
  | {
      type: "append";
      entries: SessionFeedEntry[];
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: string | null;
      approvalState: string | null;
      parserState: SessionParserState | null;
      runtimeStatus: SessionRuntimeStatus | null;
      source: string | null;
      error: string | null;
      integration: DispatcherFeedIntegration | null;
    }
  | {
      type: "patch";
      entryId: string;
      entry: SessionFeedEntry | null;
      textDelta: string | null;
      textOffset: number | null;
      totalEntries: number;
      windowLimit: number;
      truncated: boolean;
      sessionStatus: string | null;
      approvalState: string | null;
      parserState: SessionParserState | null;
      runtimeStatus: SessionRuntimeStatus | null;
      source: string | null;
      error: string | null;
      integration: DispatcherFeedIntegration | null;
    }
  | {
      type: "replace";
      payload: SessionFeedPayload;
    };

export const EMPTY_FEED_PAYLOAD: SessionFeedPayload = {
  entries: [],
  totalEntries: 0,
  windowLimit: 120,
  truncated: false,
  sessionStatus: null,
  approvalState: null,
  parserState: null,
  runtimeStatus: null,
  source: null,
  error: null,
  integration: null,
};

export function updateDispatcherReconnectAttemptAfterConnection(
  reconnectAttempt: number,
  validFeedFrameCount: number,
  connectedForMs: number,
): number {
  const connectionProvedHealthy = validFeedFrameCount >= 2
    || (validFeedFrameCount >= 1 && connectedForMs >= 1_000);
  return connectionProvedHealthy ? 0 : reconnectAttempt;
}

export function compactFeedPatchNeedsRefresh(
  current: SessionFeedPayload,
  delta: FeedDeltaEvent,
): boolean {
  if (
    delta.type !== "patch"
    || delta.entry !== null
    || delta.textDelta === null
    || delta.textOffset === null
  ) {
    return false;
  }

  const existing = current.entries.find((entry) => entry.id === delta.entryId);
  if (!existing) {
    return true;
  }

  if (existing.text.length === delta.textOffset) {
    return false;
  }

  const expectedEnd = delta.textOffset + delta.textDelta.length;
  return !(
    existing.text.length === expectedEnd
    && existing.text.slice(delta.textOffset) === delta.textDelta
  );
}

export function shouldStartCompactFeedResync(
  resyncPending: boolean,
  patchNeedsRefresh: boolean,
): boolean {
  return patchNeedsRefresh && !resyncPending;
}

function serializedValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function feedEntriesEqual(left: SessionFeedEntry, right: SessionFeedEntry): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.label === right.label
    && left.text === right.text
    && left.createdAt === right.createdAt
    && left.source === right.source
    && left.streaming === right.streaming
    && serializedValuesEqual(left.attachments, right.attachments)
    && serializedValuesEqual(left.metadata, right.metadata);
}

function retainUnchangedFeedEntryReferences(
  currentEntries: SessionFeedEntry[],
  nextEntries: SessionFeedEntry[],
): SessionFeedEntry[] {
  if (currentEntries.length === 0 || nextEntries.length === 0) {
    return nextEntries;
  }

  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  return nextEntries.map((entry) => {
    const current = currentById.get(entry.id);
    return current && feedEntriesEqual(current, entry) ? current : entry;
  });
}

function mergeFeedEntriesById(
  currentEntries: SessionFeedEntry[],
  nextEntries: SessionFeedEntry[],
): SessionFeedEntry[] {
  if (nextEntries.length === 0) {
    return currentEntries;
  }

  const merged = currentEntries.slice();
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]));
  for (const entry of nextEntries) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex === undefined) {
      indexById.set(entry.id, merged.length);
      merged.push(entry);
      continue;
    }
    const existing = merged[existingIndex];
    merged[existingIndex] = existing && feedEntriesEqual(existing, entry) ? existing : entry;
  }
  return merged;
}

export function applyFeedDelta(current: SessionFeedPayload, delta: FeedDeltaEvent): SessionFeedPayload {
  if (delta.type === "replace") {
    return {
      ...delta.payload,
      entries: retainUnchangedFeedEntryReferences(current.entries, delta.payload.entries),
    };
  }

  if (delta.type === "append") {
    return {
      entries: mergeFeedEntriesById(current.entries, delta.entries),
      totalEntries: delta.totalEntries,
      windowLimit: delta.windowLimit,
      truncated: delta.truncated,
      sessionStatus: delta.sessionStatus,
      approvalState: delta.approvalState,
      parserState: delta.parserState,
      runtimeStatus: delta.runtimeStatus,
      source: delta.source,
      error: delta.error,
      integration: delta.integration ?? current.integration,
    };
  }

  const entries = current.entries.slice();
  const nextEntry = delta.entry;
  if (!nextEntry) {
    if (delta.textDelta !== null && delta.textOffset !== null) {
      const patchIndex = entries.findIndex((entry) => entry.id === delta.entryId);
      if (patchIndex >= 0) {
        const existing = entries[patchIndex];
        const expectedEnd = delta.textOffset + delta.textDelta.length;
        if (existing.text.length === delta.textOffset) {
          entries[patchIndex] = {
            ...existing,
            text: existing.text + delta.textDelta,
          };
        } else if (
          existing.text.length === expectedEnd
          && existing.text.slice(delta.textOffset) === delta.textDelta
        ) {
          // Idempotent replay of a frame the client already applied.
          entries[patchIndex] = existing;
        }
      }
      return {
        entries,
        totalEntries: delta.totalEntries,
        windowLimit: delta.windowLimit,
        truncated: delta.truncated,
        sessionStatus: delta.sessionStatus,
        approvalState: delta.approvalState,
        parserState: delta.parserState,
        runtimeStatus: delta.runtimeStatus,
        source: delta.source,
        error: delta.error,
        integration: delta.integration ?? current.integration,
      };
    }
    return {
      ...current,
      entries: entries.filter((entry) => entry.id !== delta.entryId),
      totalEntries: delta.totalEntries,
      windowLimit: delta.windowLimit,
      truncated: delta.truncated,
      sessionStatus: delta.sessionStatus,
      approvalState: delta.approvalState,
      parserState: delta.parserState,
      runtimeStatus: delta.runtimeStatus,
      source: delta.source,
      error: delta.error,
      integration: delta.integration ?? current.integration,
    };
  }

  let patchIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.id === delta.entryId) {
      patchIndex = index;
      break;
    }
  }

  if (patchIndex >= 0) {
    const existing = entries[patchIndex];
    if (feedEntriesEqual(existing, nextEntry)) {
      entries[patchIndex] = existing;
    } else if (
      delta.textDelta !== null
      && nextEntry.text.startsWith(existing.text)
      && existing.text.length + delta.textDelta.length === nextEntry.text.length
    ) {
      entries[patchIndex] = {
        ...nextEntry,
        text: existing.text + delta.textDelta,
      };
    } else {
      entries[patchIndex] = nextEntry;
    }
  } else {
    entries.push(nextEntry);
  }

  return {
    entries,
    totalEntries: delta.totalEntries,
    windowLimit: delta.windowLimit,
    truncated: delta.truncated,
    sessionStatus: delta.sessionStatus,
    approvalState: delta.approvalState,
    parserState: delta.parserState,
    runtimeStatus: delta.runtimeStatus,
    source: delta.source,
    error: delta.error,
    integration: delta.integration ?? current.integration,
  };
}
