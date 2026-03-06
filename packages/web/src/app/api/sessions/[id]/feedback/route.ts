import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

type FeedbackBody = { message?: string };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const { id } = await context.params;
  const sessionId = decodeURIComponent(id ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as FeedbackBody | null;
  const message = body?.message?.trim();
  if (!message) {
    return NextResponse.json(
      { error: "message is required and must be non-empty" },
      { status: 400 },
    );
  }

  try {
    const { sessionManager } = await getServices();
    await sessionManager.submitFeedback(sessionId, message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to submit review feedback" },
      { status: 500 },
    );
  }
}
