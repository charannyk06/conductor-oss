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

  const prompt = body.prompt;
  if (prompt !== undefined && prompt !== null && typeof prompt !== "string") {
    return NextResponse.json(
      { error: "prompt must be a string if provided" },
      { status: 400 },
    );
  }

  const agent = body.agent;
  if (agent !== undefined && agent !== null && typeof agent !== "string") {
    return NextResponse.json(
      { error: "agent must be a string if provided" },
      { status: 400 },
    );
  }

  const model = body.model;
  if (model !== undefined && model !== null && typeof model !== "string") {
    return NextResponse.json(
      { error: "model must be a string if provided" },
      { status: 400 },
    );
  }

  const profile = body.profile;
  if (profile !== undefined && profile !== null && typeof profile !== "string") {
    return NextResponse.json(
      { error: "profile must be a string if provided" },
      { status: 400 },
    );
  }

  const branch = body.branch;
  if (branch !== undefined && branch !== null && typeof branch !== "string") {
    return NextResponse.json(
      { error: "branch must be a string if provided" },
      { status: 400 },
    );
  }

  const baseBranch = body.baseBranch;
  if (baseBranch !== undefined && baseBranch !== null && typeof baseBranch !== "string") {
    return NextResponse.json(
      { error: "baseBranch must be a string if provided" },
      { status: 400 },
    );
  }

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.spawn({
      projectId: projectId.trim(),
      issueId: typeof issueId === "string" ? issueId.trim() : undefined,
      prompt: typeof prompt === "string" && prompt.trim().length > 0 ? prompt.trim() : undefined,
      agent: typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined,
      model: typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined,
      profile: typeof profile === "string" && profile.trim().length > 0 ? profile.trim() : undefined,
      branch: typeof branch === "string" && branch.trim().length > 0 ? branch.trim() : undefined,
      baseBranch: typeof baseBranch === "string" && baseBranch.trim().length > 0
        ? baseBranch.trim()
        : undefined,
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
