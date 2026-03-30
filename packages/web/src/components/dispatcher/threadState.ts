import type { DashboardSession } from "@/lib/types";

export function compareDispatcherThreadsByActivity(
  left: DashboardSession,
  right: DashboardSession,
): number {
  return new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
}

export function sortDispatcherThreadsByActivity(
  threads: readonly DashboardSession[],
): DashboardSession[] {
  return [...threads].sort(compareDispatcherThreadsByActivity);
}

export function resolveSelectedDispatcherThreadId(
  currentSelectedThreadId: string | null,
  threads: readonly DashboardSession[],
  activeThreadId: string | null,
): string | null {
  if (currentSelectedThreadId && threads.some((thread) => thread.id === currentSelectedThreadId)) {
    return currentSelectedThreadId;
  }
  if (activeThreadId && threads.some((thread) => thread.id === activeThreadId)) {
    return activeThreadId;
  }
  return threads[0]?.id ?? null;
}

export function upsertDispatcherThread(
  threads: readonly DashboardSession[],
  nextThread: DashboardSession,
): DashboardSession[] {
  return sortDispatcherThreadsByActivity([
    nextThread,
    ...threads.filter((thread) => thread.id !== nextThread.id),
  ]);
}

export function reconcileDeletedDispatcherThread(
  threads: readonly DashboardSession[],
  selectedThreadId: string | null,
  deletedThreadId: string,
): {
  threads: DashboardSession[];
  selectedThreadId: string | null;
} {
  const nextThreads = threads.filter((thread) => thread.id !== deletedThreadId);
  const nextSelectedThreadId = resolveSelectedDispatcherThreadId(
    selectedThreadId === deletedThreadId ? null : selectedThreadId,
    nextThreads,
    null,
  );

  return {
    threads: nextThreads,
    selectedThreadId: nextSelectedThreadId,
  };
}
