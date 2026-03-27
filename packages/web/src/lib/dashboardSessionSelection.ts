import { getDefaultSessionPrimaryTab } from "@/lib/sessionKinds";
import type { DashboardSession } from "@/lib/types";

export type DashboardSessionSelectionTab =
  | "overview"
  | "preview"
  | "diff"
  | "dispatcher"
  | "terminal";

export type DashboardSessionSelectionView = "direct" | "board";

type SessionSelectionTarget = Pick<DashboardSession, "projectId" | "metadata"> | null | undefined;

export function buildDashboardSessionSelection(
  sessionId: string,
  session: SessionSelectionTarget,
  selectedProjectId: string | null,
  currentWorkspaceView: DashboardSessionSelectionView,
  requestedTab?: DashboardSessionSelectionTab,
): {
  projectId: string | null;
  sessionId: string;
  tab: DashboardSessionSelectionTab;
  workspaceView?: "direct";
} {
  const selection = {
    projectId: session?.projectId ?? selectedProjectId ?? null,
    sessionId,
    tab: requestedTab ?? getDefaultSessionPrimaryTab(session),
  };

  if (currentWorkspaceView === "board") {
    return {
      ...selection,
      workspaceView: "direct",
    };
  }

  return selection;
}
