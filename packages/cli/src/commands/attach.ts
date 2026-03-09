/**
 * `co attach <session>`
 *
 * Opens the tmux session in the current terminal via `tmux attach`.
 */

import chalk from "chalk";
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { apiCall, sessionTmuxTarget, type BackendSession } from "../backend.js";

/** Validate tmux target contains only safe characters. */
function assertSafeTarget(target: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(target)) {
    throw new Error(`Invalid tmux target "${target}": must be alphanumeric, dash, or underscore only.`);
  }
}

function tmuxSessionExists(target: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", target], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function fallbackTmuxTargets(sessionId: string): string[] {
  return [`conductor-${sessionId}`, sessionId].filter((target, index, values) =>
    /^[a-zA-Z0-9_-]+$/.test(target) && values.indexOf(target) === index,
  );
}

export function registerAttach(program: Command): void {
  program
    .command("attach")
    .description("Attach to a session's tmux pane in current terminal")
    .argument("<session>", "Session ID to attach to")
    .action(async (sessionId: string) => {
      try {
        let tmuxTarget: string | null = null;

        try {
          const session = await apiCall<BackendSession>(
            "GET",
            `/api/sessions/${encodeURIComponent(sessionId)}`,
          );
          const candidate = sessionTmuxTarget(session);
          assertSafeTarget(candidate);
          tmuxTarget = candidate;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("Failed to reach Conductor backend")) {
            throw error;
          }

          tmuxTarget = fallbackTmuxTargets(sessionId).find((candidate) => tmuxSessionExists(candidate)) ?? null;
          if (!tmuxTarget) {
            throw new Error(
              `${message}\nNo matching tmux session was found locally for "${sessionId}". Start the backend with \`co start\` or restore the session first.`,
            );
          }
        }

        if (!tmuxTarget || !tmuxSessionExists(tmuxTarget)) {
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
