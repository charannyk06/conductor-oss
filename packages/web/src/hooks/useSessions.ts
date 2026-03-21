"use client";

import { useSharedSessions } from "@/lib/sessionState";

interface UseSessionsOptions {
  enabled?: boolean;
  bridgeId?: string | null;
}

export function useSessions(projectId?: string | null, options?: UseSessionsOptions) {
  return useSharedSessions(projectId, options);
}
