"use client";

import type { AppUpdateStatus, SSESessionEvent, SSESnapshotSession } from "@/lib/types";
import { resolveBridgeIdFromLocation, withBridgeQuery } from "@/lib/bridgeQuery";

type SnapshotListener = (event: SSESessionEvent) => void;
type AppUpdateListener = (update: AppUpdateStatus | null) => void;

const listeners = new Set<SnapshotListener>();
const appUpdateListeners = new Set<AppUpdateListener>();
let eventSource: EventSource | null = null;
let refreshInFlight: Promise<void> | null = null;
let focusHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

function hasSubscribers() {
  return listeners.size > 0 || appUpdateListeners.size > 0;
}

function pageVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function closeEventSource() {
  if (!eventSource) {
    return;
  }
  eventSource.close();
  eventSource = null;
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

function ensureEventSource() {
  if (
    eventSource
    || typeof EventSource === "undefined"
    || !hasSubscribers()
    || !pageVisible()
    || currentBridgeId()
  ) {
    return;
  }

  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (event) => {
    try {
      const payload = normalizeSessionArray(JSON.parse(event.data as string));
      if (!payload) return;
      dispatchSnapshots(payload);
    } catch {
      // Ignore malformed snapshot events.
    }
  };

  eventSource.addEventListener("refresh", () => {
    if (!refreshInFlight) {
      void refreshSessions();
    } else {
      void refreshInFlight;
    }
  });

  eventSource.onerror = () => {
    if (!hasSubscribers() || !pageVisible()) {
      closeEventSource();
    }
  };
}

function attachLifecycleListeners() {
  if (focusHandler || visibilityHandler || typeof window === "undefined") {
    return;
  }

  focusHandler = () => {
    if (!hasSubscribers() || !pageVisible()) {
      return;
    }
    ensureEventSource();
    if (!refreshInFlight) {
      void refreshSessions();
    }
  };

  visibilityHandler = () => {
    if (!hasSubscribers()) {
      closeEventSource();
      return;
    }
    if (!pageVisible()) {
      closeEventSource();
      return;
    }
    ensureEventSource();
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
    closeEventSource();
    detachLifecycleListeners();
    return;
  }
  attachLifecycleListeners();
  if (currentBridgeId()) {
    closeEventSource();
    return;
  }
  if (!pageVisible()) {
    closeEventSource();
    return;
  }
  ensureEventSource();
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
