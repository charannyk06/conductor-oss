import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/sessions -- per-session health metrics.
 *
 * Returns session-level health: age, spawn duration, activity transitions,
 * and whether the session is in a healthy operational state.
 */
export async function GET(): Promise<NextResponse> {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { sessionManager } = await getServices();
    const sessions = await sessionManager.list();

    const now = Date.now();
    const metrics = sessions.map((session) => {
      const createdMs = session.createdAt.getTime();
      const lastActivityMs = session.lastActivityAt.getTime();
      const ageMs = now - createdMs;
      const idleMs = now - lastActivityMs;

      // Determine health state
      let health: "healthy" | "warning" | "critical" = "healthy";
      const terminalStatuses = new Set(["killed", "terminated", "done", "cleanup", "merged", "errored"]);

      if (terminalStatuses.has(session.status)) {
        health = "healthy"; // terminal is expected
      } else if (session.status === "spawning" && ageMs > 600_000) {
        health = "critical"; // zombie spawn
      } else if (session.status === "spawning" && ageMs > 120_000) {
        health = "warning"; // slow spawn
      } else if (session.activity === "blocked" && idleMs > 600_000) {
        health = "critical"; // stuck
      } else if (session.activity === "waiting_input" && idleMs > 300_000) {
        health = "warning"; // waiting too long
      } else if (session.status === "stuck") {
        health = "critical";
      } else if (session.status === "needs_input") {
        health = "warning";
      }

      return {
        id: session.id,
        projectId: session.projectId,
        status: session.status,
        activity: session.activity,
        health,
        ageMs,
        idleMs,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
        hasRuntime: session.runtimeHandle !== null,
        hasPR: session.pr !== null,
      };
    });

    const summary = {
      total: metrics.length,
      healthy: metrics.filter((m) => m.health === "healthy").length,
      warning: metrics.filter((m) => m.health === "warning").length,
      critical: metrics.filter((m) => m.health === "critical").length,
    };

    return NextResponse.json({ metrics, summary });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get session health" },
      { status: 500 },
    );
  }
}
