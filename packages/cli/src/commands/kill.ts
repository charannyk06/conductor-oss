/**
 * `co kill <session>`
 *
 * Confirms, then kills a session (destroys runtime + workspace).
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createInterface } from "node:readline";
import { createServices, loadConfig } from "../services.js";

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
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);

        // Verify session exists
        const session = await sessionManager.get(sessionId);
        if (!session) {
          console.error(chalk.red(`Session ${sessionId} not found.`));
          process.exit(1);
        }

        // Show what we're about to kill
        console.log(chalk.yellow(`\nAbout to kill session: ${chalk.bold(sessionId)}`));
        if (session.branch) {
          console.log(chalk.dim(`  Branch:    ${session.branch}`));
        }
        if (session.workspacePath) {
          console.log(chalk.dim(`  Worktree:  ${session.workspacePath}`));
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
        await sessionManager.kill(sessionId);
        spinner.succeed(`Session ${chalk.green(sessionId)} killed.`);
      } catch (err) {
        console.error(chalk.red(`Failed to kill session: ${err}`));
        process.exit(1);
      }
    });
}
