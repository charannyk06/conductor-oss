import type { SSESessionEvent } from "@/lib/types";

const PROJECT_BOARD_REFRESH_EVENT = "conductor:project-board-refresh";

type FeedEntryLike = {
  kind?: unknown;
  metadata?: Record<string, unknown> | null | undefined;
};

export type ProjectBoardRefreshDetail = {
  projectId: string;
  reason: string;
};

const BOARD_MUTATION_EVENT_TYPES = new Set([
  "dispatcher_task_created",
  "dispatcher_task_updated",
  "dispatcher_task_handed_off",
]);

function readEventType(entry: FeedEntryLike): string | null {
  if (entry.kind !== "system") {
    return null;
  }
  const value = entry.metadata?.eventType;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function findDispatcherBoardRefreshReason(entries: FeedEntryLike[]): string | null {
  for (const entry of entries) {
    const eventType = readEventType(entry);
    if (eventType && BOARD_MUTATION_EVENT_TYPES.has(eventType)) {
      return eventType;
    }
  }
  return null;
}

export function shouldRefreshProjectBoardFromSnapshotEvent(
  event: SSESessionEvent,
  projectId: string,
): boolean {
  if (event.changedProjectIds?.includes(projectId)) {
    return true;
  }

  if (event.sessions.some((session) => session.projectId === projectId)) {
    return true;
  }

  // Project dispatcher threads are intentionally hidden from the dashboard
  // session list, so dispatcher-only board mutations currently surface as an
  // empty snapshot_delta. Treat that as a board refresh hint.
  return event.type === "snapshot_delta" && event.sessions.length === 0;
}

export function dispatchProjectBoardRefresh(detail: ProjectBoardRefreshDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ProjectBoardRefreshDetail>(PROJECT_BOARD_REFRESH_EVENT, {
      detail,
    }),
  );
}

export function subscribeProjectBoardRefresh(
  projectId: string,
  listener: (detail: ProjectBoardRefreshDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<ProjectBoardRefreshDetail>).detail;
    if (!detail || detail.projectId !== projectId) {
      return;
    }
    listener(detail);
  };

  window.addEventListener(PROJECT_BOARD_REFRESH_EVENT, handleEvent as EventListener);
  return () => {
    window.removeEventListener(PROJECT_BOARD_REFRESH_EVENT, handleEvent as EventListener);
  };
}
