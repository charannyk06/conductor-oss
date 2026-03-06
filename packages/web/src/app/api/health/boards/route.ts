import { readFileSync, existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/health/boards -- watcher board parse/health snapshot. */
export async function GET() {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { config } = await getServices();
    const coreModule = await import("@conductor-oss/core");
    const core = coreModule as Record<string, unknown>;
    const discoverBoards = core["discoverBoards"] as
      | ((workspacePath: string, boardPathsOrConfig?: unknown) => string[])
      | undefined;
    const resolveBoardAliasesForPath = core["resolveBoardAliasesForPath"] as
      | ((cfg: unknown, workspacePath: string, boardPath: string) => Record<string, string[]>)
      | undefined;
    const parseBoardStatus = core["parseBoardStatus"] as
      | ((boardPath: string, content: string, aliases: Record<string, string[]>, projectIds: Set<string>) => Record<string, unknown>)
      | undefined;
    const readRecentWatcherActions = core["readRecentWatcherActions"] as
      | ((workspacePath: string, limit?: number) => unknown[])
      | undefined;
    const defaultAliasMapping = core["defaultAliasMapping"] as (() => Record<string, string[]>) | undefined;
    if (!discoverBoards || !parseBoardStatus || !readRecentWatcherActions) {
      throw new Error("Core diagnostics helpers are unavailable. Run pnpm build.");
    }
    const workspace =
      process.env["CONDUCTOR_WORKSPACE"] ?? `${process.env["HOME"]}/.conductor/workspace`;

    const boardPatternsOrConfig = config.boards?.length ? config.boards : config;
    const watchedBoards = discoverBoards(workspace, boardPatternsOrConfig);
    const projectIds = new Set(Object.keys(config.projects));

    const boards = watchedBoards.map((boardPath) => {
      const aliases = resolveBoardAliasesForPath
        ? resolveBoardAliasesForPath(config, workspace, boardPath)
        : (defaultAliasMapping ? defaultAliasMapping() : {});
      if (!existsSync(boardPath)) {
        return {
          boardPath,
          exists: false,
          parseOk: false,
          errors: ["Board file does not exist"],
          aliases,
        };
      }
      const content = readFileSync(boardPath, "utf-8");
      const status = parseBoardStatus(boardPath, content, aliases, projectIds);
      return { ...status, aliases };
    });

    const recentActions = readRecentWatcherActions(workspace, 20);

    return NextResponse.json({
      workspace,
      watchedBoards,
      boards,
      recentActions,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build board health" },
      { status: 500 },
    );
  }
}
