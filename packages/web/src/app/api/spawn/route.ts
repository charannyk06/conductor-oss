import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { sessionToDashboard } from "@/lib/serialize";

/** POST /api/spawn -- Spawn a new agent session. */
export async function POST(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = body.projectId;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    return NextResponse.json(
      { error: "projectId is required and must be a non-empty string" },
      { status: 400 },
    );
  }

  const issueId = body.issueId;
  if (issueId !== undefined && issueId !== null && typeof issueId !== "string") {
    return NextResponse.json(
      { error: "issueId must be a string if provided" },
      { status: 400 },
    );
  }

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.spawn({
      projectId: projectId.trim(),
      issueId: typeof issueId === "string" ? issueId.trim() : undefined,
    });

    return NextResponse.json(
      { session: sessionToDashboard(session) },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
    );
  }
}
