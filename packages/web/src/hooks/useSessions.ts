"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Session {
  id: string;
  status: string;
  agent: string;
  createdAt: string;
  [key: string]: unknown;
}

interface UseSessionsReturn {
  sessions: Session[];
  loading: boolean;
  error: string | null;
}

export function useSessions(): UseSessionsReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
      const json = await res.json();
      // API may return { sessions: [...], stats: {...} } or a raw array
      const data: Session[] = Array.isArray(json) ? json : (json.sessions ?? []);
      if (mountedRef.current) {
        setSessions(data);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchSessions]);

  return { sessions, loading, error };
}
