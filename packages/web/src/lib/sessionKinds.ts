import type { DashboardSession } from "@/lib/types";

export const PROJECT_DISPATCHER_SESSION_KIND = "project_dispatcher";

export type SessionPrimaryTab = "chat" | "terminal";

export function isProjectDispatcherSession(
  session: Pick<DashboardSession, "metadata"> | null | undefined,
): boolean {
  return session?.metadata.sessionKind === PROJECT_DISPATCHER_SESSION_KIND;
}

export function getDefaultSessionPrimaryTab(
  session: Pick<DashboardSession, "metadata"> | null | undefined,
): SessionPrimaryTab {
  return "chat";
}
