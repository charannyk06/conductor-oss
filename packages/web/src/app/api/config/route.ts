import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const dynamic = "force-dynamic";

function resolveBoardFile(
  workspacePath: string,
  boardDir: string | undefined,
  projectPath: string | undefined,
): string {
  const candidates: string[] = [];

  if (boardDir && boardDir.trim().length > 0) {
    const trimmed = boardDir.trim();
    if (trimmed.endsWith(".md")) {
      candidates.push(trimmed);
      candidates.push(join("projects", trimmed));
    } else {
      candidates.push(join(trimmed, "CONDUCTOR.md"));
      candidates.push(join("projects", trimmed, "CONDUCTOR.md"));
    }
  }

  if (projectPath && projectPath.trim().length > 0) {
    const name = basename(projectPath.trim());
    if (name) {
      candidates.push(join(name, "CONDUCTOR.md"));
      candidates.push(join("projects", name, "CONDUCTOR.md"));
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  for (const rel of uniqueCandidates) {
    if (existsSync(join(workspacePath, rel))) {
      return rel;
    }
  }

  return uniqueCandidates[0] ?? "CONDUCTOR.md";
}

/** GET /api/config -- Return configured projects and their board paths. */
export async function GET() {
  const denied = await guardApiAccess();
  if (denied) return denied;
  try {
    const { config } = await getServices();
    const workspacePath =
      process.env["CONDUCTOR_WORKSPACE"] ??
      dirname(config.configPath) ??
      `${process.env["HOME"]}/.conductor/workspace`;

    const projects = Object.entries(config.projects).map(([id, project]) => {
      const boardDir = (project as { boardDir?: string }).boardDir ?? id;
      return {
        id,
        repo: (project as { repo?: string }).repo ?? null,
        iconUrl: (project as { iconUrl?: string }).iconUrl ?? null,
        boardDir,
        boardFile: resolveBoardFile(
          workspacePath,
          boardDir,
          (project as { path?: string }).path,
        ),
        description: (project as { description?: string }).description ?? null,
        agent: (project as { agent?: string }).agent ?? "claude-code",
      };
    });
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load config" },
      { status: 500 },
    );
  }
}
