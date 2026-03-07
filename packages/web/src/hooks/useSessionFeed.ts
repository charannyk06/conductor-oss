"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NormalizedChatEntry } from "@/lib/chatFeed";

interface SessionFeedResponse {
  entries?: NormalizedChatEntry[];
  sessionStatus?: string | null;
}

interface UseSessionFeedResult {
  entries: NormalizedChatEntry[];
  loading: boolean;
  error: string | null;
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

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      setLoading(false);
      setError(null);
      return;
    }

    try {
      const payload = await fetchFeed(sessionId);
      const nextEntries = Array.isArray(payload.entries) ? payload.entries : [];
      setEntries((current) => (
        JSON.stringify(current) === JSON.stringify(nextEntries) ? current : nextEntries
      ));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chat feed");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    void refresh();

    if (!sessionId) return;
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [refresh, sessionId]);

  return useMemo(() => ({ entries, loading, error, refresh }), [entries, error, loading, refresh]);
}
