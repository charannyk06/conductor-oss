"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { decodeBridgeSessionId, normalizeBridgeId } from "@/lib/bridgeSessionIds";
import { subscribeToSnapshotEvents } from "@/lib/liveEvents";
import {
  type DashboardSession,
  type SSESessionEvent,
  type SSESnapshotSession,
} from "@/lib/types";

const ACTIVE_SESSIONS_POLL_INTERVAL_MS = 15_000;
const REMOTE_SESSION_REFRESH_INTERVAL_MS = 5_000;
const LOCAL_SCOPE_KEY = "local";

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

const sessionsStores = new Map<string, SessionsStoreState>();
const sessionListenersByScope = new Map<string, Set<Listener>>();

function createSessionsStoreState(): SessionsStoreState {
  return {
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
}

function resolveScopeKey(bridgeId?: string | null): string {
  return normalizeBridgeId(bridgeId) ?? LOCAL_SCOPE_KEY;
}

function getSessionsStore(scopeKey: string): SessionsStoreState {
  let store = sessionsStores.get(scopeKey);
  if (!store) {
    store = createSessionsStoreState();
    sessionsStores.set(scopeKey, store);
  }
  return store;
}

function getSessionListeners(scopeKey: string): Set<Listener> {
  let listeners = sessionListenersByScope.get(scopeKey);
  if (!listeners) {
    listeners = new Set();
    sessionListenersByScope.set(scopeKey, listeners);
  }
  return listeners;
}

function emitSessionChange(scopeKey: string) {
  for (const listener of getSessionListeners(scopeKey)) {
    listener();
  }
}

function sortSessionIdsByCreatedAt(sessionsById: Map<string, DashboardSession>): string[] {
  return [...sessionsById.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((session) => session.id);
}

function commitSessionsState(
  scopeKey: string,
  sessionsById: Map<string, DashboardSession>,
  orderedIds: string[],
) {
  const store = getSessionsStore(scopeKey);
  store.sessionsById = sessionsById;
  store.orderedIds = orderedIds;
  store.version += 1;
}

function mapSnapshotSession(session: SSESnapshotSession): DashboardSession {
  return {
    id: session.id,
    projectId: session.projectId,
    bridgeId: session.bridgeId ?? null,
    bridgeConnected: session.bridgeConnected ?? null,
    bridgeConnection: session.bridgeConnection ?? null,
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

function applySessionEvent(scopeKey: string, event: SSESessionEvent) {
  const store = getSessionsStore(scopeKey);
  if (event.type === "snapshot") {
    commitSessionsState(scopeKey, new Map(
      event.sessions.map((session) => {
        const mapped = mapSnapshotSession(session);
        return [mapped.id, mapped] as const;
      }),
    ), event.sessions.map((session) => session.id));
  } else {
    const nextSessions = new Map(store.sessionsById);
    for (const session of event.sessions) {
      const mapped = mapSnapshotSession(session);
      nextSessions.set(mapped.id, mapped);
    }
    for (const sessionId of event.removedSessionIds ?? []) {
      nextSessions.delete(sessionId);
    }
    commitSessionsState(scopeKey, nextSessions, sortSessionIdsByCreatedAt(nextSessions));
  }
  store.loading = false;
  store.error = null;
  emitSessionChange(scopeKey);
}

function normalizeSessionsPayload(json: unknown): DashboardSession[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { sessions?: unknown })?.sessions)
      ? ((json as { sessions: DashboardSession[] }).sessions)
      : [];
  return list;
}

async function refreshSessionsStore(scopeKey: string, bridgeId?: string | null): Promise<void> {
  const store = getSessionsStore(scopeKey);
  if (store.refreshPromise) {
    await store.refreshPromise;
    return;
  }

  const load = (async () => {
    try {
      const response = await fetch(withBridgeQuery("/api/sessions", bridgeId), { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; reason?: string } | null;
        throw new Error(payload?.error ?? payload?.reason ?? `Failed to fetch sessions: ${response.status}`);
      }
      const payload = normalizeSessionsPayload(await response.json().catch(() => null));
      const sessionsById = new Map(payload.map((session) => [session.id, session] as const));
      commitSessionsState(scopeKey, sessionsById, sortSessionIdsByCreatedAt(sessionsById));
      store.error = null;
    } catch (error) {
      store.error = error instanceof Error ? error.message : "Failed to fetch sessions";
    } finally {
      store.loading = false;
      emitSessionChange(scopeKey);
    }
  })();

  store.refreshPromise = load.finally(() => {
    if (store.refreshPromise === load) {
      store.refreshPromise = null;
    }
  });
  await load;
}

function ensureSessionsSnapshotSubscription(scopeKey: string) {
  if (scopeKey !== LOCAL_SCOPE_KEY) {
    return;
  }

  const store = getSessionsStore(scopeKey);
  if (store.unsubscribeSnapshots) {
    return;
  }
  store.unsubscribeSnapshots = subscribeToSnapshotEvents((event) => {
    applySessionEvent(scopeKey, event);
  });
}

function sessionsPollDelay(): number {
  return ACTIVE_SESSIONS_POLL_INTERVAL_MS;
}

function sessionsRealtimeEnabled(): boolean {
  return document.visibilityState === "visible";
}

function clearSessionsPolling(scopeKey: string) {
  const store = getSessionsStore(scopeKey);
  if (store.pollTimer !== null) {
    window.clearTimeout(store.pollTimer);
    store.pollTimer = null;
  }
}

function scheduleSessionsPolling(scopeKey: string, bridgeId?: string | null) {
  const store = getSessionsStore(scopeKey);
  clearSessionsPolling(scopeKey);
  if (store.activeConsumers === 0 || !sessionsRealtimeEnabled()) {
    return;
  }

  store.pollTimer = window.setTimeout(async () => {
    const latestStore = getSessionsStore(scopeKey);
    if (latestStore.activeConsumers === 0 || !sessionsRealtimeEnabled()) {
      return;
    }
    await refreshSessionsStore(scopeKey, bridgeId);
    scheduleSessionsPolling(scopeKey, bridgeId);
  }, sessionsPollDelay());
}

function attachSessionsLifecycleListeners(scopeKey: string, bridgeId?: string | null) {
  const store = getSessionsStore(scopeKey);
  if (store.focusHandler || store.visibilityHandler) {
    return;
  }

  const handleFocus = () => {
    if (store.activeConsumers === 0) {
      return;
    }
    void refreshSessionsStore(scopeKey, bridgeId);
    scheduleSessionsPolling(scopeKey, bridgeId);
  };
  const handleVisibilityChange = () => {
    if (store.activeConsumers === 0) {
      return;
    }
    if (document.visibilityState === "visible") {
      void refreshSessionsStore(scopeKey, bridgeId);
    }
    clearSessionsPolling(scopeKey);
    scheduleSessionsPolling(scopeKey, bridgeId);
  };

  store.focusHandler = handleFocus;
  store.visibilityHandler = handleVisibilityChange;
  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function detachSessionsLifecycleListeners(scopeKey: string) {
  const store = getSessionsStore(scopeKey);
  if (store.focusHandler) {
    window.removeEventListener("focus", store.focusHandler);
    store.focusHandler = null;
  }
  if (store.visibilityHandler) {
    document.removeEventListener("visibilitychange", store.visibilityHandler);
    store.visibilityHandler = null;
  }
}

function activateSessionsStore(scopeKey: string, bridgeId?: string | null) {
  const store = getSessionsStore(scopeKey);
  store.activeConsumers += 1;
  if (store.activeConsumers > 1) {
    return;
  }

  ensureSessionsSnapshotSubscription(scopeKey);
  if (!store.listInitialized) {
    store.listInitialized = true;
  }
  attachSessionsLifecycleListeners(scopeKey, bridgeId);
  if (sessionsRealtimeEnabled()) {
    void refreshSessionsStore(scopeKey, bridgeId);
  }
  scheduleSessionsPolling(scopeKey, bridgeId);
}

function deactivateSessionsStore(scopeKey: string) {
  const store = getSessionsStore(scopeKey);
  store.activeConsumers = Math.max(0, store.activeConsumers - 1);
  if (store.activeConsumers > 0) {
    return;
  }

  clearSessionsPolling(scopeKey);
  detachSessionsLifecycleListeners(scopeKey);
  store.unsubscribeSnapshots?.();
  store.unsubscribeSnapshots = null;
}

function subscribeSessions(scopeKey: string, listener: Listener): () => void {
  const listeners = getSessionListeners(scopeKey);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function refreshSessionRecord(
  id: string,
  scopeKey: string,
  bridgeId?: string | null,
): Promise<DashboardSession | null> {
  const store = getSessionsStore(scopeKey);
  try {
    const response = await fetch(
      withBridgeQuery(`/api/sessions/${encodeURIComponent(id)}`, bridgeId),
      { cache: "no-store" },
    );
    if (response.status === 404) {
      const nextSessions = new Map(store.sessionsById);
      nextSessions.delete(id);
      commitSessionsState(scopeKey, nextSessions, sortSessionIdsByCreatedAt(nextSessions));
      store.error = null;
      emitSessionChange(scopeKey);
      return null;
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string; reason?: string } | null;
      throw new Error(payload?.error ?? payload?.reason ?? `Failed to fetch session: ${response.status}`);
    }

    const session = await response.json() as DashboardSession;
    const nextSessions = new Map(store.sessionsById);
    nextSessions.set(session.id, session);
    commitSessionsState(scopeKey, nextSessions, sortSessionIdsByCreatedAt(nextSessions));
    store.error = null;
    return session;
  } catch (error) {
    store.error = error instanceof Error ? error.message : "Failed to fetch session";
    throw error;
  } finally {
    store.loading = false;
    emitSessionChange(scopeKey);
  }
}

export function primeSessionStore(scopeKey: string, session: DashboardSession | null | undefined) {
  if (!session) {
    return;
  }

  const store = getSessionsStore(scopeKey);
  const existing = store.sessionsById.get(session.id);
  if (existing && JSON.stringify(existing) === JSON.stringify(session)) {
    return;
  }

  const nextSessions = new Map(store.sessionsById);
  nextSessions.set(session.id, session);
  commitSessionsState(scopeKey, nextSessions, sortSessionIdsByCreatedAt(nextSessions));
  store.loading = false;
  emitSessionChange(scopeKey);
}

function filterProjectSessions(scopeKey: string, projectId?: string | null): DashboardSession[] {
  const store = getSessionsStore(scopeKey);
  const normalized = projectId?.trim();
  return store.orderedIds
    .map((sessionId) => store.sessionsById.get(sessionId))
    .filter((session): session is DashboardSession => Boolean(session))
    .filter((session) => !normalized || session.projectId === normalized);
}

interface SharedSessionsOptions {
  enabled?: boolean;
  bridgeId?: string | null;
}

export function useSharedSessions(projectId?: string | null, options?: SharedSessionsOptions) {
  const enabled = options?.enabled ?? true;
  const scopeKey = resolveScopeKey(options?.bridgeId);
  const store = getSessionsStore(scopeKey);
  const [, forceRender] = useReducer((value) => value + 1, 0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    if (!enabled) {
      return undefined;
    }
    activateSessionsStore(scopeKey, options?.bridgeId);
    const unsubscribe = subscribeSessions(scopeKey, () => forceRender());
    return () => {
      unsubscribe();
      deactivateSessionsStore(scopeKey);
    };
  }, [enabled, options?.bridgeId, scopeKey]);

  const sessions = useMemo(
    () => (enabled && hydrated ? filterProjectSessions(scopeKey, projectId) : []),
    [enabled, hydrated, projectId, scopeKey, store.version],
  );

  return {
    sessions,
    loading: enabled ? (hydrated ? store.loading : true) : false,
    error: enabled ? store.error : null,
    refresh: () => refreshSessionsStore(scopeKey, options?.bridgeId),
  };
}

type SharedSessionOptions = {
  enabled?: boolean;
  bridgeId?: string | null;
};

export function useSharedSession(
  id: string | null | undefined,
  initialSession: DashboardSession | null = null,
  options?: SharedSessionOptions,
) {
  const enabled = options?.enabled ?? true;
  const normalizedId = typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  const inferredBridgeId = normalizeBridgeId(
    options?.bridgeId
      ?? initialSession?.bridgeId
      ?? decodeBridgeSessionId(normalizedId)?.bridgeId
      ?? null,
  );
  const scopeKey = resolveScopeKey(inferredBridgeId);
  const store = getSessionsStore(scopeKey);
  const [, forceRender] = useReducer((value) => value + 1, 0);
  const [hydrated, setHydrated] = useState(false);
  const [sessionOverride, setSessionOverride] = useState<DashboardSession | null>(initialSession);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(
    enabled && normalizedId !== null && initialSession === null,
  );

  useEffect(() => {
    setHydrated(true);
    primeSessionStore(scopeKey, initialSession);
    setSessionOverride(initialSession);
    setSessionError(null);
  }, [initialSession, scopeKey]);

  useEffect(() => {
    if (!enabled || normalizedId === null) {
      return undefined;
    }
    return subscribeSessions(scopeKey, () => forceRender());
  }, [enabled, normalizedId, scopeKey]);

  useEffect(() => {
    if (!enabled || normalizedId === null) {
      return undefined;
    }
    activateSessionsStore(scopeKey, inferredBridgeId);
    return () => {
      deactivateSessionsStore(scopeKey);
    };
  }, [enabled, inferredBridgeId, normalizedId, scopeKey]);

  useEffect(() => {
    if (!enabled || normalizedId === null || scopeKey === LOCAL_SCOPE_KEY) {
      return undefined;
    }

    const refresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshSessionRecord(normalizedId, scopeKey, inferredBridgeId).catch(() => {
        // Ignore transient remote refresh failures.
      });
    };

    refresh();
    const intervalId = window.setInterval(refresh, REMOTE_SESSION_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, inferredBridgeId, normalizedId, scopeKey]);

  useEffect(() => {
    if (!enabled || normalizedId === null) {
      setSessionOverride(null);
      setSessionError(null);
      setLoading(false);
      return;
    }

    if (initialSession || store.sessionsById.has(normalizedId)) {
      setSessionOverride((current) => store.sessionsById.get(normalizedId) ?? current ?? initialSession);
      setSessionError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSessionError(null);
    void refreshSessionRecord(normalizedId, scopeKey, inferredBridgeId)
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
  }, [enabled, inferredBridgeId, initialSession, normalizedId, scopeKey, store]);

  const session = normalizedId
    ? (hydrated
        ? store.sessionsById.get(normalizedId) ?? sessionOverride ?? initialSession ?? null
        : initialSession ?? null)
    : null;

  return {
    session,
    loading,
    error: enabled && normalizedId ? sessionError ?? store.error : null,
  };
}
