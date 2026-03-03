import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

type SendBody = { message?: string };

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

  const body = (await request.json().catch(() => null)) as SendBody | null;
  if (typeof body?.message !== "string") {
    return NextResponse.json(
      { error: "message is required and must be non-empty" },
      { status: 400 },
    );
  }

  const messageStr = body.message;
  const message = messageStr.trim();
  if (!message) {
    return NextResponse.json(
      { error: "message is required and must be non-empty" },
      { status: 400 },
    );
  }

  try {
    const { sessionManager } = await getServices();
    await sessionManager.send(sessionId, message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send message" },
      { status: 500 },
    );
  }
}
