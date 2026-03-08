"use client";

import type { SSESnapshotEvent } from "@/lib/types";

type SnapshotListener = (event: SSESnapshotEvent) => void;

const listeners = new Set<SnapshotListener>();
let eventSource: EventSource | null = null;
let refreshInFlight: Promise<void> | null = null;

function normalizeSessionArray(value: unknown): SSESnapshotEvent | null {
  if (Array.isArray(value)) {
    return { type: "snapshot", sessions: value as SSESnapshotEvent["sessions"] };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if ((value as SSESnapshotEvent).type !== "snapshot") {
    return null;
  }

  const payload = value as SSESnapshotEvent;
  return Array.isArray(payload.sessions) ? payload : null;
}

function dispatchSnapshots(payload: SSESnapshotEvent) {
  for (const listener of listeners) {
    listener(payload);
  }
}

async function refreshSessions() {
  if (typeof fetch !== "function") {
    return;
  }

  const load = (async () => {
    try {
      const response = await fetch("/api/sessions");
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
  })();

  refreshInFlight = load.finally(() => {
    if (refreshInFlight === load) {
      refreshInFlight = null;
    }
  });

  await load;
}

function ensureEventSource() {
  if (eventSource || typeof EventSource === "undefined") {
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
    if (listeners.size === 0) {
      eventSource?.close();
      eventSource = null;
    }
  };
}

export function subscribeToSnapshotEvents(listener: SnapshotListener): () => void {
  listeners.add(listener);
  ensureEventSource();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
