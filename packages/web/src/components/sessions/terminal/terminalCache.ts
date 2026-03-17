/**
 * Module-level cache and TTL logic for terminal UI state.
 */

import {
  TERMINAL_UI_STATE_CACHE_MAX_ENTRIES,
  TERMINAL_UI_STATE_CACHE_MAX_AGE_MS,
} from "./terminalConstants";
import type { CachedTerminalUiState } from "./terminalTypes";

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
