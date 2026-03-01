/**
 * `co send <session> <message>`
 *
 * Sends a message to a running agent session via the session manager.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

export function registerSend(program: Command): void {
  program
    .command("send")
    .description("Send a message to a running agent session")
    .argument("<session>", "Session ID")
    .argument("<message...>", "Message to send to the agent")
    .action(async (sessionId: string, messageParts: string[]) => {
      const message = messageParts.join(" ");

      if (!message.trim()) {
        console.error(chalk.red("Empty message. Provide text to send."));
        process.exit(1);
      }

      const spinner = ora(`Sending message to ${sessionId}`).start();

      try {
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);

        // Verify session exists
        const session = await sessionManager.get(sessionId);
        if (!session) {
          spinner.fail(`Session ${chalk.red(sessionId)} not found`);
          process.exit(1);
        }

        await sessionManager.send(sessionId, message);
        spinner.succeed(`Message sent to ${chalk.green(sessionId)}`);
        console.log(chalk.dim(`  > ${message.length > 80 ? message.slice(0, 79) + "\u2026" : message}`));
      } catch (err) {
        spinner.fail("Failed to send message");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
