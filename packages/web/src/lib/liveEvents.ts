"use client";

import type { AppUpdateStatus, SSESessionEvent, SSESnapshotSession } from "@/lib/types";
import { resolveBridgeIdFromLocation, withBridgeQuery } from "@/lib/bridgeQuery";
import { iterateSseFrames } from "@/lib/sseFetch";

type SnapshotListener = (event: SSESessionEvent) => void;
type AppUpdateListener = (update: AppUpdateStatus | null) => void;

const listeners = new Set<SnapshotListener>();
const appUpdateListeners = new Set<AppUpdateListener>();
let refreshInFlight: Promise<void> | null = null;
let focusHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

/** Active fetch stream to /api/events; aborted when tearing down or reconnecting */
let eventsStreamAbort: AbortController | null = null;
let eventsReconnectTimer: number | null = null;
let eventsReconnectAttempt = 0;

function hasSubscribers() {
  return listeners.size > 0 || appUpdateListeners.size > 0;
}

function pageVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function normalizeSessionArray(value: unknown): SSESessionEvent | null {
  if (Array.isArray(value)) {
    return { type: "snapshot", sessions: value as SSESnapshotSession[] };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const type = (value as { type?: string }).type;
  if (type !== "snapshot" && type !== "snapshot_delta") {
    return null;
  }

  const payload = value as SSESessionEvent;
  return Array.isArray(payload.sessions) ? payload : null;
}

function normalizeAppUpdate(value: unknown): AppUpdateStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as AppUpdateStatus;
  return typeof candidate.enabled === "boolean" ? candidate : null;
}

function dispatchSnapshots(payload: SSESessionEvent) {
  for (const listener of listeners) {
    listener(payload);
  }

  const normalizedAppUpdate = normalizeAppUpdate(payload.appUpdate);
  if (!normalizedAppUpdate) return;
  for (const listener of appUpdateListeners) {
    listener(normalizedAppUpdate);
  }
}

function dispatchAppUpdate(update: AppUpdateStatus | null) {
  for (const listener of appUpdateListeners) {
    listener(update);
  }
}

function currentBridgeId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return resolveBridgeIdFromLocation(window.location.href);
}

async function refreshSessions() {
  if (typeof fetch !== "function") {
    return;
  }

  const load = (async () => {
    const bridgeId = currentBridgeId();
    try {
      const response = await fetch(withBridgeQuery("/api/sessions", bridgeId));
      if (!response.ok) {
        return;
      }
      const body = await response.json().catch(() => null);
      const payload = normalizeSessionArray(body);
      if (!payload) return;
      dispatchSnapshots(payload);
    } catch {
      // Ignore transient refresh failures.
    }

    try {
      const response = await fetch(withBridgeQuery("/api/app-update", bridgeId));
      if (!response.ok) {
        return;
      }
      const body = await response.json().catch(() => null);
      dispatchAppUpdate(normalizeAppUpdate(body));
    } catch {
      // Ignore transient refresh failures.
    }
  })();

  refreshInFlight = load.finally(() => {
    if (refreshInFlight === load) {
      refreshInFlight = null;
    }
  });

  await load;
}

function clearEventsReconnectTimer() {
  if (eventsReconnectTimer !== null) {
    window.clearTimeout(eventsReconnectTimer);
    eventsReconnectTimer = null;
  }
}

function handleEventsSseFrame(frame: { event: string | null; data: string }) {
  if (frame.event === "refresh") {
    if (!refreshInFlight) {
      void refreshSessions();
    } else {
      void refreshInFlight;
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data) as unknown;
  } catch {
    return;
  }

  if (
    parsed
    && typeof parsed === "object"
    && (parsed as { type?: string }).type === "refresh"
  ) {
    if (!refreshInFlight) {
      void refreshSessions();
    } else {
      void refreshInFlight;
    }
    return;
  }

  const payload = normalizeSessionArray(parsed);
  if (!payload) return;
  dispatchSnapshots(payload);
}

function scheduleEventsStreamReconnect() {
  if (!hasSubscribers() || !pageVisible() || currentBridgeId()) {
    return;
  }
  clearEventsReconnectTimer();
  const delay =
    eventsReconnectAttempt === 0
      ? 250
      : Math.min(400 * 2 ** (eventsReconnectAttempt - 1), 12_000);
  eventsReconnectAttempt += 1;
  eventsReconnectTimer = window.setTimeout(() => {
    eventsReconnectTimer = null;
    ensureEventsStream();
  }, delay);
}

function closeEventsStream() {
  clearEventsReconnectTimer();
  eventsReconnectAttempt = 0;
  eventsStreamAbort?.abort();
  eventsStreamAbort = null;
}

async function runEventsStream(ac: AbortController) {
  try {
    const response = await fetch("/api/events", {
      cache: "no-store",
      signal: ac.signal,
    });
    if (!response.ok || !response.body) {
      if (!ac.signal.aborted) {
        scheduleEventsStreamReconnect();
      }
      return;
    }

    eventsReconnectAttempt = 0;
    for await (const frame of iterateSseFrames(response.body, ac.signal)) {
      handleEventsSseFrame(frame);
    }

    if (!ac.signal.aborted) {
      scheduleEventsStreamReconnect();
    }
  } catch {
    if (!ac.signal.aborted) {
      scheduleEventsStreamReconnect();
    }
  }
}

function ensureEventsStream() {
  if (
    typeof fetch === "undefined"
    || eventsStreamAbort
    || !hasSubscribers()
    || !pageVisible()
    || currentBridgeId()
  ) {
    return;
  }

  const ac = new AbortController();
  eventsStreamAbort = ac;
  void (async () => {
    try {
      await runEventsStream(ac);
    } finally {
      if (eventsStreamAbort === ac) {
        eventsStreamAbort = null;
      }
    }
  })();
}

function attachLifecycleListeners() {
  if (focusHandler || visibilityHandler || typeof window === "undefined") {
    return;
  }

  focusHandler = () => {
    if (!hasSubscribers() || !pageVisible()) {
      return;
    }
    ensureEventsStream();
    if (!refreshInFlight) {
      void refreshSessions();
    }
  };

  visibilityHandler = () => {
    if (!hasSubscribers()) {
      closeEventsStream();
      return;
    }
    if (!pageVisible()) {
      closeEventsStream();
      return;
    }
    ensureEventsStream();
    if (!refreshInFlight) {
      void refreshSessions();
    }
  };

  window.addEventListener("focus", focusHandler);
  document.addEventListener("visibilitychange", visibilityHandler);
}

function detachLifecycleListeners() {
  if (focusHandler) {
    window.removeEventListener("focus", focusHandler);
    focusHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
}

function syncLifecycleState() {
  if (!hasSubscribers()) {
    closeEventsStream();
    detachLifecycleListeners();
    return;
  }
  attachLifecycleListeners();
  if (currentBridgeId()) {
    closeEventsStream();
    return;
  }
  if (!pageVisible()) {
    closeEventsStream();
    return;
  }
  ensureEventsStream();
}

export function subscribeToSnapshotEvents(listener: SnapshotListener): () => void {
  listeners.add(listener);
  syncLifecycleState();

  return () => {
    listeners.delete(listener);
    syncLifecycleState();
  };
}

export function subscribeToAppUpdateEvents(listener: AppUpdateListener): () => void {
  appUpdateListeners.add(listener);
  syncLifecycleState();

  return () => {
    appUpdateListeners.delete(listener);
    syncLifecycleState();
  };
}
