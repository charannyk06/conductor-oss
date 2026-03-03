import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SessionNotRestorableError, WorkspaceMissingError } from "@conductor-oss/core/types";
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
  } catch {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.restore(sessionId);
    return NextResponse.json({ ok: true, sessionId: session.id });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SessionNotRestorableError || err instanceof WorkspaceMissingError) {
      return NextResponse.json(
        { error: err.message },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to restore session" },
      { status: 500 },
    );
  }
}
