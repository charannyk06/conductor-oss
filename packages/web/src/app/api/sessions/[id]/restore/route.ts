import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SessionNotRestorableError, WorkspaceMissingError } from "@conductor-oss/core/types";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const sessionId = decodeURIComponent(context.params.id ?? "").trim();
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
