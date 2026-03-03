/**
 * `co start`
 *
 * Starts the lifecycle manager and web dashboard.
 * Runs in the foreground -- designed for LaunchAgent / systemd usage.
 *
 * The lifecycle manager polls sessions periodically, advancing their
 * state machine (checking CI, reviews, merging, sending reactions, etc.).
 * The web dashboard provides a browser UI for monitoring and interaction.
 */

import { spawn, type ChildProcess } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start lifecycle manager + board watcher + web dashboard (foreground)")
    .option("--no-dashboard", "Skip starting the web dashboard")
    .option("--no-watcher", "Skip starting the board watcher")
    .option("-p, --port <port>", "Dashboard port override")
    .option("-w, --workspace <path>", "Obsidian workspace path")
    .action(async (opts: { dashboard?: boolean; watcher?: boolean; port?: string; workspace?: string }) => {
      try {
        const config = await loadConfig();

        // Mutable ref — set after boardWatcher is created, used by lifecycle callback
        let boardWatcherRef: { updateNow(): void } | null = null;
        const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);
        const shutdownTasks: Array<() => void | Promise<void>> = [];
        let isShuttingDown = false;

        const requestShutdown = (): void => {
          void (async () => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            for (const task of shutdownTasks) {
              try {
                await task();
              } catch (err) {
                console.error(err);
              }
            }
            process.exit(0);
          })();
        };

        process.on("SIGINT", requestShutdown);
        process.on("SIGTERM", requestShutdown);

        const line = "=".repeat(50);
        console.log(chalk.dim(line));
        console.log(chalk.bold.cyan("  Conductor -- Starting"));
        console.log(chalk.dim(line));
        console.log();

        // ---- Start lifecycle manager ----
        const spinner = ora("Starting lifecycle manager").start();
        const core = await import("@conductor-oss/core");

        if (typeof core.createLifecycleManager !== "function") {
          spinner.warn("Lifecycle manager not yet implemented in @conductor-oss/core");
        } else {
          const { sessionManager } = await createServices(config);
          const lifecycle = core.createLifecycleManager({
            config,
            sessionManager,
            onStatusChange: (sessionId, newStatus, projectId) => {
              console.log(`[lifecycle] Status change: ${sessionId} → ${newStatus} (${projectId})`);
              // Trigger immediate board sync
              boardWatcherRef?.updateNow();
            },
          });
          lifecycle.start(10_000); // Poll every 10s (was 30s)
          spinner.succeed("Lifecycle manager running");

          // Graceful shutdown
          shutdownTasks.push(() => {
            console.log(chalk.dim("\nShutting down lifecycle manager..."));
            lifecycle.stop();
          });
        }

        // ---- Start board watcher ----
        if (opts.watcher !== false) {
          const watchSpinner = ora("Starting board watcher").start();
          try {
            const workspacePath = opts.workspace
              ?? process.env["CONDUCTOR_WORKSPACE"]
              ?? `${process.env["HOME"]}/.conductor/workspace`;
            const boards = core.discoverBoards(workspacePath, config.boards);
            if (boards.length === 0) {
              watchSpinner.warn("No CONDUCTOR.md boards found");
            } else {
              // Need sessionManager for the watcher
              const { sessionManager: sm } = await createServices(config);

              const boardProjectMap = core.buildBoardProjectMap(boards, config);
              const boardWatcher = core.createBoardWatcher({
                config,
                sessionManager: sm,
                boardPaths: boards,
                boardProjectMap,
                pollIntervalMs: 5000,
                workspacePath,
                onDispatch: (projectId, sessionId, task) => {
                  console.log(`[board-watcher] Dispatched ${sessionId} -> ${projectId}: "${task}"`);
                },
              });
              boardWatcher.start();
              boardWatcherRef = boardWatcher;
              shutdownTasks.push(() => boardWatcher.stop());
              watchSpinner.succeed(`Board watcher running (${boards.length} boards)`);
            }
          } catch (err) {
            watchSpinner.warn(`Board watcher failed: ${err}`);
          }
        }

        // ---- Start web dashboard ----
        let dashboardProcess: ChildProcess | null = null;

        if (opts.dashboard !== false) {
          const dashSpinner = ora("Starting web dashboard").start();

          try {
            const cliDir = new URL(".", import.meta.url).pathname;
            const { join, resolve } = await import("node:path");
            const { existsSync } = await import("node:fs");

            // Search order:
            // 1. Standalone build inside CLI package (npm install -g)
            // 2. Sibling packages/web in monorepo dev setup
            // 3. config.configPath-relative monorepo root
            let webDir: string | null = null;

            const candidates = [
              resolve(cliDir, "..", "web"),                               // npm: cli/dist/../web
              resolve(cliDir, "..", "..", "..", "web"),                   // npm: cli/dist/../../web
              resolve(cliDir, "..", "..", "web"),                         // monorepo: packages/cli/dist/../../web = packages/web
              config.configPath ? resolve(config.configPath, "..", "packages", "web") : null,
            ].filter(Boolean) as string[];

            for (const candidate of candidates) {
              if (existsSync(join(candidate, "package.json"))) {
                webDir = candidate;
                break;
              }
            }

            if (!webDir) {
              dashSpinner.warn("Dashboard not found. Run: pnpm --filter @conductor-oss/web build");
              return;
            }

            // Prefer standalone build (output: standalone in next.config), then production, then dev
            // Find standalone server.js (location varies by monorepo nesting)
            const { readdirSync, statSync: fsStat } = await import("node:fs");
            const standaloneDir = join(webDir, ".next", "standalone");
            let standaloneServer: string | null = null;
            const searchQueue = [standaloneDir];
            for (let depth = 0; depth < 6 && searchQueue.length > 0 && !standaloneServer; depth++) {
              const nextQueue: string[] = [];
              for (const d of searchQueue) {
                const candidate = join(d, "server.js");
                if (existsSync(candidate) && !candidate.includes("node_modules")) {
                  standaloneServer = candidate;
                  break;
                }
                try {
                  for (const entry of readdirSync(d)) {
                    const full = join(d, String(entry));
                    if (fsStat(full).isDirectory() && entry !== "node_modules") {
                      nextQueue.push(full);
                    }
                  }
                } catch { /* ignore */ }
              }
              searchQueue.splice(0, searchQueue.length, ...nextQueue);
            }
            const hasNextBuild = existsSync(join(webDir, ".next"));

            let cmd: string;
            let args: string[];

            if (hasNextBuild) {
              // Use pnpm run start (next start) — reliable, serves static assets correctly
              cmd = "pnpm";
              args = [
                "run",
                "start",
                "--",
                "--hostname",
                "0.0.0.0",
                "--port",
                String(port),
              ];
            } else {
              cmd = "pnpm";
              args = [
                "run",
                "dev",
                "--",
                "--hostname",
                "0.0.0.0",
                "--port",
                String(port),
              ];
            }

            dashboardProcess = spawn(cmd, args, {
              cwd: webDir,
              stdio: "inherit",
              detached: false,
              env: {
                ...process.env,
                PORT: String(port),
                HOSTNAME: "0.0.0.0",
              },
            });

            dashboardProcess.on("error", () => {
              dashSpinner.warn("Dashboard failed to start. Try: cd packages/web && pnpm build");
            });

            dashSpinner.succeed(`Web dashboard starting on http://localhost:${port}`);
          } catch {
            dashSpinner.warn("Could not start dashboard.");
          }
        }

        // ---- Start webhook server (if enabled in config) ----
        if (config.webhook?.enabled) {
          const webhookSpinner = ora("Starting webhook server").start();
          try {
            const { createWebhookServer } = await import(
              "@conductor-oss/plugin-webhook"
            );
            const webhookServer = createWebhookServer(config, config.webhook);
            await webhookServer.start();
            shutdownTasks.push(() => webhookServer.stop());
            webhookSpinner.succeed(
              `Webhook server running on port ${config.webhook.port}`,
            );
          } catch (err) {
            webhookSpinner.warn(`Webhook server failed to start: ${err}`);
          }
        }

        // ---- Summary ----
        console.log();
        console.log(chalk.bold.green("Conductor is running."));
        console.log(chalk.dim(`  Config:    ${config.configPath}`));
        if (opts.dashboard !== false) {
          console.log(chalk.dim(`  Dashboard: http://localhost:${port}`));
        }
        if (opts.watcher !== false) {
          console.log(chalk.dim("  Watcher:   Obsidian CONDUCTOR.md boards"));
        }
        if (config.webhook?.enabled) {
          console.log(
            chalk.dim(
              `  Webhook:   http://localhost:${config.webhook.port}/api/webhook`,
            ),
          );
        }
        console.log(chalk.dim("  Press Ctrl-C to stop.\n"));

        // Keep process alive. Dashboard is optional for orchestrator health.
        // If it crashes (e.g. EADDRINUSE), keep lifecycle + board watcher running.
        if (dashboardProcess) {
          dashboardProcess.on("exit", (code, signal) => {
            if (code !== 0 && code !== null) {
              console.error(
                chalk.yellow(
                  `Dashboard exited with code ${code}${signal ? ` (signal ${signal})` : ""}. ` +
                  "Keeping orchestrator core services running.",
                ),
              );
            }
          });
        }

        // Always keep process alive via interval heartbeat.
        setInterval(() => {
          // heartbeat -- lifecycle manager / watcher run on their own intervals
        }, 60_000);
      } catch (err) {
        console.error(chalk.red(`Failed to start: ${err}`));
        process.exit(1);
      }
    });
}
