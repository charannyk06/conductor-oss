import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

type SendBody = { message?: string };

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

  const body = (await request.json().catch(() => null)) as SendBody | null;
  const message = body?.message?.trim();
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
