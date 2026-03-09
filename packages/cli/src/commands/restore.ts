/**
 * `co restore <session>`
 *
 * Restores a dead/exited session by re-launching the agent
 * in the existing worktree.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  apiCall,
  sessionTmuxTarget,
  sessionWorktree,
  type BackendSession,
  type SessionResponse,
} from "../backend.js";

export function registerRestore(program: Command): void {
  program
    .command("restore")
    .description("Restore a dead/exited session (re-launch agent)")
    .argument("<session>", "Session ID to restore")
    .action(async (sessionId: string) => {
      const spinner = ora(`Restoring session ${sessionId}`).start();

      try {
        // Verify session exists
        await apiCall<BackendSession>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);

        const { session } = await apiCall<SessionResponse>(
          "POST",
          `/api/sessions/${encodeURIComponent(sessionId)}/restore`,
        );
        spinner.succeed(`Session ${chalk.green(sessionId)} restored.`);

        const worktree = sessionWorktree(session);
        if (worktree) {
          console.log(chalk.dim(`  Worktree: ${worktree}`));
        }
        if (session.branch) {
          console.log(chalk.dim(`  Branch:   ${session.branch}`));
        }

        const tmuxTarget = sessionTmuxTarget(session);
        console.log(chalk.dim(`  Attach:   tmux attach -t ${tmuxTarget}`));
      } catch (err) {
        spinner.fail("Failed to restore session");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
