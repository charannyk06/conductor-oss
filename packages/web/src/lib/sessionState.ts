"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import type { NormalizedChatEntry } from "@/lib/chatFeed";
import { subscribeToSnapshotEvents } from "@/lib/liveEvents";
import type { SessionRuntimeStatus } from "@/lib/sessionRuntimeStatus";
import {
  TERMINAL_STATUSES,
  type DashboardSession,
  type SSESessionEvent,
  type SSESnapshotSession,
} from "@/lib/types";

const ACTIVE_SESSIONS_POLL_INTERVAL_MS = 15_000;
const HIDDEN_SESSIONS_POLL_INTERVAL_MS = 45_000;
const ACTIVE_FEED_POLL_INTERVAL_MS = 4_000;
const HIDDEN_FEED_POLL_INTERVAL_MS = 15_000;

type Listener = () => void;

type SessionFeedResponse = {
  entries?: NormalizedChatEntry[];
  sessionStatus?: string | null;
  error?: string | null;
  parserState?: {
    kind?: string | null;
    message?: string | null;
    command?: string | null;
  } | null;
  runtimeStatus?: SessionRuntimeStatus | null;
};

type SessionFeedStreamMessage =
  | SessionFeedResponse
  | {
    type: "append";
    entries?: NormalizedChatEntry[];
    sessionStatus?: string | null;
    error?: string | null;
    parserState?: SessionFeedResponse["parserState"];
    runtimeStatus?: SessionRuntimeStatus | null;
  }
  | {
    type: "replace";
    payload?: SessionFeedResponse | null;
  };

export interface SessionParserState {
  kind: string;
  message: string;
  command: string | null;
}

type SessionsStoreState = {
  sessionsById: Map<string, DashboardSession>;
  orderedIds: string[];
  version: number;
  loading: boolean;
  error: string | null;
  listInitialized: boolean;
  snapshotsSubscribed: boolean;
  refreshPromise: Promise<void> | null;
  unsubscribeSnapshots: (() => void) | null;
  visibilityHandlerAttached: boolean;
};

type FeedRecord = {
  entries: NormalizedChatEntry[];
  loading: boolean;
  error: string | null;
  sessionStatus: string | null;
  parserState: SessionParserState | null;
  runtimeStatus: SessionRuntimeStatus | null;
  initialized: boolean;
  activeConsumers: number;
  inFlight: boolean;
  pending: boolean;
  eventSource: EventSource | null;
  pollTimer: number | null;
  listeners: Set<Listener>;
};

const sessionsStore: SessionsStoreState = {
  sessionsById: new Map(),
  orderedIds: [],
  version: 0,
  loading: true,
  error: null,
  listInitialized: false,
  snapshotsSubscribed: false,
  refreshPromise: null,
  unsubscribeSnapshots: null,
  visibilityHandlerAttached: false,
};

const sessionListeners = new Set<Listener>();
const feedStore = new Map<string, FeedRecord>();

function emitSessionChange() {
  for (const listener of sessionListeners) {
    listener();
  }
}

function emitFeedChange(record: FeedRecord) {
  for (const listener of record.listeners) {
    listener();
  }
}

function sortSessionIdsByCreatedAt(sessionsById: Map<string, DashboardSession>): string[] {
  return [...sessionsById.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((session) => session.id);
}

function commitSessionsState(
  sessionsById: Map<string, DashboardSession>,
  orderedIds: string[],
) {
  sessionsStore.sessionsById = sessionsById;
  sessionsStore.orderedIds = orderedIds;
  sessionsStore.version += 1;
}

function mapSnapshotSession(session: SSESnapshotSession): DashboardSession {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    summary: session.summary ?? null,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    pr: session.pr ?? null,
    metadata: session.metadata,
  };
}

function applySessionEvent(event: SSESessionEvent) {
  if (event.type === "snapshot") {
    commitSessionsState(new Map(
      event.sessions.map((session) => {
        const mapped = mapSnapshotSession(session);
        return [mapped.id, mapped] as const;
      }),
    ), event.sessions.map((session) => session.id));
  } else {
    const nextSessions = new Map(sessionsStore.sessionsById);
    for (const session of event.sessions) {
      const mapped = mapSnapshotSession(session);
      nextSessions.set(mapped.id, mapped);
    }
    for (const sessionId of event.removedSessionIds ?? []) {
      nextSessions.delete(sessionId);
    }
    commitSessionsState(nextSessions, sortSessionIdsByCreatedAt(nextSessions));
  }
  sessionsStore.loading = false;
  sessionsStore.error = null;
  emitSessionChange();
}

function normalizeSessionsPayload(json: unknown): DashboardSession[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { sessions?: unknown })?.sessions)
      ? ((json as { sessions: DashboardSession[] }).sessions)
      : [];
  return list;
}

async function refreshSessionsStore(): Promise<void> {
  if (sessionsStore.refreshPromise) {
    await sessionsStore.refreshPromise;
    return;
  }

  const load = (async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.status}`);
      }
      const payload = normalizeSessionsPayload(await response.json().catch(() => null));
      const sessionsById = new Map(payload.map((session) => [session.id, session] as const));
      commitSessionsState(sessionsById, sortSessionIdsByCreatedAt(sessionsById));
      sessionsStore.error = null;
    } catch (error) {
      sessionsStore.error = error instanceof Error ? error.message : "Failed to fetch sessions";
    } finally {
      sessionsStore.loading = false;
      emitSessionChange();
    }
  })();

  sessionsStore.refreshPromise = load.finally(() => {
    if (sessionsStore.refreshPromise === load) {
      sessionsStore.refreshPromise = null;
    }
  });
  await load;
}

function ensureSessionsSnapshotSubscription() {
  if (sessionsStore.snapshotsSubscribed) {
    return;
  }
  sessionsStore.snapshotsSubscribed = true;
  sessionsStore.unsubscribeSnapshots = subscribeToSnapshotEvents((event) => {
    applySessionEvent(event);
  });
}

function ensureSessionsStoreInitialized() {
  ensureSessionsSnapshotSubscription();
  if (sessionsStore.listInitialized) {
    return;
  }
  sessionsStore.listInitialized = true;
  void refreshSessionsStore();

  if (!sessionsStore.visibilityHandlerAttached) {
    sessionsStore.visibilityHandlerAttached = true;
    window.addEventListener("focus", () => {
      void refreshSessionsStore();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void refreshSessionsStore();
      }
    });
    window.setInterval(() => {
      void refreshSessionsStore();
    }, document.visibilityState === "visible"
      ? ACTIVE_SESSIONS_POLL_INTERVAL_MS
      : HIDDEN_SESSIONS_POLL_INTERVAL_MS);
  }
}

function subscribeSessions(listener: Listener): () => void {
  sessionListeners.add(listener);
  ensureSessionsSnapshotSubscription();
  return () => {
    sessionListeners.delete(listener);
  };
}

async function refreshSessionRecord(id: string): Promise<DashboardSession | null> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.status === 404) {
      const nextSessions = new Map(sessionsStore.sessionsById);
      nextSessions.delete(id);
      commitSessionsState(nextSessions, sortSessionIdsByCreatedAt(nextSessions));
      sessionsStore.error = null;
      emitSessionChange();
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch session: ${response.status}`);
    }

    const session = await response.json() as DashboardSession;
    const nextSessions = new Map(sessionsStore.sessionsById);
    nextSessions.set(session.id, session);
    commitSessionsState(nextSessions, sortSessionIdsByCreatedAt(nextSessions));
    sessionsStore.error = null;
    return session;
  } catch (error) {
    sessionsStore.error = error instanceof Error ? error.message : "Failed to fetch session";
    throw error;
  } finally {
    sessionsStore.loading = false;
    emitSessionChange();
  }
}

export function primeSessionStore(session: DashboardSession | null | undefined) {
  if (!session) {
    return;
  }
  const existing = sessionsStore.sessionsById.get(session.id);
  if (existing && JSON.stringify(existing) === JSON.stringify(session)) {
    return;
  }
  const nextSessions = new Map(sessionsStore.sessionsById);
  nextSessions.set(session.id, session);
  commitSessionsState(nextSessions, sortSessionIdsByCreatedAt(nextSessions));
  sessionsStore.loading = false;
  emitSessionChange();
}

function filterProjectSessions(projectId?: string | null): DashboardSession[] {
  const normalized = projectId?.trim();
  return sessionsStore.orderedIds
    .map((sessionId) => sessionsStore.sessionsById.get(sessionId))
    .filter((session): session is DashboardSession => Boolean(session))
    .filter((session) => !normalized || session.projectId === normalized);
}

interface SharedSessionsOptions {
  enabled?: boolean;
}

export function useSharedSessions(projectId?: string | null, options?: SharedSessionsOptions) {
  const enabled = options?.enabled ?? true;
  const [, forceRender] = useReducer((value) => value + 1, 0);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    ensureSessionsStoreInitialized();
    return subscribeSessions(() => forceRender());
  }, [enabled]);

  const sessions = useMemo(
    () => (enabled ? filterProjectSessions(projectId) : []),
    [enabled, projectId, sessionsStore.version],
  );

  return {
    sessions,
    loading: enabled ? sessionsStore.loading : false,
    error: enabled ? sessionsStore.error : null,
    refresh: refreshSessionsStore,
  };
}

export function useSharedSession(
  id: string | null | undefined,
  initialSession: DashboardSession | null = null,
  options?: { enabled?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const [, forceRender] = useReducer((value) => value + 1, 0);
  const normalizedId = typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  const [sessionOverride, setSessionOverride] = useState<DashboardSession | null>(initialSession);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(
    enabled && normalizedId !== null && initialSession === null && !sessionsStore.sessionsById.has(normalizedId),
  );

  useEffect(() => {
    primeSessionStore(initialSession);
    setSessionOverride(initialSession);
    setSessionError(null);
  }, [initialSession]);

  useEffect(() => {
    if (!enabled || normalizedId === null) {
      return undefined;
    }
    return subscribeSessions(() => forceRender());
  }, [enabled, normalizedId]);

  useEffect(() => {
    if (!enabled || normalizedId === null) {
      setSessionOverride(null);
      setSessionError(null);
      setLoading(false);
      return;
    }

    if (initialSession || sessionsStore.sessionsById.has(normalizedId)) {
      setSessionOverride((current) => sessionsStore.sessionsById.get(normalizedId) ?? current ?? initialSession);
      setSessionError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSessionError(null);
    void refreshSessionRecord(normalizedId)
      .then((session) => {
        if (cancelled) {
          return;
        }
        setSessionOverride(session);
        setSessionError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setSessionOverride(null);
        setSessionError(error instanceof Error ? error.message : "Failed to fetch session");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedId, initialSession]);

  const session = normalizedId
    ? sessionsStore.sessionsById.get(normalizedId) ?? sessionOverride ?? initialSession ?? null
    : null;

  return {
    session,
    loading,
    error: enabled && normalizedId ? sessionError ?? sessionsStore.error : null,
  };
}

function normalizeParserState(value: SessionFeedResponse["parserState"]): SessionParserState | null {
  if (!value || typeof value !== "object") return null;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const command = typeof value.command === "string" && value.command.trim().length > 0
    ? value.command.trim()
    : null;
  if (!kind || !message) return null;
  return { kind, message, command };
}

function ensureFeedRecord(sessionId: string): FeedRecord {
  const existing = feedStore.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: FeedRecord = {
    entries: [],
    loading: true,
    error: null,
    sessionStatus: null,
    parserState: null,
    runtimeStatus: null,
    initialized: false,
    activeConsumers: 0,
    inFlight: false,
    pending: false,
    eventSource: null,
    pollTimer: null,
    listeners: new Set(),
  };
  feedStore.set(sessionId, created);
  return created;
}

function feedPollDelay(): number {
  return document.visibilityState === "visible"
    ? ACTIVE_FEED_POLL_INTERVAL_MS
    : HIDDEN_FEED_POLL_INTERVAL_MS;
}

function clearFeedPolling(record: FeedRecord) {
  if (record.pollTimer !== null) {
    window.clearTimeout(record.pollTimer);
    record.pollTimer = null;
  }
}

function applyFeedPayload(record: FeedRecord, payload: SessionFeedResponse) {
  record.entries = Array.isArray(payload.entries) ? payload.entries : [];
  record.sessionStatus = typeof payload.sessionStatus === "string" ? payload.sessionStatus : null;
  record.parserState = normalizeParserState(payload.parserState);
  record.runtimeStatus = payload.runtimeStatus && typeof payload.runtimeStatus === "object"
    ? payload.runtimeStatus
    : null;
  record.error = typeof payload.error === "string" && payload.error.trim().length > 0
    ? payload.error.trim()
    : null;
  record.loading = false;
  record.initialized = true;
  emitFeedChange(record);
}

function applyFeedStreamMessage(record: FeedRecord, message: SessionFeedStreamMessage) {
  if (message && typeof message === "object" && "type" in message && message.type === "append") {
    const appendedEntries = Array.isArray(message.entries) ? message.entries : [];
    record.entries = appendedEntries.length > 0
      ? [...record.entries, ...appendedEntries]
      : record.entries;
    record.sessionStatus = typeof message.sessionStatus === "string" ? message.sessionStatus : record.sessionStatus;
    record.parserState = normalizeParserState(message.parserState) ?? record.parserState;
    record.runtimeStatus = message.runtimeStatus && typeof message.runtimeStatus === "object"
      ? message.runtimeStatus
      : record.runtimeStatus;
    record.error = typeof message.error === "string" && message.error.trim().length > 0
      ? message.error.trim()
      : null;
    record.loading = false;
    record.initialized = true;
    emitFeedChange(record);
    return;
  }

  if (message && typeof message === "object" && "type" in message && message.type === "replace") {
    applyFeedPayload(record, message.payload ?? {});
    return;
  }

  applyFeedPayload(record, message as SessionFeedResponse);
}

async function refreshFeedRecord(sessionId: string, record = ensureFeedRecord(sessionId)): Promise<void> {
  if (record.inFlight) {
    record.pending = true;
    return;
  }

  record.inFlight = true;
  do {
    record.pending = false;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feed`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Failed to load chat feed: ${response.status}`);
      }
      applyFeedPayload(record, await response.json());
    } catch (error) {
      record.error = error instanceof Error ? error.message : "Failed to load chat feed";
      record.loading = false;
      emitFeedChange(record);
    }
  } while (record.pending);
  record.inFlight = false;
}

function scheduleFeedPolling(sessionId: string, record: FeedRecord) {
  clearFeedPolling(record);
  if (record.activeConsumers === 0 || record.eventSource) {
    return;
  }
  record.pollTimer = window.setTimeout(async () => {
    await refreshFeedRecord(sessionId, record);
    scheduleFeedPolling(sessionId, record);
  }, feedPollDelay());
}

function activateFeedRecord(sessionId: string) {
  const record = ensureFeedRecord(sessionId);
  record.activeConsumers += 1;
  if (record.activeConsumers > 1) {
    return;
  }

  if (!record.initialized) {
    record.loading = true;
    emitFeedChange(record);
    void refreshFeedRecord(sessionId, record);
  }

  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/feed/stream`);
  source.onmessage = (event) => {
    try {
      applyFeedStreamMessage(record, JSON.parse(event.data as string) as SessionFeedStreamMessage);
    } catch {
      // Ignore malformed stream payloads.
    }
  };
  source.addEventListener("refresh", () => {
    void refreshFeedRecord(sessionId, record);
  });
  source.onerror = () => {
    source.close();
    if (record.eventSource === source) {
      record.eventSource = null;
    }
    if (record.activeConsumers > 0) {
      scheduleFeedPolling(sessionId, record);
    }
  };
  record.eventSource = source;
  clearFeedPolling(record);
}

function deactivateFeedRecord(sessionId: string) {
  const record = ensureFeedRecord(sessionId);
  record.activeConsumers = Math.max(0, record.activeConsumers - 1);
  if (record.activeConsumers > 0) {
    return;
  }
  clearFeedPolling(record);
  record.eventSource?.close();
  record.eventSource = null;
}

function subscribeFeedRecord(sessionId: string, listener: Listener): () => void {
  const record = ensureFeedRecord(sessionId);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
  };
}

export function useSharedSessionFeed(
  sessionId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const [, forceRender] = useReducer((value) => value + 1, 0);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    return subscribeFeedRecord(sessionId, () => forceRender());
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    if (!enabled) {
      return;
    }
    activateFeedRecord(sessionId);
    return () => {
      deactivateFeedRecord(sessionId);
    };
  }, [enabled, sessionId]);

  if (!sessionId) {
    return {
      entries: [] as NormalizedChatEntry[],
      loading: false,
      error: null,
      sessionStatus: null,
      parserState: null,
      runtimeStatus: null,
      refresh: async () => {},
    };
  }

  const record = ensureFeedRecord(sessionId);
  return {
    entries: record.entries,
    loading: record.loading,
    error: record.error,
    sessionStatus: record.sessionStatus,
    parserState: record.parserState,
    runtimeStatus: record.runtimeStatus,
    refresh: () => refreshFeedRecord(sessionId, record),
  };
}
