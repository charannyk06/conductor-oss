"use client";

import { useSharedSessionFeed } from "@/lib/sessionState";

export function useSessionFeed(
  sessionId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  return useSharedSessionFeed(sessionId, options);
}
