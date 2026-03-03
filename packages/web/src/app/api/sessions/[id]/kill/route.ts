import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const params = await context.params;
  const rawId = params?.id ?? "";
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId).trim();
  } catch (error) {
    return NextResponse.json({ error: "Malformed session id" }, { status: 400 });
  }
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    await sessionManager.kill(sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.toLowerCase().includes("not found")
    ) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Session not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to kill session" },
      { status: 500 },
    );
  }
}
