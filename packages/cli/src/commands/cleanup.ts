/**
 * `co cleanup [project]`
 *
 * Kills all sessions that are in a terminal state (merged, done, killed, etc.).
 * Reclaims worktrees and tmux sessions.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

export function registerCleanup(program: Command): void {
  program
    .command("cleanup")
    .description("Kill all completed/merged sessions and reclaim resources")
    .argument("[project]", "Filter by project ID")
    .option("--dry-run", "Show what would be cleaned without doing it")
    .action(async (project: string | undefined, opts: { dryRun?: boolean }) => {
      try {
        const config = await loadConfig();

        if (project && !config.projects[project]) {
          console.error(
            chalk.red(`Unknown project: ${project}\nAvailable: ${Object.keys(config.projects).join(", ")}`),
          );
          process.exit(1);
        }

        const { sessionManager } = await createServices(config);

        if (opts.dryRun) {
          console.log(chalk.bold("Dry run -- checking for cleanable sessions...\n"));
        }

        const spinner = opts.dryRun ? null : ora("Cleaning up sessions").start();

        const result = await sessionManager.cleanup(project, { dryRun: Boolean(opts.dryRun) });

        spinner?.stop();

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("No sessions to clean up."));
          return;
        }

        if (result.killed.length > 0) {
          for (const id of result.killed) {
            if (opts.dryRun) {
              console.log(chalk.yellow(`  Would clean: ${id}`));
            } else {
              console.log(chalk.green(`  Cleaned: ${id}`));
            }
          }
        }

        if (result.skipped.length > 0) {
          for (const id of result.skipped) {
            console.log(chalk.dim(`  Skipped: ${id}`));
          }
        }

        if (result.errors.length > 0) {
          for (const { sessionId, error } of result.errors) {
            console.error(chalk.red(`  Error (${sessionId}): ${error}`));
          }
        }

        console.log();
        if (opts.dryRun) {
          console.log(
            chalk.dim(
              `${result.killed.length} session${result.killed.length !== 1 ? "s" : ""} would be cleaned.`,
            ),
          );
        } else {
          console.log(
            chalk.green(
              `Cleanup complete. ${result.killed.length} session${result.killed.length !== 1 ? "s" : ""} cleaned.`,
            ),
          );
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err}`));
        process.exit(1);
      }
    });
}
