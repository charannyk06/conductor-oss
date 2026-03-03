import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess();
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

  const searchParams = new URL(request.url).searchParams;
  const rawLines = searchParams.get("lines");
  const parsedLines = rawLines ? Number.parseInt(rawLines, 10) : 500;
  const lines = Number.isFinite(parsedLines) && parsedLines > 0 ? Math.min(parsedLines, 5000) : 500;

  try {
    const { sessionManager } = await getServices();
    const output = await sessionManager.getOutput(sessionId, lines);
    return NextResponse.json({ output });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load output";
    const status = message.toLowerCase().includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
