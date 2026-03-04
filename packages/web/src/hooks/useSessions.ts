"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SSESnapshotEvent } from "@/lib/types";

interface Session {
  id: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

interface UseSessionsReturn {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function sessionsEqual(left: Session[], right: Session[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) return false;

    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a["activity"] !== b["activity"] ||
      a["projectId"] !== b["projectId"] ||
      a["issueId"] !== b["issueId"] ||
      a["branch"] !== b["branch"] ||
      a["lastActivityAt"] !== b["lastActivityAt"] ||
      a["summary"] !== b["summary"]
    ) {
      return false;
    }
  }

  return true;
}

function filterByProject(sessions: Session[], projectId?: string | null): Session[] {
  const normalized = projectId?.trim();
  if (!normalized) return sessions;
  return sessions.filter((session) => session["projectId"] === normalized);
}

export function useSessions(projectId?: string | null): UseSessionsReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const applySessions = useCallback((nextSessions: Session[]) => {
    setSessions((prev) => (sessionsEqual(prev, nextSessions) ? prev : nextSessions));
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const query = typeof projectId === "string" && projectId.trim().length > 0
        ? `?project=${encodeURIComponent(projectId.trim())}`
        : "";
      const res = await fetch(`/api/sessions${query}`);
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
      const json = await res.json();
      const data = Array.isArray(json)
        ? json
        : Array.isArray((json as { sessions?: unknown }).sessions)
          ? (json as { sessions: Session[] }).sessions
          : [];
      if (!mountedRef.current) return;
      applySessions(data);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [applySessions, projectId]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    void fetchSessions();

    let eventSource: EventSource | null = null;
    let pollingId: number | null = null;

    const startPolling = () => {
      if (pollingId !== null) return;
      pollingId = window.setInterval(() => {
        if (mountedRef.current) void fetchSessions();
      }, 3000);
    };

    const stopPolling = () => {
      if (pollingId === null) return;
      window.clearInterval(pollingId);
      pollingId = null;
    };

    if (typeof EventSource !== "undefined") {
      eventSource = new EventSource("/api/events");
      eventSource.onopen = () => {
        if (!mountedRef.current) return;
        stopPolling();
        setError(null);
        setLoading(false);
      };
      eventSource.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data as string) as SSESnapshotEvent;
          if (data.type !== "snapshot" || !Array.isArray(data.sessions)) return;
          const filtered = filterByProject(data.sessions as unknown as Session[], projectId);
          applySessions(filtered);
          setError(null);
          setLoading(false);
        } catch {
          // Ignore malformed events and keep stream alive.
        }
      };
      eventSource.onerror = () => {
        if (!mountedRef.current) return;
        startPolling();
        setError((prev) => prev ?? "Live updates disconnected. Falling back to polling.");
      };
    } else {
      startPolling();
    }

    return () => {
      mountedRef.current = false;
      if (eventSource) eventSource.close();
      stopPolling();
    };
  }, [applySessions, fetchSessions, projectId]);

  return { sessions, loading, error, refresh: fetchSessions };
}
