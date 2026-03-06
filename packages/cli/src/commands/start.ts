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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { buildConductorBoard, buildConductorYaml } from "@conductor-oss/core";
import { createServices, loadConfig } from "../services.js";

function openDashboardInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.unref();
  child.on("error", () => {
    console.log(chalk.yellow(`Could not open browser automatically. Open ${url} manually.`));
  });
}

async function waitForDashboard(url: string, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // Dashboard is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

function getDefaultLauncherWorkspace(): string {
  return resolve(homedir(), ".openclaw", "workspace");
}

function ensureDashboardBootstrapWorkspace(): { workspacePath: string; configPath: string } {
  const workspacePath = getDefaultLauncherWorkspace();
  const configPath = join(workspacePath, "conductor.yaml");
  const boardPath = join(workspacePath, "CONDUCTOR.md");

  mkdirSync(workspacePath, { recursive: true });

  if (!existsSync(configPath)) {
    writeFileSync(configPath, buildConductorYaml({
      preferences: {
        onboardingAcknowledged: false,
        codingAgent: "claude-code",
        ide: "vscode",
        markdownEditor: "obsidian",
      },
      projects: [],
    }), "utf8");
  }

  if (!existsSync(boardPath)) {
    writeFileSync(boardPath, buildConductorBoard("home", "Conductor Home"), "utf8");
  }

  return { workspacePath, configPath };
}

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start lifecycle manager + board watcher + web dashboard (foreground)")
    .option("--no-dashboard", "Skip starting the web dashboard")
    .option("--no-watcher", "Skip starting the board watcher")
    .option("--open", "Open the dashboard in your default browser")
    .option("-p, --port <port>", "Dashboard port override")
    .option("-w, --workspace <path>", "Obsidian workspace path")
      .action(async (opts: { dashboard?: boolean; watcher?: boolean; open?: boolean; port?: string; workspace?: string }) => {
      try {
        const explicitWorkspaceHint = opts.workspace ?? process.env["CONDUCTOR_WORKSPACE"];
        let config;
        if (explicitWorkspaceHint) {
          config = await loadConfig(explicitWorkspaceHint);
        } else {
          try {
            config = await loadConfig();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/No conductor\.ya?ml found/i.test(message)) {
              throw err;
            }

            const bootstrap = ensureDashboardBootstrapWorkspace();
            process.env["CONDUCTOR_WORKSPACE"] = bootstrap.workspacePath;
            process.env["CO_CONFIG_PATH"] = bootstrap.configPath;
            config = await loadConfig(bootstrap.workspacePath);
          }
        }

        const workspacePath = opts.workspace
          ?? process.env["CONDUCTOR_WORKSPACE"]
          ?? (config.configPath ? dirname(config.configPath) : `${process.env["HOME"]}/.conductor/workspace`);
        if (!process.env["CONDUCTOR_WORKSPACE"]) {
          process.env["CONDUCTOR_WORKSPACE"] = workspacePath;
        }
        if (!process.env["CO_CONFIG_PATH"] && config.configPath) {
          process.env["CO_CONFIG_PATH"] = config.configPath;
        }

        const { sessionManager, registry } = await createServices(config);
        const supportedAgents = registry.list("agent").map((agent) => agent.name);

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
        core.syncWorkspaceSupportFiles(config, {
          workspacePath,
          agentNames: supportedAgents,
        });

        if (typeof core.createLifecycleManager !== "function") {
          spinner.warn("Lifecycle manager not yet implemented in @conductor-oss/core");
        } else {
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
            const boardPatternsOrConfig = config.boards?.length ? config.boards : config;
            const boards = core.discoverBoards(workspacePath, boardPatternsOrConfig);
            if (boards.length === 0) {
              watchSpinner.warn("No CONDUCTOR.md boards found");
            } else {
              const boardProjectMap = core.buildBoardProjectMap(boards, config);
              const boardWatcher = core.createBoardWatcher({
                config,
                sessionManager,
                agentNames: supportedAgents,
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
            const { dirname, join, resolve } = await import("node:path");
            const { cpSync, existsSync, mkdirSync } = await import("node:fs");

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

            // Kill any stale process holding the dashboard port (prevents EADDRINUSE on restart)
            try {
              const { execSync } = await import("node:child_process");
              const pids = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf8" }).trim();
              if (pids) {
                for (const pid of pids.split("\n").filter(Boolean)) {
                  if (pid !== String(process.pid)) {
                    process.kill(Number(pid), "SIGTERM");
                    console.log(`[dashboard] Killed stale process ${pid} on port ${port}`);
                  }
                }
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch { /* no stale process — expected */ }

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
                if (existsSync(candidate)) {
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
            let dashboardCwd = webDir;

            if (standaloneServer) {
              const standaloneAppDir = dirname(standaloneServer);
              const standaloneStaticDir = join(standaloneAppDir, ".next", "static");
              const sourceStaticDir = join(webDir, ".next", "static");
              if (!existsSync(standaloneStaticDir) && existsSync(sourceStaticDir)) {
                mkdirSync(join(standaloneAppDir, ".next"), { recursive: true });
                cpSync(sourceStaticDir, standaloneStaticDir, { recursive: true });
              }

              cmd = process.execPath;
              args = [standaloneServer];
              dashboardCwd = standaloneDir;
            } else if (hasNextBuild) {
              // Use pnpm run start (next start) — reliable, serves static assets correctly
              cmd = "pnpm";
              args = [
                "run",
                "start",
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
                "--hostname",
                "0.0.0.0",
                "--port",
                String(port),
              ];
            }

            dashboardProcess = spawn(cmd, args, {
              cwd: dashboardCwd,
              stdio: "inherit",
              detached: false,
              env: {
                ...process.env,
                PORT: String(port),
                HOSTNAME: "0.0.0.0",
                CONDUCTOR_WORKSPACE: workspacePath,
                CO_CONFIG_PATH: config.configPath,
              },
            });

            dashboardProcess.on("error", () => {
              dashSpinner.warn("Dashboard failed to start. Try: cd packages/web && pnpm build");
            });

            const dashboardUrl = `http://localhost:${port}`;
            dashSpinner.succeed(`Web dashboard starting on ${dashboardUrl}`);
            if (opts.open) {
              void waitForDashboard(`${dashboardUrl}/api/config`).then((ready) => {
                if (ready) {
                  openDashboardInBrowser(dashboardUrl);
                  return;
                }

                console.log(chalk.yellow(`Dashboard is still starting. Open ${dashboardUrl} manually if it does not open shortly.`));
              });
            }
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
