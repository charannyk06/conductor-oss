import { type NextRequest, NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { getExecutionBackend } from "@/lib/executionBackend";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  const params = await context.params;
  const rawId = params?.id ?? "";

  let sessionId = "";
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
  const parsedLines = rawLines ? Number.parseInt(rawLines, 10) : 1200;
  const lines = Number.isFinite(parsedLines) && parsedLines > 0 ? Math.min(parsedLines, 5000) : 1200;

  try {
    const payload = await getExecutionBackend().getFeed(sessionId, lines);
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load chat feed";
    const status = message.toLowerCase().includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
