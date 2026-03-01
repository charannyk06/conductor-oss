/**
 * `co webhook`
 *
 * Starts the webhook server standalone — useful for testing without the full
 * lifecycle manager and board watcher.
 *
 * Usage:
 *   co webhook [--port 4748]
 */

import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../services.js";

export function registerWebhook(program: Command): void {
  program
    .command("webhook")
    .description("Start webhook server standalone (HTTP + GitHub webhook → kanban task creation)")
    .option("-p, --port <port>", "Port to listen on (default: 4748)")
    .action(async (opts: { port?: string }) => {
      try {
        const config = await loadConfig();
        const port = opts.port
          ? parseInt(opts.port, 10)
          : (config.webhook?.port ?? 4748);

        const { createWebhookServer } = await import(
          "@conductor-oss/plugin-webhook"
        );

        const webhookConfig = {
          enabled: true,
          port,
          secret: config.webhook?.secret,
        };

        const server = createWebhookServer(config, webhookConfig);
        await server.start();

        const line = "=".repeat(50);
        console.log(chalk.dim(line));
        console.log(chalk.bold.cyan("  Conductor Webhook Server"));
        console.log(chalk.dim(line));
        console.log();
        console.log(
          chalk.bold.green(`Webhook server running on http://localhost:${port}`),
        );
        console.log();
        console.log(
          chalk.dim("  POST /api/webhook/task   — create task from any source"),
        );
        console.log(
          chalk.dim("  POST /api/webhook/github — handle GitHub webhook events"),
        );
        console.log(chalk.dim("  GET  /api/webhook/health — health check"));
        console.log(chalk.dim("  GET  /api/webhook/status — stats"));
        console.log();
        console.log(chalk.dim("  Press Ctrl-C to stop.\n"));

        const shutdown = (): void => {
          server.stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        // Keep process alive
        setInterval(() => {}, 60_000);
      } catch (err) {
        console.error(chalk.red(`Failed to start webhook server: ${err}`));
        process.exit(1);
      }
    });
}
