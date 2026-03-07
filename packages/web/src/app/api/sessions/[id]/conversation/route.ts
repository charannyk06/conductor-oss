import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

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
    const entries = await sessionManager.getConversation(sessionId);
    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load conversation" },
      { status: 500 },
    );
  }
}
