import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { sessionToDashboard, computeStats } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** GET /api/sessions -- List all sessions with dashboard state. */
export async function GET() {
  const denied = await guardApiAccess();
  if (denied) return denied;
  try {
    const { sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();
    const sessions = coreSessions.map(sessionToDashboard);

    return NextResponse.json({
      sessions,
      stats: computeStats(sessions),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
