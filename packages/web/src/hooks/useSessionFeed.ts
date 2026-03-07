"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedChatEntry } from "@/lib/chatFeed";

const TERMINAL_STATUSES = new Set([
  "done",
  "killed",
  "errored",
  "terminated",
  "merged",
  "cleanup",
]);

interface SessionFeedResponse {
  entries?: NormalizedChatEntry[];
  sessionStatus?: string | null;
}

interface UseSessionFeedResult {
  entries: NormalizedChatEntry[];
  loading: boolean;
  error: string | null;
  sessionStatus: string | null;
  refresh: () => Promise<void>;
}

async function fetchFeed(sessionId: string): Promise<SessionFeedResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/feed`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to load chat feed: ${response.status}`);
  }

  return response.json() as Promise<SessionFeedResponse>;
}

export function useSessionFeed(sessionId: string | null | undefined): UseSessionFeedResult {
  const [entries, setEntries] = useState<NormalizedChatEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const terminalRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      setLoading(false);
      setError(null);
      setSessionStatus(null);
      return;
    }

    try {
      const payload = await fetchFeed(sessionId);
      const nextEntries = Array.isArray(payload.entries) ? payload.entries : [];
      setEntries((current) => (
        JSON.stringify(current) === JSON.stringify(nextEntries) ? current : nextEntries
      ));
      const status = typeof payload.sessionStatus === "string" ? payload.sessionStatus : null;
      setSessionStatus(status);
      if (status && TERMINAL_STATUSES.has(status)) {
        terminalRef.current = true;
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chat feed");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    terminalRef.current = false;
    setLoading(true);
    void refresh();

    if (!sessionId) return;
    const intervalId = window.setInterval(() => {
      if (terminalRef.current) {
        window.clearInterval(intervalId);
        return;
      }
      void refresh();
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [refresh, sessionId]);

  return useMemo(
    () => ({ entries, loading, error, sessionStatus, refresh }),
    [entries, error, loading, refresh, sessionStatus],
  );
}
