/**
 * Module-level Map caches and TTL logic for terminal connections,
 * snapshots, and UI state.
 */

import {
  TERMINAL_CONNECTION_CACHE_MAX_TTL_MS,
  TERMINAL_CONNECTION_CACHE_MAX_ENTRIES,
  TERMINAL_SNAPSHOT_CACHE_MAX_ENTRIES,
  TERMINAL_UI_STATE_CACHE_MAX_ENTRIES,
  TERMINAL_SNAPSHOT_CACHE_MAX_AGE_MS,
  TERMINAL_UI_STATE_CACHE_MAX_AGE_MS,
} from "./terminalConstants";
import type {
  TerminalConnectionInfo,
  TerminalSnapshot,
  CachedTerminalConnection,
  CachedTerminalSnapshot,
  CachedTerminalUiState,
} from "./terminalTypes";

export const terminalConnectionCache = new Map<string, CachedTerminalConnection>();
export const terminalSnapshotCache = new Map<string, CachedTerminalSnapshot>();
export const terminalUiStateCache = new Map<string, CachedTerminalUiState>();

export function trimTerminalCache(cache: Map<string, unknown>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

export function readCachedTerminalConnection(sessionId: string): TerminalConnectionInfo | null {
  const cached = terminalConnectionCache.get(sessionId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    terminalConnectionCache.delete(sessionId);
    return null;
  }
  return cached.value;
}

export function storeCachedTerminalConnection(sessionId: string, value: TerminalConnectionInfo): void {
  terminalConnectionCache.delete(sessionId);
  terminalConnectionCache.set(sessionId, {
    value,
    expiresAt: Date.now() + TERMINAL_CONNECTION_CACHE_MAX_TTL_MS,
  });
  trimTerminalCache(terminalConnectionCache, TERMINAL_CONNECTION_CACHE_MAX_ENTRIES);
}

export function clearCachedTerminalConnection(sessionId: string): void {
  terminalConnectionCache.delete(sessionId);
}

export function readCachedTerminalSnapshot(sessionId: string): TerminalSnapshot | null {
  const cached = terminalSnapshotCache.get(sessionId);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.updatedAt > TERMINAL_SNAPSHOT_CACHE_MAX_AGE_MS) {
    terminalSnapshotCache.delete(sessionId);
    return null;
  }
  return {
    snapshot: cached.snapshot,
    transcript: cached.transcript,
    source: cached.source,
    live: cached.live,
    restored: cached.restored,
    sequence: cached.sequence,
    modes: cached.modes,
  };
}

export function storeCachedTerminalSnapshot(sessionId: string, snapshot: TerminalSnapshot): void {
  terminalSnapshotCache.delete(sessionId);
  terminalSnapshotCache.set(sessionId, {
    ...snapshot,
    updatedAt: Date.now(),
  });
  trimTerminalCache(terminalSnapshotCache, TERMINAL_SNAPSHOT_CACHE_MAX_ENTRIES);
}

export function clearCachedTerminalSnapshot(sessionId: string): void {
  terminalSnapshotCache.delete(sessionId);
}

export function readCachedTerminalUiState(sessionId: string): CachedTerminalUiState | null {
  const cached = terminalUiStateCache.get(sessionId);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.updatedAt > TERMINAL_UI_STATE_CACHE_MAX_AGE_MS) {
    terminalUiStateCache.delete(sessionId);
    return null;
  }
  return cached;
}

export function storeCachedTerminalUiState(
  sessionId: string,
  value: Omit<CachedTerminalUiState, "updatedAt">,
): void {
  terminalUiStateCache.delete(sessionId);
  terminalUiStateCache.set(sessionId, {
    ...value,
    updatedAt: Date.now(),
  });
  trimTerminalCache(terminalUiStateCache, TERMINAL_UI_STATE_CACHE_MAX_ENTRIES);
}
