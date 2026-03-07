"use client";

import type { SSESnapshotEvent } from "@/lib/types";

type SnapshotListener = (event: SSESnapshotEvent) => void;

const listeners = new Set<SnapshotListener>();
let eventSource: EventSource | null = null;

function ensureEventSource() {
  if (eventSource || typeof EventSource === "undefined") {
    return;
  }

  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data as string) as SSESnapshotEvent;
      if (payload.type !== "snapshot" || !Array.isArray(payload.sessions)) {
        return;
      }
      for (const listener of listeners) {
        listener(payload);
      }
    } catch {
      // Ignore malformed snapshot events.
    }
  };

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
