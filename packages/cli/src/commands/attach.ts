/**
 * `co attach <session>`
 *
 * Legacy tmux attach command retained only to explain the migration.
 */

import chalk from "chalk";
import type { Command } from "commander";

export function registerAttach(program: Command): void {
  program
    .command("attach")
    .description("Legacy tmux attach is no longer supported")
    .argument("<session>", "Session ID")
    .action(async () => {
      console.error(
        chalk.red(
          "Direct PTY terminals no longer support tmux attach. Open the session in the dashboard terminal instead.",
        ),
      );
      process.exit(1);
    });
}
