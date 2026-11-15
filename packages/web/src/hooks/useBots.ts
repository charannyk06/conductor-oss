"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Bot, InboxItem } from "@/lib/bots";
import { fetchBots, fetchInbox } from "@/lib/botsApi";

const BOTS_POLL_INTERVAL_MS = 10_000;

interface UseBotsReturn {
  bots: Bot[];
  inbox: InboxItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setBots: (updater: (current: Bot[]) => Bot[]) => void;
}

/** Loads bots and the inbox, polling while the tab is visible. */
export function useBots(): UseBotsReturn {
  const [bots, setBotsState] = useState<Bot[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const [botsResult, inboxResult] = await Promise.allSettled([fetchBots(), fetchInbox()]);
    if (requestId !== requestIdRef.current) {
      return;
    }
    if (botsResult.status === "fulfilled") {
      setBotsState(botsResult.value);
      setError(null);
    } else {
      setError(botsResult.reason instanceof Error ? botsResult.reason.message : "Failed to load bots");
    }
    if (inboxResult.status === "fulfilled") {
      setInbox(inboxResult.value);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, BOTS_POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  const setBots = useCallback((updater: (current: Bot[]) => Bot[]) => {
    // Invalidate in-flight polls so they cannot overwrite a fresher local update.
    requestIdRef.current += 1;
    setBotsState(updater);
  }, []);

  return { bots, inbox, loading, error, refresh, setBots };
}
