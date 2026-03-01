/**
 * `co watch`
 *
 * Watches Obsidian CONDUCTOR.md kanban boards for tasks moved to "Ready to Dispatch".
 * When a task is detected, spawns an agent session via `co spawn`.
 *
 * Supports project-specific boards (auto-detected from path) and the workspace-level
 * board (requires #project/ tag on the card).
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

const WORKSPACE = process.env["CONDUCTOR_WORKSPACE"]
  ?? `${process.env["HOME"]}/.conductor/workspace`;

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("Watch Obsidian CONDUCTOR.md boards and auto-dispatch tasks")
    .option("-w, --workspace <path>", "Obsidian workspace path", WORKSPACE)
    .option("--poll <ms>", "Polling interval in milliseconds", "5000")
    .action(async (opts: { workspace: string; poll: string }) => {
      try {
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);
        const core = await import("@conductor-oss/core");

        const spinner = ora("Discovering boards").start();
        const boards = core.discoverBoards(opts.workspace);

        if (boards.length === 0) {
          spinner.fail("No CONDUCTOR.md boards found");
          console.log(chalk.dim(`Searched in: ${opts.workspace}`));
          process.exit(1);
        }

        spinner.succeed(`Found ${boards.length} board(s)`);

        const boardProjectMap = core.buildBoardProjectMap(boards, config);

        // Show board -> project mapping
        for (const board of boards) {
          const project = boardProjectMap.get(board);
          if (project) {
            console.log(chalk.dim(`  ${board} -> ${chalk.cyan(project)}`));
          } else {
            console.log(chalk.dim(`  ${board} -> ${chalk.yellow("workspace (needs #project/ tag)")}`));
          }
        }

        const watcher = core.createBoardWatcher({
          config,
          sessionManager,
          boardPaths: boards,
          boardProjectMap,
          pollIntervalMs: parseInt(opts.poll, 10),
          onDispatch: (projectId, sessionId, task) => {
            console.log(
              chalk.green(`  Dispatched: `) +
                chalk.cyan(sessionId) +
                chalk.dim(` -> ${projectId}: "${task}"`)
            );
          },
          onError: (err, context) => {
            console.error(chalk.red(`  Error [${context}]: ${err.message}`));
          },
        });

        watcher.start();

        console.log();
        console.log(chalk.bold.green("Board watcher running."));
        console.log(chalk.dim("  Move tasks to 'Ready to Dispatch' in Obsidian to auto-spawn agents."));
        console.log(chalk.dim("  Press Ctrl-C to stop.\n"));

        // Graceful shutdown
        const shutdown = (): void => {
          console.log(chalk.dim("\nStopping board watcher..."));
          watcher.stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        // Keep alive
        setInterval(() => {}, 60_000);
      } catch (err) {
        console.error(chalk.red(`Failed to start watcher: ${err}`));
        process.exit(1);
      }
    });
}
