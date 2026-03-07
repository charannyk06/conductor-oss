"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type OutputStreamEvent =
  | { type: "output"; output: string }
  | { type: "error"; error: string };

interface UseSessionOutputStreamOptions {
  lines?: number;
  pollIntervalMs?: number;
}

interface UseSessionOutputStreamReturn {
  output: string;
  connected: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSessionOutputStream(
  sessionId: string,
  options: UseSessionOutputStreamOptions = {},
): UseSessionOutputStreamReturn {
  const { lines = 500, pollIntervalMs = 3000 } = options;
  const [output, setOutput] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchOutput = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/output?lines=${lines}`);
      if (!res.ok) {
        if (res.status === 404) {
          if (!mountedRef.current) return;
          setOutput("");
          setConnected(false);
          setError(null);
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to fetch output: ${res.status}`);
      }
      const data = (await res.json()) as { output?: string };
      if (!mountedRef.current) return;
      setOutput(typeof data.output === "string" ? data.output : "");
      setConnected(true);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setConnected(false);
      setError(err instanceof Error ? err.message : "Failed to fetch output");
    }
  }, [lines, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    setOutput("");
    setConnected(false);
    setError(null);
    void fetchOutput();

    let eventSource: EventSource | null = null;
    let pollingId: number | null = null;

    const startPolling = () => {
      if (pollingId !== null) return;
      pollingId = window.setInterval(() => {
        if (mountedRef.current) void fetchOutput();
      }, pollIntervalMs);
    };

    const stopPolling = () => {
      if (pollingId === null) return;
      window.clearInterval(pollingId);
      pollingId = null;
    };

    if (typeof EventSource !== "undefined") {
      eventSource = new EventSource(
        `/api/sessions/${encodeURIComponent(sessionId)}/output/stream?lines=${lines}`,
      );

      eventSource.onopen = () => {
        if (!mountedRef.current) return;
        stopPolling();
        setConnected(true);
        setError(null);
      };

      eventSource.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const payload = JSON.parse(event.data as string) as OutputStreamEvent;
          if (payload.type === "output") {
            setOutput(payload.output ?? "");
            setConnected(true);
            setError(null);
            return;
          }

          if (payload.type === "error") {
            const normalized = (payload.error || "").toLowerCase();
            setConnected(false);
            if (
              normalized.includes("not found") ||
              normalized.includes("workspace") ||
              normalized.includes("no output")
            ) {
              setError(null);
              setOutput("");
            } else {
              setError(payload.error || "Output stream error");
            }
            startPolling();
            void fetchOutput();
          }
        } catch {
          // Ignore malformed stream messages.
        }
      };

      eventSource.onerror = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        startPolling();
        void fetchOutput();
      };
    } else {
      startPolling();
    }

    return () => {
      mountedRef.current = false;
      stopPolling();
      if (eventSource) eventSource.close();
    };
  }, [fetchOutput, lines, pollIntervalMs, sessionId]);

  return {
    output,
    connected,
    error,
    refresh: fetchOutput,
  };
}
