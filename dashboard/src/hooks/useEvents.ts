import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface ConductorEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export function useEvents(maxEvents = 100) {
  const [events, setEvents] = useState<ConductorEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = api.eventStream();

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as ConductorEvent;
        setEvents((prev) => [event, ...prev].slice(0, maxEvents));
      } catch {
        // Skip malformed events.
      }
    };

    return () => es.close();
  }, [maxEvents]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, connected, clear };
}
