/**
 * `co restore <session>`
 *
 * Restores a dead/exited session by re-launching the agent
 * in the existing worktree.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

export function registerRestore(program: Command): void {
  program
    .command("restore")
    .description("Restore a dead/exited session (re-launch agent)")
    .argument("<session>", "Session ID to restore")
    .action(async (sessionId: string) => {
      const spinner = ora(`Restoring session ${sessionId}`).start();

      try {
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);

        // Verify session exists
        const existing = await sessionManager.get(sessionId);
        if (!existing) {
          spinner.fail(`Session ${chalk.red(sessionId)} not found.`);
          process.exit(1);
        }

        const session = await sessionManager.restore(sessionId);
        spinner.succeed(`Session ${chalk.green(sessionId)} restored.`);

        if (session.workspacePath) {
          console.log(chalk.dim(`  Worktree: ${session.workspacePath}`));
        }
        if (session.branch) {
          console.log(chalk.dim(`  Branch:   ${session.branch}`));
        }

        const tmuxTarget = session.runtimeHandle?.id ?? sessionId;
        console.log(chalk.dim(`  Attach:   tmux attach -t ${tmuxTarget}`));
      } catch (err) {
        spinner.fail("Failed to restore session");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
