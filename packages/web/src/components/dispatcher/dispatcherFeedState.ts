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
    merged[existingIndex] = entry;
  }
  return merged;
}

export function applyFeedDelta(current: SessionFeedPayload, delta: FeedDeltaEvent): SessionFeedPayload {
  if (delta.type === "replace") {
    return delta.payload;
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
    if (
      delta.textDelta !== null
      && nextEntry.text.startsWith(existing.text)
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
