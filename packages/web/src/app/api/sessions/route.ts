import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { computeStats, sessionToDashboard } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** GET /api/sessions -- list current sessions for the dashboard. */
export async function GET(request: NextRequest) {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { sessionManager } = await getServices();

    const searchParams = new URL(request.url).searchParams;
    const projectId = searchParams.get("project");
    const normalizedProjectId = projectId?.trim() ?? "";
    const sessions = normalizedProjectId
      ? await sessionManager.list(normalizedProjectId)
      : await sessionManager.list();
    const dashboardSessions = sessions.map((session) => sessionToDashboard(session));
    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
