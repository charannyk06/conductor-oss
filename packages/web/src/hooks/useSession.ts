"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToSnapshotEvents } from "@/lib/liveEvents";
import { TERMINAL_STATUSES, type DashboardSession, type SSESnapshotEvent } from "@/lib/types";

const ACTIVE_FALLBACK_POLL_INTERVAL_MS = 10_000;
const TERMINAL_FALLBACK_POLL_INTERVAL_MS = 30_000;

interface UseSessionReturn {
  session: DashboardSession | null;
  loading: boolean;
  error: string | null;
}

function sessionsEqual(left: DashboardSession | null, right: DashboardSession | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.id !== right.id ||
    left.projectId !== right.projectId ||
    left.status !== right.status ||
    left.activity !== right.activity ||
    left.branch !== right.branch ||
    left.issueId !== right.issueId ||
    left.summary !== right.summary ||
    left.createdAt !== right.createdAt ||
    left.lastActivityAt !== right.lastActivityAt
  ) {
    return false;
  }

  const leftMetadataKeys = Object.keys(left.metadata);
  const rightMetadataKeys = Object.keys(right.metadata);
  if (leftMetadataKeys.length !== rightMetadataKeys.length) return false;
  for (const key of leftMetadataKeys) {
    if (left.metadata[key] !== right.metadata[key]) return false;
  }

  if (left.pr === right.pr) return true;
  if (!left.pr || !right.pr) return false;
  return (
    left.pr.number === right.pr.number &&
    left.pr.url === right.pr.url &&
    left.pr.title === right.pr.title &&
    left.pr.branch === right.pr.branch &&
    left.pr.baseBranch === right.pr.baseBranch &&
    left.pr.isDraft === right.pr.isDraft &&
    left.pr.state === right.pr.state &&
    left.pr.ciStatus === right.pr.ciStatus &&
    left.pr.reviewDecision === right.pr.reviewDecision &&
    left.pr.previewUrl === right.pr.previewUrl &&
    left.pr.mergeability.mergeable === right.pr.mergeability.mergeable &&
    left.pr.mergeability.ciPassing === right.pr.mergeability.ciPassing &&
    left.pr.mergeability.approved === right.pr.mergeability.approved &&
    left.pr.mergeability.noConflicts === right.pr.mergeability.noConflicts &&
    left.pr.mergeability.blockers.length === right.pr.mergeability.blockers.length &&
    left.pr.mergeability.blockers.every((blocker, index) => blocker === right.pr?.mergeability.blockers[index])
  );
}

function mapSnapshotSession(session: SSESnapshotEvent["sessions"][number]): DashboardSession {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    summary: session.summary ?? null,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    pr: session.pr ?? null,
    metadata: session.metadata,
  };
}

export function useSession(id: string): UseSessionReturn {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const notFoundRef = useRef(false);
  const terminalRef = useRef(false);
  const snapshotSignatureRef = useRef<string | null>(null);

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
        setSession((current) => (sessionsEqual(current, data) ? current : data));
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
    snapshotSignatureRef.current = null;
    setSession(null);
    setError(null);
    setLoading(true);
    void fetchSession();
    const unsubscribe = subscribeToSnapshotEvents((event: SSESnapshotEvent) => {
      if (!mountedRef.current) return;
      const matchingSession = event.sessions.find((value) => value.id === id);
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
      if (!matchingSession) {
        return;
      }
      notFoundRef.current = false;
      terminalRef.current = TERMINAL_STATUSES.has(matchingSession.status);
      const nextSession = mapSnapshotSession(matchingSession);
      setSession((current) => (sessionsEqual(current, nextSession) ? current : nextSession));
      setError(null);
      setLoading(false);
    });

    let timeoutId: number | null = null;
    const scheduleFallbackFetch = () => {
      const delay = terminalRef.current
        ? TERMINAL_FALLBACK_POLL_INTERVAL_MS
        : ACTIVE_FALLBACK_POLL_INTERVAL_MS;
      timeoutId = window.setTimeout(async () => {
        await fetchSession();
        if (mountedRef.current && !notFoundRef.current) {
          scheduleFallbackFetch();
        }
      }, delay);
    };
    scheduleFallbackFetch();

    const refresh = () => {
      notFoundRef.current = false;
      snapshotSignatureRef.current = null;
      void fetchSession();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchSession]);

  return { session, loading, error };
}
