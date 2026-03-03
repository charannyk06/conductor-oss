import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { sessionToDashboard } from "@/lib/serialize";

/** POST /api/sessions/:id/restore -- Restore a dead/killed session. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const { id } = await params;

  if (!id || id.trim().length === 0) {
    return NextResponse.json({ error: "Session ID is required" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const restored = await sessionManager.restore(id);
    return NextResponse.json({
      ok: true,
      sessionId: id,
      session: sessionToDashboard(restored),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to restore session";
    const status = msg.includes("not found")
      ? 404
      : msg.includes("not restorable") || msg.includes("Cannot restore")
        ? 409
        : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
