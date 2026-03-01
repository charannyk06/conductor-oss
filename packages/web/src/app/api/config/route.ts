import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/config -- Return configured projects and their board paths. */
export async function GET() {
  const denied = await guardApiAccess();
  if (denied) return denied;
  try {
    const { config } = await getServices();
    const projects = Object.entries(config.projects).map(([id, project]) => ({
      id,
      repo: (project as { repo?: string }).repo ?? null,
      boardDir: (project as { boardDir?: string }).boardDir ?? id,
      description: (project as { description?: string }).description ?? null,
      agent: (project as { agent?: string }).agent ?? "claude-code",
    }));
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load config" },
      { status: 500 },
    );
  }
}
