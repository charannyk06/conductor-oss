import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../services.js";

interface DoctorOptions {
  workspace?: string;
  json?: boolean;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose board watcher parsing/dispatch issues")
    .option("-w, --workspace <path>", "Workspace path (defaults to CONDUCTOR_WORKSPACE)")
    .option("--json", "Output JSON report")
    .action(async (opts: DoctorOptions) => {
      try {
        const config = await loadConfig(opts.workspace);
        const coreModule = await import("@conductor-oss/core");
        const core = coreModule as Record<string, unknown>;
        const discoverBoards = core["discoverBoards"] as
          | ((workspacePath: string, boardPathsOrConfig?: unknown) => string[])
          | undefined;
        const resolveBoardAliasesForPath = core["resolveBoardAliasesForPath"] as
          | ((cfg: unknown, workspacePath: string, boardPath: string) => Record<string, string[]>)
          | undefined;
        const parseBoardStatus = core["parseBoardStatus"] as
          | ((boardPath: string, content: string, aliases: Record<string, string[]>, projectIds: Set<string>) => {
              unresolvedProjects: string[];
              errors: string[];
              readyCount: number;
              parseOk: boolean;
            } & Record<string, unknown>)
          | undefined;
        const readRecentWatcherActions = core["readRecentWatcherActions"] as
          | ((workspacePath: string, limit?: number) => Array<{ ts: string; level: string; action: string; boardPath?: string }>)
          | undefined;
        const defaultAliasMapping = core["defaultAliasMapping"] as (() => Record<string, string[]>) | undefined;
        if (!discoverBoards || !parseBoardStatus || !readRecentWatcherActions) {
          throw new Error("Core diagnostics helpers are unavailable. Run pnpm build.");
        }
        const workspace = opts.workspace
          ?? process.env["CONDUCTOR_WORKSPACE"]
          ?? `${process.env["HOME"]}/.conductor/workspace`;

        const boardPatternsOrConfig = config.boards?.length ? config.boards : config;
        const boards = discoverBoards(workspace, boardPatternsOrConfig);
        const projectIds = new Set(Object.keys(config.projects));

        const aliasMapping: Record<string, Record<string, string[]>> = {};
        const boardStatus: Array<Record<string, unknown> & { unresolvedProjects: string[]; errors: string[]; readyCount: number; parseOk: boolean; boardPath: string }> = [];
        const unresolvedProjectTags: Array<{ boardPath: string; tag: string }> = [];

        for (const boardPath of boards) {
          const aliases = resolveBoardAliasesForPath
            ? resolveBoardAliasesForPath(config, workspace, boardPath)
            : (defaultAliasMapping ? defaultAliasMapping() : {});
          aliasMapping[boardPath] = aliases;

          if (!existsSync(boardPath)) {
            boardStatus.push({
              boardPath,
              exists: false,
              parseOk: false,
              headingCount: 0,
              headings: [],
              columns: {},
              readyCount: 0,
              unresolvedProjects: [],
              errors: ["Board file does not exist"],
            });
            continue;
          }

          const content = readFileSync(boardPath, "utf-8");
          const status = parseBoardStatus(boardPath, content, aliases, projectIds) as {
            boardPath: string;
            unresolvedProjects: string[];
            errors: string[];
            readyCount: number;
            parseOk: boolean;
          } & Record<string, unknown>;
          boardStatus.push(status);
          for (const tag of status.unresolvedProjects) {
            unresolvedProjectTags.push({ boardPath, tag });
          }
        }

        const recentActions = readRecentWatcherActions(workspace, 20);

        const hints: string[] = [];
        if (boards.length === 0) {
          hints.push("No boards discovered. Add explicit boards: entries or verify workspace path.");
        }
        if (unresolvedProjectTags.length > 0) {
          hints.push("Some #project/<id> tags do not exist in conductor.yaml projects.");
        }
        for (const status of boardStatus) {
          for (const error of status.errors) {
            hints.push(`${status.boardPath}: ${error}`);
          }
        }
        if (recentActions.length === 0) {
          hints.push("No watcher actions logged yet. Start `co watch` or `co start` and retry.");
        }

        const report = {
          watchedBoards: boards,
          aliasMapping,
          boardStatus,
          unresolvedProjectTags,
          recentActions,
          hints,
        };

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log(chalk.bold("Conductor Doctor"));
        console.log(chalk.dim(`Workspace: ${workspace}`));
        console.log();

        console.log(chalk.bold("Watched Boards"));
        if (boards.length === 0) {
          console.log(chalk.yellow("  none"));
        } else {
          for (const board of boards) {
            console.log(`  ${chalk.cyan(board)}`);
          }
        }

        console.log();
        console.log(chalk.bold("Board Parse Status"));
        for (const status of boardStatus) {
          const label = status.parseOk ? chalk.green("ok") : chalk.red("error");
          console.log(`  ${label} ${chalk.cyan(status.boardPath)} ready=${status.readyCount}`);
          if (status.errors.length > 0) {
            for (const error of status.errors) {
              console.log(`    ${chalk.red("- "+error)}`);
            }
          }
          if (status.unresolvedProjects.length > 0) {
            console.log(`    ${chalk.yellow("unresolved projects:")} ${status.unresolvedProjects.join(", ")}`);
          }
        }

        console.log();
        console.log(chalk.bold("Recent Watcher Actions"));
        if (recentActions.length === 0) {
          console.log(chalk.yellow("  none"));
        } else {
          for (const action of recentActions) {
            const lvl = action.level === "error" ? chalk.red(action.level) : action.level === "debug" ? chalk.dim(action.level) : chalk.green(action.level);
            const board = action.boardPath ? ` ${chalk.cyan(action.boardPath)}` : "";
            console.log(`  ${chalk.dim(action.ts)} ${lvl}${board} ${action.action}`);
          }
        }

        console.log();
        console.log(chalk.bold("Fix Hints"));
        if (hints.length === 0) {
          console.log(chalk.green("  No issues detected."));
        } else {
          for (const hint of hints) {
            console.log(`  ${chalk.yellow("-")} ${hint}`);
          }
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
