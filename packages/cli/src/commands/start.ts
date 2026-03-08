/**
 * `co start`
 *
 * Starts the Rust backend and web dashboard in the foreground.
 * The JS launcher is intentionally thin: it resolves paths, launches
 * the Rust backend, and wires the frontend to it.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { buildConductorBoard, buildConductorYaml } from "@conductor-oss/core";

function commandExists(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]";
}

export function buildRemoteUnlockUrl(baseUrl: string, accessToken: string): string {
  const unlockUrl = new URL("/auth/grant", baseUrl);
  unlockUrl.searchParams.set("token", accessToken);
  return unlockUrl.toString();
}

type BuiltinRemoteAuth = {
  accessToken: string;
  sessionSecret: string;
};

type TrustedHeaderAuth = {
  enabled: boolean;
  provider: "generic" | "cloudflare-access";
  emailHeader: string;
  jwtHeader: string;
  teamDomain: string | null;
  audience: string | null;
};

type LauncherAccessConfig = {
  requireAuth: boolean;
  defaultRole: string | null;
  trustedHeaders: TrustedHeaderAuth;
};

type LauncherSettings = {
  workspacePath: string;
  configPath: string;
  dashboardPort: number;
  backendPort: number;
  access: LauncherAccessConfig;
};

type RustLaunchConfig = {
  cmd: string;
  args: string[];
  cwd: string;
  label: string;
};

function resolveBuiltinRemoteAuth(enabled: boolean): BuiltinRemoteAuth | null {
  if (!enabled) return null;

  const accessToken = process.env["CONDUCTOR_REMOTE_ACCESS_TOKEN"]?.trim()
    || randomBytes(24).toString("base64url");
  const sessionSecret = process.env["CONDUCTOR_REMOTE_SESSION_SECRET"]?.trim()
    || randomBytes(32).toString("base64url");

  return {
    accessToken,
    sessionSecret,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function coercePort(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  return fallback;
}

function resolveTrustedHeaderAuth(config: Record<string, unknown>): TrustedHeaderAuth {
  const access = asObject(config["access"]);
  const trustedHeaders = asObject(access["trustedHeaders"]);
  return {
    enabled: asBoolean(trustedHeaders["enabled"]),
    provider: trustedHeaders["provider"] === "generic" ? "generic" : "cloudflare-access",
    emailHeader: asTrimmedString(trustedHeaders["emailHeader"]) || "Cf-Access-Authenticated-User-Email",
    jwtHeader: asTrimmedString(trustedHeaders["jwtHeader"]) || "Cf-Access-Jwt-Assertion",
    teamDomain: asTrimmedString(trustedHeaders["teamDomain"]),
    audience: asTrimmedString(trustedHeaders["audience"]),
  };
}

export function extractCloudflareTunnelUrl(output: string): string | null {
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0] ?? null;
}

function startCloudflareQuickTunnel(localUrl: string): {
  process: ChildProcess;
  url: Promise<string>;
} {
  const tunnelProcess = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", localUrl],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    },
  );

  const url = new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error("Timed out waiting for Cloudflare Quick Tunnel URL"));
    }, 30_000);

    const handleOutput = (chunk: Buffer | string) => {
      if (settled) return;
      const nextUrl = extractCloudflareTunnelUrl(chunk.toString());
      if (!nextUrl) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(nextUrl);
    };

    tunnelProcess.stdout?.on("data", handleOutput);
    tunnelProcess.stderr?.on("data", handleOutput);
    tunnelProcess.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    tunnelProcess.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(
        new Error(`cloudflared exited before announcing a tunnel URL (${signal ?? code ?? "unknown"})`),
      );
    });
  });

  return {
    process: tunnelProcess,
    url,
  };
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
    console.log(chalk.yellow(`Could not open browser automatically. Open ${url} manually.`));
  });
  return true;
}

async function waitForDashboard(url: string, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0 && response.status < 500) {
        return true;
      }
    } catch {
      // Dashboard is still starting.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  return false;
}

function getDefaultLauncherWorkspace(): string {
  return resolve(homedir(), ".openclaw", "workspace");
}

function resolveWorkspacePathHint(configHint?: string | null): string {
  if (!configHint) {
    return getDefaultLauncherWorkspace();
  }

  const resolved = resolve(configHint);
  if (existsSync(resolved) && basename(resolved).match(/^conductor\.ya?ml$/i)) {
    return dirname(resolved);
  }
  return resolved;
}

function findConfigFile(startDir?: string): string | null {
  const baseDir = resolveWorkspacePathHint(startDir);
  let currentDir = baseDir;

  for (;;) {
    for (const filename of ["conductor.yaml", "conductor.yml"]) {
      const candidate = join(currentDir, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
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

function loadLauncherSettings(configHint?: string | null): LauncherSettings {
  const explicitConfigPath = configHint && basename(configHint).match(/^conductor\.ya?ml$/i)
    ? resolve(configHint)
    : null;
  const configPath = explicitConfigPath ?? findConfigFile(configHint ?? undefined);

  if (!configPath) {
    const bootstrap = ensureDashboardBootstrapWorkspace();
    return {
      workspacePath: bootstrap.workspacePath,
      configPath: bootstrap.configPath,
      dashboardPort: 4747,
      backendPort: 4748,
      access: {
        requireAuth: false,
        defaultRole: "operator",
        trustedHeaders: resolveTrustedHeaderAuth({}),
      },
    };
  }

  const parsed = parseYaml(readFileSync(configPath, "utf8"));
  const config = asObject(parsed);
  const access = asObject(config["access"]);
  const server = asObject(config["server"]);

  return {
    workspacePath: dirname(configPath),
    configPath,
    dashboardPort: 4747,
    backendPort: coercePort(server["port"], coercePort(config["port"], 4748)),
    access: {
      requireAuth: asBoolean(access["requireAuth"]),
      defaultRole: asTrimmedString(access["defaultRole"]),
      trustedHeaders: resolveTrustedHeaderAuth(config),
    },
  };
}

function resolveBackendPort(cliValue: string | undefined, configuredPort: number): number {
  const raw = cliValue?.trim() || process.env["CONDUCTOR_BACKEND_PORT"]?.trim();
  if (!raw) return configuredPort;
  return coercePort(raw, configuredPort);
}

function resolveFrontendPort(cliValue: string | undefined, configuredPort: number): number {
  const raw = cliValue?.trim() || process.env["PORT"]?.trim();
  if (!raw) return configuredPort;
  return coercePort(raw, configuredPort);
}

function resolveRepoCargoRoot(workspacePath: string): string | null {
  const candidate = resolve(workspacePath);
  if (
    existsSync(join(candidate, "Cargo.toml"))
    && existsSync(join(candidate, "crates", "conductor-cli", "Cargo.toml"))
  ) {
    return candidate;
  }

  return null;
}

function resolveBundledRustBinary(): string | null {
  const binaryName = process.platform === "win32" ? "conductor.exe" : "conductor";
  const cliDir = new URL(".", import.meta.url).pathname;
  const candidates = [
    resolve(cliDir, "..", "..", "native", binaryName),
    resolve(cliDir, "..", "..", "..", "native", binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveRustBackendLaunch(workspacePath: string, configPath: string, backendPort: number): RustLaunchConfig | null {
  const bundledBinary = resolveBundledRustBinary();
  if (bundledBinary) {
    return {
      cmd: bundledBinary,
      args: [
        "--workspace",
        workspacePath,
        "--config",
        configPath,
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        String(backendPort),
      ],
      cwd: workspacePath,
      label: "bundled Rust backend",
    };
  }

  const repoCargoRoot = resolveRepoCargoRoot(workspacePath);
  if (!repoCargoRoot) {
    return null;
  }

  const binaryName = process.platform === "win32" ? "conductor.exe" : "conductor";
  const prebuiltCandidates = [
    join(repoCargoRoot, "target", "release", binaryName),
    join(repoCargoRoot, "target", "debug", binaryName),
  ];

  for (const candidate of prebuiltCandidates) {
    if (existsSync(candidate)) {
      return {
        cmd: candidate,
        args: [
          "--workspace",
          workspacePath,
          "--config",
          configPath,
          "start",
          "--host",
          "127.0.0.1",
          "--port",
          String(backendPort),
        ],
        cwd: repoCargoRoot,
        label: "prebuilt Rust backend",
      };
    }
  }

  return {
    cmd: "cargo",
    args: [
      "run",
      "-p",
      "conductor-cli",
      "--",
      "--workspace",
      workspacePath,
      "--config",
      configPath,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(backendPort),
    ],
    cwd: repoCargoRoot,
    label: "cargo-run Rust backend",
  };
}

async function waitForHttpService(url: string, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Service is still starting.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  return false;
}

async function killStalePortListener(port: number): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    const pids = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf8" }).trim();
    if (!pids) {
      return;
    }

    for (const pid of pids.split("\n").filter(Boolean)) {
      if (pid !== String(process.pid)) {
        process.kill(Number(pid), "SIGTERM");
        console.log(`[port] Killed stale process ${pid} on port ${port}`);
      }
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  } catch {
    // no stale process — expected
  }
}

function resolveDashboardWebMode(mode: string | undefined): "auto" | "dev" | "production" | "standalone" {
  switch (mode?.trim().toLowerCase()) {
    case "dev":
      return "dev";
    case "production":
    case "prod":
      return "production";
    case "standalone":
      return "standalone";
    default:
      return "auto";
  }
}

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start the Rust backend and web dashboard (foreground)")
    .option("--no-dashboard", "Skip starting the web dashboard")
    .option("--no-watcher", "Deprecated. Rust backend startup no longer uses the JS watcher")
    .option("--open", "Open the dashboard in your default browser")
    .option("--tunnel", "Expose the dashboard on a free public Cloudflare Quick Tunnel")
    .option("--host <host>", "Dashboard bind host. Defaults to 127.0.0.1 for local-only access")
    .option("-p, --port <port>", "Dashboard port override")
    .option("--no-backend", "Do not launch a separate local Rust backend")
    .option("--backend-port <port>", "Rust backend port override (default: from config or 4748)")
    .option("-w, --workspace <path>", "Workspace path or conductor.yaml path")
    .action(async (opts: {
      dashboard?: boolean;
      watcher?: boolean;
      open?: boolean;
      tunnel?: boolean;
      host?: string;
      port?: string;
      backend?: boolean;
      backendPort?: string;
      workspace?: string;
    }) => {
      try {
        const configHint = opts.workspace
          || process.env["CO_CONFIG_PATH"]?.trim()
          || process.env["CONDUCTOR_WORKSPACE"]
          || null;
        const settings = loadLauncherSettings(configHint);
        const workspacePath = settings.workspacePath;
        const configPath = settings.configPath;
        const dashboardPort = resolveFrontendPort(opts.port, settings.dashboardPort);
        const backendPort = resolveBackendPort(opts.backendPort, settings.backendPort);
        const explicitBackendUrl = process.env["CONDUCTOR_BACKEND_URL"]?.trim() || null;
        const bindHost = opts.host?.trim() || "127.0.0.1";
        const shutdownTasks: Array<() => void | Promise<void>> = [];
        let isShuttingDown = false;

        process.env["CONDUCTOR_WORKSPACE"] = workspacePath;
        process.env["CO_CONFIG_PATH"] = configPath;

        const requestShutdown = (): void => {
          void (async () => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            for (const task of shutdownTasks) {
              try {
                await task();
              } catch (error) {
                console.error(error);
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

        if (opts.watcher === false) {
          console.log(chalk.dim("  JS watcher flag ignored: runtime ownership has moved to the Rust backend path."));
        }

        // ---- Start Rust backend ----
        let backendProcess: ChildProcess | null = null;
        const shouldLaunchBackend = opts.backend !== false && !explicitBackendUrl;
        const backendUrl = explicitBackendUrl ?? (shouldLaunchBackend ? `http://127.0.0.1:${backendPort}` : null);

        if (shouldLaunchBackend) {
          const backendSpinner = ora(`Starting Rust backend on http://127.0.0.1:${backendPort}`).start();
          const launch = resolveRustBackendLaunch(workspacePath, configPath, backendPort);

          if (!launch) {
            backendSpinner.warn("Rust backend binary was not found. Build or package the Rust backend first.");
          } else {
            try {
              await killStalePortListener(backendPort);
              backendProcess = spawn(launch.cmd, launch.args, {
                cwd: launch.cwd,
                stdio: "inherit",
                detached: false,
                env: {
                  ...process.env,
                },
              });

              backendProcess.on("error", () => {
                backendSpinner.warn("Rust backend failed to start.");
              });

              const backendReady = await waitForHttpService(`${backendUrl}/api/health`);
              if (backendReady) {
                backendSpinner.succeed(`Rust backend running on ${backendUrl} (${launch.label})`);
              } else {
                backendSpinner.warn(`Rust backend did not become ready at ${backendUrl} in time.`);
              }

              shutdownTasks.push(() => {
                if (backendProcess && backendProcess.exitCode === null) {
                  backendProcess.kill("SIGTERM");
                }
              });
            } catch (error) {
              backendSpinner.warn(`Rust backend failed: ${error}`);
            }
          }
        } else if (explicitBackendUrl) {
          console.log(chalk.dim(`  Backend:   using existing Rust backend at ${explicitBackendUrl}`));
        } else {
          console.log(chalk.yellow("  Backend:   not launched; frontend API requests will fail without CONDUCTOR_BACKEND_URL."));
        }

        // ---- Start web dashboard ----
        let dashboardProcess: ChildProcess | null = null;
        let publicDashboardUrl: string | null = null;
        let unlockDashboardUrl: string | null = null;
        const externalAccessRequested = opts.tunnel === true || !isLoopbackHost(bindHost);
        const clerkConfigured = Boolean(
          process.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] && process.env["CLERK_SECRET_KEY"],
        );
        const trustedHeaderAuth = settings.access.trustedHeaders;
        const builtinRemoteAuth = resolveBuiltinRemoteAuth(
          externalAccessRequested && !clerkConfigured,
        );

        if (opts.dashboard !== false) {
          const dashSpinner = ora("Starting web dashboard").start();

          try {
            const cliDir = new URL(".", import.meta.url).pathname;
            const { cpSync, readdirSync, statSync } = await import("node:fs");

            let webDir: string | null = null;
            const candidates = [
              resolve(cliDir, "..", "web"),
              resolve(cliDir, "..", "..", "..", "web"),
              resolve(cliDir, "..", "..", "web"),
              resolve(dirname(configPath), "packages", "web"),
            ];

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

            await killStalePortListener(dashboardPort);

            const webMode = resolveDashboardWebMode(process.env["CONDUCTOR_WEB_MODE"]);
            const isSourceCheckout = existsSync(join(webDir, "src", "app", "page.tsx"))
              && existsSync(join(webDir, "next.config.ts"));
            const preferDevServer = webMode === "dev" || (webMode === "auto" && isSourceCheckout);
            const standaloneDir = join(webDir, ".next", "standalone");
            const hasNextBuild = existsSync(join(webDir, ".next"));

            let standaloneServer: string | null = null;
            const searchQueue = [standaloneDir];
            for (let depth = 0; depth < 6 && searchQueue.length > 0 && !standaloneServer; depth += 1) {
              const nextQueue: string[] = [];
              for (const currentDir of searchQueue) {
                const candidate = join(currentDir, "server.js");
                if (existsSync(candidate)) {
                  standaloneServer = candidate;
                  break;
                }
                try {
                  for (const entry of readdirSync(currentDir)) {
                    const full = join(currentDir, String(entry));
                    if (statSync(full).isDirectory() && entry !== "node_modules") {
                      nextQueue.push(full);
                    }
                  }
                } catch {
                  // ignore
                }
              }
              searchQueue.splice(0, searchQueue.length, ...nextQueue);
            }

            let cmd: string;
            let args: string[];
            let dashboardCwd = webDir;

            if (preferDevServer) {
              cmd = "pnpm";
              args = ["run", "dev", "--hostname", bindHost, "--port", String(dashboardPort)];
            } else if (webMode === "production" && hasNextBuild) {
              cmd = "pnpm";
              args = ["run", "start", "--hostname", bindHost, "--port", String(dashboardPort)];
            } else if (standaloneServer) {
              const standaloneAppDir = dirname(standaloneServer);
              const standaloneStaticDir = join(standaloneAppDir, ".next", "static");
              const sourceStaticDir = join(webDir, ".next", "static");
              const standalonePublicDir = join(standaloneAppDir, "public");
              const sourcePublicDir = join(webDir, "public");
              if (!existsSync(standaloneStaticDir) && existsSync(sourceStaticDir)) {
                mkdirSync(join(standaloneAppDir, ".next"), { recursive: true });
                cpSync(sourceStaticDir, standaloneStaticDir, { recursive: true });
              }
              if (!existsSync(standalonePublicDir) && existsSync(sourcePublicDir)) {
                cpSync(sourcePublicDir, standalonePublicDir, { recursive: true });
              }
              cmd = process.execPath;
              args = [standaloneServer];
              dashboardCwd = standaloneDir;
            } else if (hasNextBuild) {
              cmd = "pnpm";
              args = ["run", "start", "--hostname", bindHost, "--port", String(dashboardPort)];
            } else {
              cmd = "pnpm";
              args = ["run", "dev", "--hostname", bindHost, "--port", String(dashboardPort)];
            }

            dashboardProcess = spawn(cmd, args, {
              cwd: dashboardCwd,
              stdio: "inherit",
              detached: false,
              env: {
                ...process.env,
                PORT: String(dashboardPort),
                HOSTNAME: bindHost,
                CONDUCTOR_WORKSPACE: workspacePath,
                CO_CONFIG_PATH: configPath,
                ...(backendUrl
                  ? {
                      CONDUCTOR_BACKEND_URL: backendUrl,
                      CONDUCTOR_BACKEND_PORT: String(backendPort),
                    }
                  : {}),
                ...(builtinRemoteAuth
                  ? {
                      CONDUCTOR_REMOTE_ACCESS_TOKEN: builtinRemoteAuth.accessToken,
                      CONDUCTOR_REMOTE_SESSION_SECRET: builtinRemoteAuth.sessionSecret,
                    }
                  : {}),
                ...(trustedHeaderAuth.enabled
                  ? {
                      CONDUCTOR_TRUST_AUTH_HEADERS: "true",
                      CONDUCTOR_TRUST_AUTH_PROVIDER: trustedHeaderAuth.provider,
                      CONDUCTOR_TRUST_AUTH_EMAIL_HEADER: trustedHeaderAuth.emailHeader,
                      CONDUCTOR_TRUST_AUTH_JWT_HEADER: trustedHeaderAuth.jwtHeader,
                      ...(trustedHeaderAuth.teamDomain
                        ? { CONDUCTOR_CLOUDFLARE_ACCESS_TEAM_DOMAIN: trustedHeaderAuth.teamDomain }
                        : {}),
                      ...(trustedHeaderAuth.audience
                        ? { CONDUCTOR_CLOUDFLARE_ACCESS_AUDIENCE: trustedHeaderAuth.audience }
                        : {}),
                    }
                  : {}),
                ...(settings.access.requireAuth
                  ? { CONDUCTOR_REQUIRE_AUTH: "true" }
                  : {}),
                ...(settings.access.defaultRole
                  ? { CONDUCTOR_ACCESS_DEFAULT_ROLE: settings.access.defaultRole }
                  : {}),
              },
            });

            dashboardProcess.on("error", () => {
              dashSpinner.warn("Dashboard failed to start. Try: cd packages/web && pnpm build");
            });

            const dashboardInternalUrl = `http://127.0.0.1:${dashboardPort}`;
            const dashboardUrl = isLoopbackHost(bindHost)
              ? `http://localhost:${dashboardPort}`
              : `http://${bindHost}:${dashboardPort}`;
            if (builtinRemoteAuth) {
              unlockDashboardUrl = buildRemoteUnlockUrl(dashboardUrl, builtinRemoteAuth.accessToken);
            }
            dashSpinner.succeed(`Web dashboard starting on ${dashboardUrl}`);

            if (opts.tunnel) {
              const tunnelSpinner = ora("Starting Cloudflare Quick Tunnel").start();
              if (!commandExists("cloudflared")) {
                tunnelSpinner.warn("cloudflared is not installed. Re-run `co setup --yes --tunnel` to automate public URL setup.");
              } else if (await waitForDashboard(dashboardInternalUrl)) {
                try {
                  const tunnel = startCloudflareQuickTunnel(dashboardInternalUrl);
                  shutdownTasks.push(() => {
                    if (tunnel.process.exitCode === null) {
                      tunnel.process.kill("SIGTERM");
                    }
                  });
                  publicDashboardUrl = await tunnel.url;
                  if (builtinRemoteAuth) {
                    unlockDashboardUrl = buildRemoteUnlockUrl(publicDashboardUrl, builtinRemoteAuth.accessToken);
                  }
                  tunnelSpinner.succeed(`Public dashboard available at ${publicDashboardUrl}`);
                } catch (error) {
                  tunnelSpinner.warn(`Cloudflare Quick Tunnel failed: ${error}`);
                }
              } else {
                tunnelSpinner.warn("Dashboard was not ready in time for tunnel startup.");
              }
            }

            if (opts.open) {
              const preferredUrl = unlockDashboardUrl ?? publicDashboardUrl ?? dashboardUrl;
              void waitForDashboard(dashboardInternalUrl).then((ready) => {
                if (ready) {
                  const targetUrl = preferredUrl || dashboardUrl;
                  if (openDashboardInBrowser(targetUrl)) {
                    console.log(chalk.bold("Opening Conductor in your browser..."));
                  }
                  return;
                }

                console.log(chalk.yellow(`Dashboard is still starting. Open ${dashboardUrl} manually if it does not open shortly.`));
              });
            }
          } catch (error) {
            dashSpinner.warn(`Could not start dashboard: ${error}`);
          }
        }

        // ---- Summary ----
        console.log();
        console.log(chalk.bold.green("Conductor is running."));
        console.log(chalk.dim(`  Config:    ${configPath}`));
        if (opts.dashboard !== false) {
          const dashboardSummaryUrl = isLoopbackHost(bindHost)
            ? `http://localhost:${dashboardPort}`
            : `http://${bindHost}:${dashboardPort}`;
          console.log(chalk.dim(`  Dashboard: ${dashboardSummaryUrl}`));
          if (backendUrl) {
            console.log(chalk.dim(`  Backend:   ${backendUrl}`));
          }
          if (publicDashboardUrl) {
            console.log(chalk.dim(`  Public:    ${publicDashboardUrl}`));
          }
          if (unlockDashboardUrl) {
            console.log(chalk.dim(`  Unlock:    ${unlockDashboardUrl}`));
            console.log(chalk.dim("  Security:  Share the unlock link only with devices that should control this session."));
          }
          if (trustedHeaderAuth.enabled) {
            if (
              trustedHeaderAuth.provider === "cloudflare-access"
              && trustedHeaderAuth.teamDomain
              && trustedHeaderAuth.audience
            ) {
              console.log(chalk.dim(
                `  Edge Auth: Cloudflare Access via ${trustedHeaderAuth.teamDomain} (${trustedHeaderAuth.emailHeader})`,
              ));
            } else if (trustedHeaderAuth.provider === "cloudflare-access") {
              console.log(chalk.dim(
                "  Edge Auth: Cloudflare Access is enabled but still needs team domain and audience configuration.",
              ));
            } else {
              console.log(chalk.dim(`  Edge Auth: generic trusted header ${trustedHeaderAuth.emailHeader}`));
            }
          }
        }
        console.log(chalk.dim("  Runtime:   Rust backend + Next frontend"));
        console.log(chalk.dim("  Press Ctrl-C to stop.\n"));

        if (dashboardProcess) {
          dashboardProcess.on("exit", (code, signal) => {
            if (code !== 0 && code !== null) {
              console.error(
                chalk.yellow(
                  `Dashboard exited with code ${code}${signal ? ` (signal ${signal})` : ""}. ` +
                  "Keeping the Rust backend running.",
                ),
              );
            }
          });
        }

        if (backendProcess) {
          backendProcess.on("exit", (code, signal) => {
            if (code !== 0 && code !== null) {
              console.error(
                chalk.red(
                  `Rust backend exited with code ${code}${signal ? ` (signal ${signal})` : ""}.`,
                ),
              );
            }
          });
        }

        setInterval(() => {
          // Keep the launcher attached while child processes run.
        }, 60_000);
      } catch (error) {
        console.error(chalk.red(`Failed to start: ${error}`));
        process.exit(1);
      }
    });
}
