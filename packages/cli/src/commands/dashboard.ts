/**
 * `co dashboard`
 *
 * Opens the Conductor web dashboard in the default browser.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";

function commandExists(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function resolveBrowserOpenCommand(): { command: string; argsPrefix: string[] } | null {
  if (process.platform === "darwin") {
    return {
      command: existsSync("/usr/bin/open") ? "/usr/bin/open" : "open",
      argsPrefix: [],
    };
  }

  if (process.platform === "win32") {
    return {
      command: "cmd",
      argsPrefix: ["/c", "start", ""],
    };
  }

  if (existsSync("/usr/bin/xdg-open")) {
    return {
      command: "/usr/bin/xdg-open",
      argsPrefix: [],
    };
  }

  if (commandExists("xdg-open")) {
    return {
      command: "xdg-open",
      argsPrefix: [],
    };
  }

  return null;
}

function parsePort(value: string, label: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port number. Must be 1-65535.`);
  }
  return port;
}

async function isDashboardReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveConfiguredDashboardPort(): Promise<number | null> {
  try {
    const core = await import("@conductor-oss/core");
    if (typeof core.loadConfig !== "function") {
      return null;
    }

    const config = await core.loadConfig();
    const configuredPort = (config as { port?: number | string | null }).port;
    if (configuredPort == null) {
      return null;
    }

    return parsePort(String(configuredPort), "dashboard");
  } catch {
    return null;
  }
}

async function resolveDashboardUrl(explicitPort?: string): Promise<string> {
  if (explicitPort?.trim()) {
    return `http://localhost:${parsePort(explicitPort.trim(), "dashboard")}`;
  }

  const envPort = process.env["PORT"]?.trim();
  let envCandidate: number | null = null;
  if (envPort) {
    try {
      envCandidate = parsePort(envPort, "dashboard");
    } catch {
      envCandidate = null;
    }
  }

  const configuredPort = await resolveConfiguredDashboardPort();
  const candidates = [
    envCandidate,
    configuredPort,
    4747,
    3000,
  ].filter((value, index, values): value is number => value !== null && values.indexOf(value) === index);

  for (const candidate of candidates) {
    if (await isDashboardReachable(candidate)) {
      return `http://localhost:${candidate}`;
    }
  }

  return `http://localhost:${candidates[0] ?? 4747}`;
}

function openDashboardInBrowser(url: string): boolean {
  const opener = resolveBrowserOpenCommand();
  if (!opener) {
    console.log(chalk.yellow(`Could not find a browser opener. Open ${url} manually.`));
    return false;
  }

  const child = spawn(opener.command, [...opener.argsPrefix, url], {
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {
    console.error(chalk.yellow("Could not open browser automatically."));
    console.log(chalk.dim(`Open manually: ${url}`));
  });
  return true;
}

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Open the Conductor web dashboard in a browser")
    .option("-p, --port <port>", "Dashboard port override")
    .action(async (opts: { port?: string }) => {
      try {
        const url = await resolveDashboardUrl(opts.port);
        console.log(chalk.bold(`Opening dashboard: ${chalk.cyan(url)}`));
        openDashboardInBrowser(url);
      } catch (err) {
        console.error(chalk.red(`Error: ${err}`));
        console.log(chalk.dim("Is the dashboard running? Try: co start"));
        process.exit(1);
      }
    });
}
