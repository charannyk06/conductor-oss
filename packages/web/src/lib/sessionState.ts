"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { subscribeToSnapshotEvents } from "@/lib/liveEvents";
import {
  type DashboardSession,
  type SSESessionEvent,
  type SSESnapshotSession,
} from "@/lib/types";

const ACTIVE_SESSIONS_POLL_INTERVAL_MS = 15_000;

type Listener = () => void;

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

function emitSessionChange() {
  for (const listener of sessionListeners) {
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

