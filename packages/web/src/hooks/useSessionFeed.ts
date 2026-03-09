"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedChatEntry } from "@/lib/chatFeed";
import { subscribeToSnapshotEvents } from "@/lib/liveEvents";
import type { SessionRuntimeStatus } from "@/lib/sessionRuntimeStatus";
import { TERMINAL_STATUSES, type SSESnapshotEvent } from "@/lib/types";
const ACTIVE_POLL_INTERVAL_MS = 4_000;
const HIDDEN_POLL_INTERVAL_MS = 15_000;
const TERMINAL_POLL_INTERVAL_MS = 30_000;

interface SessionFeedResponse {
  entries?: NormalizedChatEntry[];
  sessionStatus?: string | null;
  error?: string | null;
  parserState?: {
    kind?: string | null;
    message?: string | null;
    command?: string | null;
  } | null;
  runtimeStatus?: SessionRuntimeStatus | null;
}

export interface SessionParserState {
  kind: string;
  message: string;
  command: string | null;
}

interface UseSessionFeedResult {
  entries: NormalizedChatEntry[];
  loading: boolean;
  error: string | null;
  sessionStatus: string | null;
  parserState: SessionParserState | null;
  runtimeStatus: SessionRuntimeStatus | null;
  refresh: () => Promise<void>;
}

function entriesEqual(left: NormalizedChatEntry[], right: NormalizedChatEntry[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) return false;
    if (
      a.id !== b.id
      || a.kind !== b.kind
      || a.label !== b.label
      || a.text !== b.text
      || a.createdAt !== b.createdAt
      || a.streaming !== b.streaming
      || a.source !== b.source
      || a.attachments.length !== b.attachments.length
    ) {
      return false;
    }
    const aToolTitle = typeof a.metadata?.toolTitle === "string" ? a.metadata.toolTitle : null;
    const bToolTitle = typeof b.metadata?.toolTitle === "string" ? b.metadata.toolTitle : null;
    const aToolStatus = typeof a.metadata?.toolStatus === "string" ? a.metadata.toolStatus : null;
    const bToolStatus = typeof b.metadata?.toolStatus === "string" ? b.metadata.toolStatus : null;
    const aToolKind = typeof a.metadata?.toolKind === "string" ? a.metadata.toolKind : null;
    const bToolKind = typeof b.metadata?.toolKind === "string" ? b.metadata.toolKind : null;
    const aToolContent = Array.isArray(a.metadata?.toolContent) ? a.metadata.toolContent : [];
    const bToolContent = Array.isArray(b.metadata?.toolContent) ? b.metadata.toolContent : [];
    if (
      aToolTitle !== bToolTitle
      || aToolStatus !== bToolStatus
      || aToolKind !== bToolKind
      || aToolContent.length !== bToolContent.length
    ) {
      return false;
    }
    for (let toolIndex = 0; toolIndex < aToolContent.length; toolIndex += 1) {
      if (aToolContent[toolIndex] !== bToolContent[toolIndex]) {
        return false;
      }
    }
  }

  return true;
}

function normalizeParserState(value: SessionFeedResponse["parserState"]): SessionParserState | null {
  if (!value || typeof value !== "object") return null;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const command = typeof value.command === "string" && value.command.trim().length > 0
    ? value.command.trim()
    : null;
  if (!kind || !message) return null;
  return { kind, message, command };
}

function normalizeRuntimeStatus(value: SessionFeedResponse["runtimeStatus"]): SessionRuntimeStatus | null {
  if (!value || typeof value !== "object") return null;
  return value;
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
  const [parserState, setParserState] = useState<SessionParserState | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<SessionRuntimeStatus | null>(null);
  const terminalRef = useRef(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const snapshotSignatureRef = useRef<string | null>(null);

  const applyPayload = useCallback((payload: SessionFeedResponse) => {
    const nextEntries = Array.isArray(payload.entries) ? payload.entries : [];
    setEntries((current) => {
      return entriesEqual(current, nextEntries) ? current : nextEntries;
    });
    const status = typeof payload.sessionStatus === "string" ? payload.sessionStatus : null;
    setSessionStatus(status);
    if (status && TERMINAL_STATUSES.has(status)) {
      terminalRef.current = true;
    }
    setParserState((current) => {
      const next = normalizeParserState(payload.parserState);
      if (current === null && next === null) return current;
      if (current?.kind === next?.kind && current?.message === next?.message && current?.command === next?.command) {
        return current;
      }
      return next;
    });
    setRuntimeStatus((current) => {
      const next = normalizeRuntimeStatus(payload.runtimeStatus);
      if (JSON.stringify(current) === JSON.stringify(next)) {
        return current;
      }
      return next;
    });
    const nextError = typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error.trim()
      : null;
    setError(nextError);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setEntries([]);
      setLoading(false);
      setError(null);
      setSessionStatus(null);
      setParserState(null);
      setRuntimeStatus(null);
      return;
    }

    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }

    inFlightRef.current = true;

    do {
      try {
        const payload = await fetchFeed(sessionId);
        if (!mountedRef.current) break;
        applyPayload(payload);
      } catch (err) {
        if (!mountedRef.current) break;
        const message = err instanceof Error ? err.message : "Failed to load chat feed";
        if (message.includes("404")) {
          setEntries([]);
          setSessionStatus(null);
          setParserState(null);
          setRuntimeStatus(null);
        }
        setError(message);
        setLoading(false);
      }

      if (!pendingRef.current) break;
      pendingRef.current = false;
    } while (mountedRef.current);

    inFlightRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    terminalRef.current = false;
    snapshotSignatureRef.current = null;
    pendingRef.current = false;
    setEntries([]);
    setSessionStatus(null);
    setParserState(null);
    setRuntimeStatus(null);
    setError(null);
    setLoading(true);
    void refresh();

    if (!sessionId) {
      return () => {
        mountedRef.current = false;
      };
    }
    const handleWindowFocus = () => {
      if (!terminalRef.current) {
        snapshotSignatureRef.current = null;
        void refresh();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !terminalRef.current) {
        snapshotSignatureRef.current = null;
        void refresh();
      }
    };
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    let eventSource: EventSource | null = null;

    let pollTimeoutId: number | null = null;

    const stopPolling = () => {
      if (pollTimeoutId === null) return;
      window.clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    };

    const startPolling = () => {
      stopPolling();
      const interval = terminalRef.current
        ? TERMINAL_POLL_INTERVAL_MS
        : document.visibilityState === "visible"
          ? ACTIVE_POLL_INTERVAL_MS
          : HIDDEN_POLL_INTERVAL_MS;
      pollTimeoutId = window.setTimeout(async () => {
        await refresh();
        if (mountedRef.current) {
          startPolling();
        }
      }, interval);
    };

    startPolling();
    if (typeof EventSource !== "undefined") {
      eventSource = new EventSource(
        `/api/sessions/${encodeURIComponent(sessionId)}/feed/stream`,
      );

      eventSource.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const payload = JSON.parse(event.data as string) as SessionFeedResponse;
          applyPayload(payload);
          startPolling();
        } catch {
          // Ignore malformed session feed events.
        }
      };

      eventSource.addEventListener("refresh", () => {
        if (!mountedRef.current) return;
        void refresh();
        startPolling();
      });

      eventSource.onerror = () => {
        if (!mountedRef.current) return;
        void refresh();
        startPolling();
      };
    }

    const unsubscribe = subscribeToSnapshotEvents((payload: SSESnapshotEvent) => {
      if (!mountedRef.current) return;
      const matchingSession = payload.sessions.find((value) => value.id === sessionId);
      const signature = matchingSession
        ? [
          matchingSession.id,
          matchingSession.status,
          matchingSession.activity ?? "",
          matchingSession.lastActivityAt,
          matchingSession.summary ?? "",
        ].join(":")
        : "missing";
      if (snapshotSignatureRef.current === signature) {
        return;
      }
      snapshotSignatureRef.current = signature;
      void refresh();
      startPolling();
    });

    return () => {
      mountedRef.current = false;
      stopPolling();
      eventSource?.close();
      unsubscribe();
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, sessionId]);

  return useMemo(
    () => ({ entries, loading, error, sessionStatus, parserState, runtimeStatus, refresh }),
    [entries, error, loading, parserState, refresh, runtimeStatus, sessionStatus],
  );
}
