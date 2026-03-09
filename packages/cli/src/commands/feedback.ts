import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { apiCall } from "../backend.js";

export function registerFeedback(program: Command): void {
  program
    .command("feedback")
    .description("Send reviewer feedback to an active session and requeue it")
    .argument("<sessionId>", "Session ID")
    .argument("<message...>", "Feedback text")
    .action(async (sessionId: string, message: string[]) => {
      const text = message.join(" ").trim();
      if (!text) {
        console.error(chalk.red("Feedback text is required."));
        process.exit(1);
      }

      const spinner = ora("Submitting feedback").start();
      try {
        await apiCall("POST", `/api/sessions/${encodeURIComponent(sessionId)}/feedback`, {
          message: text,
        });
        spinner.succeed(`Feedback submitted to ${chalk.green(sessionId)}`);
        console.log(chalk.dim("Session moved back to working state for auto-loop."));
      } catch (err) {
        spinner.fail("Failed to submit feedback");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
