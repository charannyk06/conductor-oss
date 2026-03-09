/**
 * `co kill <session>`
 *
 * Confirms, then kills a session (destroys runtime + workspace).
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createInterface } from "node:readline";
import { apiCall, sessionWorktree, type BackendSession } from "../backend.js";

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export function registerKill(program: Command): void {
  program
    .command("kill")
    .description("Kill a session (destroy runtime and workspace)")
    .argument("<session>", "Session ID to kill")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (sessionId: string, opts: { force?: boolean }) => {
      try {
        // Verify session exists
        const session = await apiCall<BackendSession>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);

        // Show what we're about to kill
        console.log(chalk.yellow(`\nAbout to kill session: ${chalk.bold(sessionId)}`));
        if (session.branch) {
          console.log(chalk.dim(`  Branch:    ${session.branch}`));
        }
        const worktree = sessionWorktree(session);
        if (worktree) {
          console.log(chalk.dim(`  Worktree:  ${worktree}`));
        }
        console.log(chalk.dim(`  Status:    ${session.status}`));
        console.log();

        if (!opts.force) {
          const confirmed = await confirm(chalk.yellow("Proceed? (y/N) "));
          if (!confirmed) {
            console.log(chalk.dim("Aborted."));
            return;
          }
        }

        const spinner = ora("Killing session").start();
        await apiCall("POST", `/api/sessions/${encodeURIComponent(sessionId)}/kill`);
        spinner.succeed(`Session ${chalk.green(sessionId)} killed.`);
      } catch (err) {
        console.error(chalk.red(`Failed to kill session: ${err}`));
        process.exit(1);
      }
    });
}
