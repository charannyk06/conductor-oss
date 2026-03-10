"use client";

import { useSharedSessions } from "@/lib/sessionState";

interface UseSessionsOptions {
  enabled?: boolean;
}

export function useSessions(projectId?: string | null, options?: UseSessionsOptions) {
  return useSharedSessions(projectId, options);
}
