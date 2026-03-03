import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

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
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);
        const manager = sessionManager as unknown as {
          submitFeedback: (sessionId: string, feedback: string) => Promise<void>;
        };
        await manager.submitFeedback(sessionId, text);
        spinner.succeed(`Feedback submitted to ${chalk.green(sessionId)}`);
        console.log(chalk.dim("Session moved back to working state for auto-loop."));
      } catch (err) {
        spinner.fail("Failed to submit feedback");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
