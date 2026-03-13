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
const ACTIVE_FEED_POLL_INTERVAL_MS = 4_000;
const FEED_RECORD_EVICTION_DELAY_MS = 15_000;
const DEFAULT_FEED_WINDOW_LIMIT = 120;
const MAX_FEED_WINDOW_LIMIT = 240;

type Listener = () => void;

type SessionFeedResponse = {
  entries?: NormalizedChatEntry[];
  totalEntries?: number | null;
  windowLimit?: number | null;
  truncated?: boolean | null;
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
    totalEntries?: number | null;
    windowLimit?: number | null;
    truncated?: boolean | null;
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
  refreshPromise: Promise<void> | null;
  unsubscribeSnapshots: (() => void) | null;
  activeConsumers: number;
  pollTimer: number | null;
  focusHandler: (() => void) | null;
  visibilityHandler: (() => void) | null;
};

type FeedRecord = {
  entries: NormalizedChatEntry[];
  totalEntries: number;
  windowLimit: number;
  truncated: boolean;
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
  disposeTimer: number | null;
  listeners: Set<Listener>;
};

const sessionsStore: SessionsStoreState = {
  sessionsById: new Map(),
  orderedIds: [],
  version: 0,
  loading: true,
  error: null,
  listInitialized: false,
  refreshPromise: null,
  unsubscribeSnapshots: null,
  activeConsumers: 0,
  pollTimer: null,
  focusHandler: null,
  visibilityHandler: null,
};

const sessionListeners = new Set<Listener>();
const feedStore = new Map<string, FeedRecord>();
let activeFeedConsumers = 0;
let feedFocusHandler: (() => void) | null = null;
let feedVisibilityHandler: (() => void) | null = null;

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
  if (sessionsStore.unsubscribeSnapshots) {
    return;
  }
  sessionsStore.unsubscribeSnapshots = subscribeToSnapshotEvents((event) => {
    applySessionEvent(event);
  });
}

function sessionsPollDelay(): number {
  return ACTIVE_SESSIONS_POLL_INTERVAL_MS;
}

function sessionsRealtimeEnabled(): boolean {
  return document.visibilityState === "visible";
}

function clearSessionsPolling() {
  if (sessionsStore.pollTimer !== null) {
    window.clearTimeout(sessionsStore.pollTimer);
    sessionsStore.pollTimer = null;
  }
}

function scheduleSessionsPolling() {
  clearSessionsPolling();
  if (sessionsStore.activeConsumers === 0 || !sessionsRealtimeEnabled()) {
    return;
  }

  sessionsStore.pollTimer = window.setTimeout(async () => {
    if (sessionsStore.activeConsumers === 0 || !sessionsRealtimeEnabled()) {
      return;
    }
    await refreshSessionsStore();
    scheduleSessionsPolling();
  }, sessionsPollDelay());
}

function attachSessionsLifecycleListeners() {
  if (sessionsStore.focusHandler || sessionsStore.visibilityHandler) {
    return;
  }

  const handleFocus = () => {
    if (sessionsStore.activeConsumers === 0) {
      return;
    }
    void refreshSessionsStore();
    scheduleSessionsPolling();
  };
  const handleVisibilityChange = () => {
    if (sessionsStore.activeConsumers === 0) {
      return;
    }
    if (document.visibilityState === "visible") {
      void refreshSessionsStore();
    }
    clearSessionsPolling();
    scheduleSessionsPolling();
  };

  sessionsStore.focusHandler = handleFocus;
  sessionsStore.visibilityHandler = handleVisibilityChange;
  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function detachSessionsLifecycleListeners() {
  if (sessionsStore.focusHandler) {
    window.removeEventListener("focus", sessionsStore.focusHandler);
    sessionsStore.focusHandler = null;
  }
  if (sessionsStore.visibilityHandler) {
    document.removeEventListener("visibilitychange", sessionsStore.visibilityHandler);
    sessionsStore.visibilityHandler = null;
  }
}

function activateSessionsStore() {
  sessionsStore.activeConsumers += 1;
  if (sessionsStore.activeConsumers > 1) {
    return;
  }

  ensureSessionsSnapshotSubscription();
  if (!sessionsStore.listInitialized) {
    sessionsStore.listInitialized = true;
  }
  attachSessionsLifecycleListeners();
  if (sessionsRealtimeEnabled()) {
    void refreshSessionsStore();
  }
  scheduleSessionsPolling();
}

function deactivateSessionsStore() {
  sessionsStore.activeConsumers = Math.max(0, sessionsStore.activeConsumers - 1);
  if (sessionsStore.activeConsumers > 0) {
    return;
  }

  clearSessionsPolling();
  detachSessionsLifecycleListeners();
  sessionsStore.unsubscribeSnapshots?.();
  sessionsStore.unsubscribeSnapshots = null;
}

function subscribeSessions(listener: Listener): () => void {
  sessionListeners.add(listener);
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
    activateSessionsStore();
    const unsubscribe = subscribeSessions(() => forceRender());
    return () => {
      unsubscribe();
      deactivateSessionsStore();
    };
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
      return undefined;
    }
    activateSessionsStore();
    return () => {
      deactivateSessionsStore();
    };
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
    totalEntries: 0,
    windowLimit: DEFAULT_FEED_WINDOW_LIMIT,
    truncated: false,
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
    disposeTimer: null,
    listeners: new Set(),
  };
  feedStore.set(sessionId, created);
  return created;
}

function feedPollDelay(): number {
  return ACTIVE_FEED_POLL_INTERVAL_MS;
}

function feedsRealtimeEnabled(): boolean {
  return document.visibilityState === "visible";
}

function clearFeedPolling(record: FeedRecord) {
  if (record.pollTimer !== null) {
    window.clearTimeout(record.pollTimer);
    record.pollTimer = null;
  }
}

function clearFeedDisposal(record: FeedRecord) {
  if (record.disposeTimer !== null) {
    window.clearTimeout(record.disposeTimer);
    record.disposeTimer = null;
  }
}

function scheduleFeedDisposal(sessionId: string, record: FeedRecord) {
  clearFeedDisposal(record);
  if (record.activeConsumers > 0 || record.listeners.size > 0) {
    return;
  }

  record.disposeTimer = window.setTimeout(() => {
    if (record.activeConsumers > 0 || record.listeners.size > 0) {
      return;
    }
    clearFeedPolling(record);
    record.eventSource?.close();
    record.eventSource = null;
    feedStore.delete(sessionId);
  }, FEED_RECORD_EVICTION_DELAY_MS);
}

function closeFeedTransport(record: FeedRecord) {
  clearFeedPolling(record);
  record.eventSource?.close();
  record.eventSource = null;
}

function clampFeedWindowLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FEED_WINDOW_LIMIT;
  }
  return Math.min(MAX_FEED_WINDOW_LIMIT, Math.max(1, Math.trunc(value)));
}

function trimFeedEntries(entries: NormalizedChatEntry[], windowLimit: number): NormalizedChatEntry[] {
  if (entries.length <= windowLimit) {
    return entries;
  }
  return entries.slice(entries.length - windowLimit);
}

function applyFeedPayload(record: FeedRecord, payload: SessionFeedResponse) {
  const windowLimit = clampFeedWindowLimit(payload.windowLimit);
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  record.entries = trimFeedEntries(entries, windowLimit);
  record.totalEntries = typeof payload.totalEntries === "number" && Number.isFinite(payload.totalEntries)
    ? Math.max(record.entries.length, Math.trunc(payload.totalEntries))
    : record.entries.length;
  record.windowLimit = windowLimit;
  record.truncated = payload.truncated === true || record.totalEntries > record.entries.length;
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
    const nextWindowLimit = clampFeedWindowLimit(message.windowLimit ?? record.windowLimit);
    record.entries = appendedEntries.length > 0
      ? trimFeedEntries([...record.entries, ...appendedEntries], nextWindowLimit)
      : record.entries;
    record.totalEntries = typeof message.totalEntries === "number" && Number.isFinite(message.totalEntries)
      ? Math.max(record.entries.length, Math.trunc(message.totalEntries))
      : record.totalEntries + appendedEntries.length;
    record.windowLimit = nextWindowLimit;
    record.truncated = message.truncated === true || record.totalEntries > record.entries.length;
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
      const search = new URLSearchParams({
        limit: String(DEFAULT_FEED_WINDOW_LIMIT),
      });
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feed?${search.toString()}`, {
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
  if (record.activeConsumers === 0 || record.eventSource || !feedsRealtimeEnabled()) {
    return;
  }
  record.pollTimer = window.setTimeout(async () => {
    if (record.activeConsumers === 0 || !feedsRealtimeEnabled()) {
      return;
    }
    await refreshFeedRecord(sessionId, record);
    scheduleFeedPolling(sessionId, record);
  }, feedPollDelay());
}

function ensureFeedRecordTransport(sessionId: string, record: FeedRecord) {
  if (record.activeConsumers === 0) {
    closeFeedTransport(record);
    return;
  }

  if (!feedsRealtimeEnabled()) {
    closeFeedTransport(record);
    return;
  }

  if (!record.initialized && !record.inFlight) {
    record.loading = true;
    emitFeedChange(record);
    void refreshFeedRecord(sessionId, record);
  }

  if (record.eventSource) {
    return;
  }

  const search = new URLSearchParams({
    limit: String(DEFAULT_FEED_WINDOW_LIMIT),
  });
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/feed/stream?${search.toString()}`);
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

function syncFeedRecords(options?: { refreshVisible?: boolean }) {
  for (const [sessionId, record] of feedStore) {
    if (record.activeConsumers === 0) {
      continue;
    }
    if (feedsRealtimeEnabled()) {
      if (options?.refreshVisible) {
        void refreshFeedRecord(sessionId, record);
      }
      ensureFeedRecordTransport(sessionId, record);
      continue;
    }
    closeFeedTransport(record);
  }
}

function attachFeedLifecycleListeners() {
  if (feedFocusHandler || feedVisibilityHandler) {
    return;
  }

  feedFocusHandler = () => {
    if (activeFeedConsumers === 0 || !feedsRealtimeEnabled()) {
      return;
    }
    syncFeedRecords({ refreshVisible: true });
  };

  feedVisibilityHandler = () => {
    if (activeFeedConsumers === 0) {
      return;
    }
    if (feedsRealtimeEnabled()) {
      syncFeedRecords({ refreshVisible: true });
      return;
    }
    syncFeedRecords();
  };

  window.addEventListener("focus", feedFocusHandler);
  document.addEventListener("visibilitychange", feedVisibilityHandler);
}

function detachFeedLifecycleListeners() {
  if (feedFocusHandler) {
    window.removeEventListener("focus", feedFocusHandler);
    feedFocusHandler = null;
  }
  if (feedVisibilityHandler) {
    document.removeEventListener("visibilitychange", feedVisibilityHandler);
    feedVisibilityHandler = null;
  }
}

function activateFeedRecord(sessionId: string) {
  const record = ensureFeedRecord(sessionId);
  clearFeedDisposal(record);
  activeFeedConsumers += 1;
  record.activeConsumers += 1;
  if (activeFeedConsumers === 1) {
    attachFeedLifecycleListeners();
  }
  if (record.activeConsumers > 1) {
    return;
  }
  ensureFeedRecordTransport(sessionId, record);
}

function deactivateFeedRecord(sessionId: string) {
  const record = feedStore.get(sessionId);
  if (!record) {
    return;
  }
  activeFeedConsumers = Math.max(0, activeFeedConsumers - 1);
  record.activeConsumers = Math.max(0, record.activeConsumers - 1);
  if (record.activeConsumers > 0) {
    return;
  }
  closeFeedTransport(record);
  scheduleFeedDisposal(sessionId, record);
  if (activeFeedConsumers === 0) {
    detachFeedLifecycleListeners();
  }
}

function subscribeFeedRecord(sessionId: string, listener: Listener): () => void {
  const record = ensureFeedRecord(sessionId);
  clearFeedDisposal(record);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
    scheduleFeedDisposal(sessionId, record);
  };
}

export function useSharedSessionFeed(
  sessionId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const [, forceRender] = useReducer((value) => value + 1, 0);

  useEffect(() => {
    if (!sessionId || !enabled) {
      return;
    }
    return subscribeFeedRecord(sessionId, () => forceRender());
  }, [enabled, sessionId]);

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

  if (!sessionId || !enabled) {
    return {
      entries: [] as NormalizedChatEntry[],
      totalEntries: 0,
      windowLimit: DEFAULT_FEED_WINDOW_LIMIT,
      truncated: false,
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
    totalEntries: record.totalEntries,
    windowLimit: record.windowLimit,
    truncated: record.truncated,
    loading: record.loading,
    error: record.error,
    sessionStatus: record.sessionStatus,
    parserState: record.parserState,
    runtimeStatus: record.runtimeStatus,
    refresh: () => refreshFeedRecord(sessionId, record),
  };
}
