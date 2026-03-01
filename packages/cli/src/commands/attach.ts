/**
 * `co attach <session>`
 *
 * Opens the tmux session in the current terminal via `tmux attach`.
 */

import chalk from "chalk";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

/** Validate tmux target contains only safe characters. */
function assertSafeTarget(target: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(target)) {
    throw new Error(`Invalid tmux target "${target}": must be alphanumeric, dash, or underscore only.`);
  }
}

export function registerAttach(program: Command): void {
  program
    .command("attach")
    .description("Attach to a session's tmux pane in current terminal")
    .argument("<session>", "Session ID to attach to")
    .action(async (sessionId: string) => {
      try {
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);

        const session = await sessionManager.get(sessionId);
        if (!session) {
          console.error(chalk.red(`Session ${sessionId} not found.`));
          process.exit(1);
        }

        const tmuxTarget = session.runtimeHandle?.id ?? sessionId;
        assertSafeTarget(tmuxTarget);

        // Verify tmux session exists before attaching
        try {
          execFileSync("tmux", ["has-session", "-t", tmuxTarget], {
            stdio: "ignore",
          });
        } catch {
          console.error(
            chalk.red(`tmux session ${chalk.bold(tmuxTarget)} does not exist.`),
          );
          console.error(
            chalk.dim("The agent may have exited. Try: co restore " + sessionId),
          );
          process.exit(1);
        }

        console.log(chalk.dim(`Attaching to tmux session: ${tmuxTarget}`));
        console.log(chalk.dim("Detach with Ctrl-b d\n"));

        // Replace the current process with tmux attach.
        // This hands control to tmux and doesn't return.
        execFileSync("tmux", ["attach", "-t", tmuxTarget], {
          stdio: "inherit",
        });
      } catch (err) {
        // execFileSync throws if the child exits non-zero (e.g. user detaches).
        // That's normal -- tmux attach exits 0 on detach but the
        // error might be from something else.
        const code = (err as { status?: number }).status;
        if (code !== undefined && code === 0) return;
        const message = String(err);
        if (!message.includes("SIGINT")) {
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }
    });
}
