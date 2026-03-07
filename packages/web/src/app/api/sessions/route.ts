import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { computeStats, sessionToDashboard } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions -- list current sessions for the dashboard.
 *
 * Query params:
 *   - project: filter by project ID
 *   - filter: attention filter (needs_input, blocked, errored, active, all)
 *   - compact: "true" for mobile-optimized minimal response
 */
export async function GET(request: NextRequest) {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { sessionManager } = await getServices();

    const searchParams = new URL(request.url).searchParams;
    const projectId = searchParams.get("project");
    const filter = searchParams.get("filter");
    const compact = searchParams.get("compact") === "true";
    const normalizedProjectId = projectId?.trim() ?? "";

    const sessions = normalizedProjectId
      ? await sessionManager.list(normalizedProjectId)
      : await sessionManager.list();
    let dashboardSessions = sessions.map((session) => sessionToDashboard(session));

    // Apply attention filter
    if (filter) {
      const needsAttentionStatuses = new Set(["needs_input", "stuck", "errored"]);
      const needsAttentionActivities = new Set(["waiting_input", "blocked"]);

      switch (filter) {
        case "needs_input":
        case "respond":
          dashboardSessions = dashboardSessions.filter(
            (s) => needsAttentionStatuses.has(s.status) || needsAttentionActivities.has(s.activity ?? ""),
          );
          break;
        case "blocked":
          dashboardSessions = dashboardSessions.filter(
            (s) => s.activity === "blocked" || s.status === "stuck",
          );
          break;
        case "errored":
          dashboardSessions = dashboardSessions.filter(
            (s) => s.status === "errored" || s.status === "ci_failed",
          );
          break;
        case "active":
        case "working":
          dashboardSessions = dashboardSessions.filter(
            (s) => s.activity === "active" || s.status === "working" || s.status === "spawning",
          );
          break;
        case "review":
          dashboardSessions = dashboardSessions.filter(
            (s) => s.status === "ci_failed" || s.status === "changes_requested" || s.status === "review_pending",
          );
          break;
        case "merge":
          dashboardSessions = dashboardSessions.filter(
            (s) => s.status === "mergeable" || s.status === "approved",
          );
          break;
        // "all" or unknown: no filter
      }
    }

    // Compact mode: minimal response for mobile
    if (compact) {
      const compactSessions = dashboardSessions.map((s) => ({
        id: s.id,
        p: s.projectId,
        s: s.status,
        a: s.activity,
        sum: s.summary ? s.summary.slice(0, 80) : null,
        pr: s.pr ? { n: s.pr.number, u: s.pr.url, ci: s.pr.ciStatus } : null,
        age: s.createdAt,
        idle: s.lastActivityAt,
      }));
      return NextResponse.json({
        sessions: compactSessions,
        stats: computeStats(dashboardSessions),
      });
    }

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
