"use client";

import type { DashboardSession } from "@/lib/types";
import { useSharedSession } from "@/lib/sessionState";

interface UseSessionOptions {
  enabled?: boolean;
}

export function useSession(
  id: string | null | undefined,
  initialSession: DashboardSession | null = null,
  options?: UseSessionOptions,
) {
  return useSharedSession(id, initialSession, options);
}
