import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

/** POST /api/sessions/:id/kill -- Kill a running session. */
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
    await sessionManager.kill(id);
    return NextResponse.json({ ok: true, sessionId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to kill session";
    const lower = msg.toLowerCase();
    const isNotFoundError =
      lower.includes("not found") ||
      lower.includes("enoent") ||
      lower.includes("no such file or directory");
    const status = isNotFoundError ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
