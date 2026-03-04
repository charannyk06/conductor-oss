"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SessionDetail {
  id: string;
  status: string;
  agent: string;
  output: string;
  createdAt: string;
  [key: string]: unknown;
}

interface UseSessionReturn {
  session: SessionDetail | null;
  loading: boolean;
  error: string | null;
}

export function useSession(id: string): UseSessionReturn {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchSession = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`);
      const data: SessionDetail = await res.json();
      if (mountedRef.current) {
        setSession(data);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    fetchSession();
    const interval = setInterval(fetchSession, 2000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchSession]);

  return { session, loading, error };
}
