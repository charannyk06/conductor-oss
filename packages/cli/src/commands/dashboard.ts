/**
 * `co dashboard`
 *
 * Opens the Conductor web dashboard in the default browser.
 */

import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../services.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Open the Conductor web dashboard in a browser")
    .option("-p, --port <port>", "Dashboard port (default: from config or 3000)")
    .action(async (opts: { port?: string }) => {
      try {
        const config = await loadConfig();
        const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);

        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("Invalid port number. Must be 1-65535."));
          process.exit(1);
        }

        const url = `http://localhost:${port}`;
        console.log(chalk.bold(`Opening dashboard: ${chalk.cyan(url)}`));

        // Open in default browser (macOS: open, Linux: xdg-open)
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        const child = spawn(opener, [url], { stdio: "ignore", detached: true });
        child.unref();

        child.on("error", () => {
          console.error(chalk.yellow(`Could not open browser automatically.`));
          console.log(chalk.dim(`Open manually: ${url}`));
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${err}`));
        console.log(chalk.dim("Is the dashboard running? Try: co start"));
        process.exit(1);
      }
    });
}
