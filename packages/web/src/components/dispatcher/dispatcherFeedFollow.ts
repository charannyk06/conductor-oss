import type { SessionFeedEntry } from "./dispatcherFeedState";

export type DispatcherFeedFollowState = {
  followLatest: boolean;
  showJumpToLatest: boolean;
  unseenCount: number;
  unseenEntryIds: string[];
};

export type DispatcherFeedScrollIntent = {
  nearBottom: boolean;
  previousScrollTop: number;
  scrollTop: number;
  isUserInitiated: boolean;
};

export const DISPATCHER_FEED_GESTURE_INTENT_WINDOW_MS = 320;

function normalizeUnseenEntryIds(entryIds: readonly string[]): string[] {
  const nextIds: string[] = [];
  const seen = new Set<string>();
  for (const entryId of entryIds) {
    if (!entryId || seen.has(entryId)) {
      continue;
    }
    seen.add(entryId);
    nextIds.push(entryId);
  }
  return nextIds;
}

function withUnseenEntryIds(
  state: DispatcherFeedFollowState,
  unseenEntryIds: readonly string[],
): DispatcherFeedFollowState {
  const nextUnseenEntryIds = normalizeUnseenEntryIds(unseenEntryIds);
  return {
    ...state,
    unseenEntryIds: nextUnseenEntryIds,
    unseenCount: nextUnseenEntryIds.length,
  };
}

export function resetDispatcherFeedFollowState(): DispatcherFeedFollowState {
  return {
    followLatest: true,
    showJumpToLatest: false,
    unseenCount: 0,
    unseenEntryIds: [],
  };
}

export function createDispatcherFeedGestureIntentDeadline(now: number): number {
  return now + DISPATCHER_FEED_GESTURE_INTENT_WINDOW_MS;
}

export function hasDispatcherFeedGestureIntent(deadline: number, now: number): boolean {
  return Number.isFinite(deadline) && deadline > 0 && now <= deadline;
}

function buildDispatcherFeedEntrySignature(entry: SessionFeedEntry): string {
  return JSON.stringify([
    entry.kind,
    entry.label,
    entry.text,
    entry.createdAt,
    entry.source,
    entry.streaming,
    entry.attachments,
    entry.metadata,
  ]);
}

export function collectDispatcherChangedFeedEntryIds(
  previousEntries: readonly SessionFeedEntry[],
  nextEntries: readonly SessionFeedEntry[],
): string[] {
  if (nextEntries.length === 0) {
    return [];
  }

  const previousById = new Map<string, SessionFeedEntry>();
  for (const entry of previousEntries) {
    previousById.set(entry.id, entry);
  }

  const changedEntryIds: string[] = [];
  for (const entry of nextEntries) {
    const previousEntry = previousById.get(entry.id);
    if (!previousEntry) {
      changedEntryIds.push(entry.id);
      continue;
    }

    if (previousEntry === entry) {
      continue;
    }

    const previousSignature = buildDispatcherFeedEntrySignature(previousEntry);
    const nextSignature = buildDispatcherFeedEntrySignature(entry);
    if (previousSignature !== nextSignature) {
      changedEntryIds.push(entry.id);
    }
  }

  return normalizeUnseenEntryIds(changedEntryIds);
}

export function applyDispatcherFeedEntryUpdates(
  state: DispatcherFeedFollowState,
  entryIds: readonly string[],
): DispatcherFeedFollowState {
  const nextEntryIds = normalizeUnseenEntryIds(entryIds);
  if (nextEntryIds.length === 0) {
    return state;
  }

  if (state.followLatest) {
    return withUnseenEntryIds({
      ...state,
      showJumpToLatest: false,
    }, []);
  }

  return withUnseenEntryIds({
    ...state,
    showJumpToLatest: true,
  }, [...state.unseenEntryIds, ...nextEntryIds]);
}

export function reduceDispatcherFeedFollowOnScroll(
  state: DispatcherFeedFollowState,
  intent: DispatcherFeedScrollIntent,
): DispatcherFeedFollowState {
  if (intent.nearBottom) {
    return resetDispatcherFeedFollowState();
  }

  if (!intent.isUserInitiated) {
    return state;
  }

  if (intent.scrollTop < intent.previousScrollTop) {
    return {
      ...state,
      followLatest: false,
      showJumpToLatest: true,
    };
  }

  return state;
}
