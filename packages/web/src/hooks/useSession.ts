"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSession } from "@/lib/types";

const TERMINAL_STATUSES = new Set([
  "done",
  "killed",
  "errored",
  "terminated",
  "merged",
  "cleanup",
]);

interface UseSessionReturn {
  session: DashboardSession | null;
  loading: boolean;
  error: string | null;
}

export function useSession(id: string): UseSessionReturn {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const notFoundRef = useRef(false);
  const terminalRef = useRef(false);

  const fetchSession = useCallback(async () => {
    if (!id || notFoundRef.current || terminalRef.current) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        if (!mountedRef.current) return;
        notFoundRef.current = true;
        setSession(null);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`);
      const data: DashboardSession = await res.json();
      if (mountedRef.current) {
        setSession(data);
        setError(null);
        if (typeof data.status === "string" && TERMINAL_STATUSES.has(data.status)) {
          terminalRef.current = true;
        }
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    notFoundRef.current = false;
    terminalRef.current = false;
    fetchSession();
    const interval = setInterval(() => {
      if (terminalRef.current) {
        clearInterval(interval);
        return;
      }
      fetchSession();
    }, 3000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchSession]);

  return { session, loading, error };
}
