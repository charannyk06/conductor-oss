/**
 * `co start`
 *
 * Starts the Rust backend and web dashboard in the foreground.
 * The JS launcher is intentionally thin: it resolves paths, launches
 * the Rust backend, and wires the frontend to it.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

type CliInstallMode =
  | "source"
  | "npx"
  | "global-npm"
  | "global-pnpm"
  | "global-bun"
  | "unknown";

type CliUpdateContext = {
  packageName: string;
  version: string;
  installMode: CliInstallMode;
};

export function quoteWindowsCliArg(value: string): string {
  let escaped = "";
  let backslashCount = 0;

  for (const char of value) {
    if (char === "\\") {
      backslashCount += 1;
      continue;
    }

    if (char === "\"") {
      escaped += "\\".repeat(backslashCount * 2 + 1);
      escaped += "\"";
      backslashCount = 0;
      continue;
    }

    if (backslashCount > 0) {
      escaped += "\\".repeat(backslashCount);
      backslashCount = 0;
    }

    escaped += char;
  }

  if (backslashCount > 0) {
    escaped += "\\".repeat(backslashCount * 2);
  }

  return `"${escaped}"`;
}

export function quoteCliArg(value: string): string {
  if (value.length === 0) {
    return process.platform === "win32" ? "\"\"" : "''";
  }

  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  if (process.platform === "win32") {
    return quoteWindowsCliArg(value);
  }

  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function isPathInside(candidate: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function readCommandStdout(command: string, args: string[]): string | null {
  if (!commandExists(command)) return null;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const stdout = result.stdout?.trim();
  return stdout && stdout.length > 0 ? stdout : null;
}

function resolveBunGlobalNodeModulesDir(): string {
  const bunInstallRoot = process.env["BUN_INSTALL"]?.trim() || join(homedir(), ".bun");
  return join(bunInstallRoot, "install", "global", "node_modules");
}

function resolveCliUpdateContext(): CliUpdateContext {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const packageRoot = dirname(fileURLToPath(packageJsonUrl));
  let packageName = "conductor-oss";
  let version = "0.0.0";

  try {
    const payload = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (typeof payload.name === "string" && payload.name.trim().length > 0) {
      packageName = payload.name.trim();
    }
    if (typeof payload.version === "string" && payload.version.trim().length > 0) {
      version = payload.version.trim();
    }
  } catch {
    // Ignore package metadata lookup failures and fall back to defaults.
  }

  const normalizedRoot = normalizeFsPath(packageRoot);
  const parentWorkspaceLockfile = join(packageRoot, "..", "..", "pnpm-lock.yaml");
  if (normalizedRoot.endsWith("/packages/cli") && existsSync(parentWorkspaceLockfile)) {
    return { packageName, version, installMode: "source" };
  }

  if (
    normalizedRoot.includes("/_npx/")
    || normalizedRoot.includes("/npm-cache/_npx/")
    || normalizedRoot.includes("/pnpm/dlx/")
    || normalizedRoot.includes("/bunx/")
  ) {
    return { packageName, version, installMode: "npx" };
  }

  const pnpmGlobalRoot = readCommandStdout("pnpm", ["root", "-g"]);
  if (pnpmGlobalRoot && isPathInside(packageRoot, pnpmGlobalRoot)) {
    return { packageName, version, installMode: "global-pnpm" };
  }

  const npmGlobalPrefix = readCommandStdout("npm", ["prefix", "-g"]);
  if (npmGlobalPrefix) {
    const npmGlobalDirs = [
      join(npmGlobalPrefix, "lib", "node_modules"),
      join(npmGlobalPrefix, "node_modules"),
    ];
    if (npmGlobalDirs.some((dir) => existsSync(dir) && isPathInside(packageRoot, dir))) {
      return { packageName, version, installMode: "global-npm" };
    }
  }

  const bunGlobalRoot = resolveBunGlobalNodeModulesDir();
  if (existsSync(bunGlobalRoot) && isPathInside(packageRoot, bunGlobalRoot)) {
    return { packageName, version, installMode: "global-bun" };
  }

  return { packageName, version, installMode: "unknown" };
}

const cliUpdateContext = resolveCliUpdateContext();

function buildCliRerunCommand(context: CliUpdateContext): string | null {
  if (context.installMode !== "npx") {
    return null;
  }

  const forwardedArgs = process.argv.slice(2).filter((arg) => arg !== "--open");
  const rerunArgs = [`${context.packageName}@latest`, ...forwardedArgs].map(quoteCliArg);
  return `npx ${rerunArgs.join(" ")}`;
}

const cliRerunCommand = buildCliRerunCommand(cliUpdateContext);

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]";
}

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

type RemoteAccessRuntimeState = {
  status: "disabled" | "starting" | "ready" | "error";
  provider: "tailscale" | null;
  publicUrl: string | null;
  localUrl: string | null;
  accessToken: string | null;
  sessionSecret: string | null;
  tunnelPid: number | null;
  logPath: string | null;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

type RustLaunchConfig = {
  cmd: string;
  args: string[];
  cwd: string;
  label: string;
};

type RustLaunchResolution = {
  launch: RustLaunchConfig | null;
  reason?: string;
};

function getRemoteAccessRuntimeStatePath(workspacePath: string): string {
  const workspaceKey = createHash("sha256")
    .update(workspacePath.trim())
    .digest("hex");
  return join(homedir(), ".conductor", "runtime", "remote-access", `${workspaceKey}.json`);
}

function writeRemoteAccessRuntimeState(
  workspacePath: string,
  next: Partial<RemoteAccessRuntimeState> & Pick<RemoteAccessRuntimeState, "status">,
): void {
  const statePath = getRemoteAccessRuntimeStatePath(workspacePath);
  mkdirSync(dirname(statePath), { recursive: true });
  const current = (() => {
    try {
      return JSON.parse(readFileSync(statePath, "utf8")) as Partial<RemoteAccessRuntimeState>;
    } catch {
      return null;
    }
  })();
  const pick = <Key extends keyof RemoteAccessRuntimeState>(key: Key): RemoteAccessRuntimeState[Key] => {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      return (next[key] ?? null) as RemoteAccessRuntimeState[Key];
    }
    return ((current?.[key] as RemoteAccessRuntimeState[Key] | undefined) ?? null) as RemoteAccessRuntimeState[Key];
  };
  const payload: RemoteAccessRuntimeState = {
    status: next.status,
    provider: pick("provider"),
    publicUrl: pick("publicUrl"),
    localUrl: pick("localUrl"),
    accessToken: pick("accessToken"),
    sessionSecret: pick("sessionSecret"),
    tunnelPid: pick("tunnelPid"),
    logPath: pick("logPath"),
    lastError: pick("lastError"),
    startedAt: pick("startedAt"),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
}

function clearRemoteAccessRuntimeState(workspacePath: string): void {
  rmSync(getRemoteAccessRuntimeStatePath(workspacePath), { force: true });
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

type LauncherControlServer = {
  server: HttpServer;
  url: string;
  token: string;
};

function closeLauncherControlServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

async function createLauncherControlServer(onRestart: () => void): Promise<LauncherControlServer> {
  const token = randomBytes(24).toString("base64url");

  return await new Promise<LauncherControlServer>((resolveServer, rejectServer) => {
    const server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/restart") {
        response.statusCode = 404;
        response.end();
        return;
      }

      const authorization = request.headers["authorization"];
      if (authorization !== `Bearer ${token}`) {
        response.statusCode = 403;
        response.end();
        return;
      }

      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      setTimeout(onRestart, 75);
    });

    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Failed to allocate launcher control port"));
        return;
      }

      resolveServer({
        server,
        url: `http://127.0.0.1:${(address as AddressInfo).port}`,
        token,
      });
    });
  });
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
    backendPort: coercePort(server["port"], 4748),
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

function resolveOptionalNativePackageNames(): string[] {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return ["conductor-oss-native-darwin-universal"];
  }

  if (process.platform === "linux" && process.arch === "x64") {
    return ["conductor-oss-native-linux-x64"];
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return ["conductor-oss-native-win32-x64"];
  }

  return [];
}

function resolveBundledRustBinary(): string | null {
  const binaryName = process.platform === "win32" ? "conductor.exe" : "conductor";
  const require = createRequire(import.meta.url);

  for (const packageName of resolveOptionalNativePackageNames()) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`);
      const candidate = join(dirname(packageJsonPath), "bin", binaryName);
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Optional native package is not installed for this environment.
    }
  }

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

function detectNativeBinaryFormat(binaryPath: string): string {
  try {
    const header = readFileSync(binaryPath).subarray(0, 4);
    if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
      return "pe";
    }
    if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
      return "elf";
    }
    if (header.length >= 4) {
      const magic = header.readUInt32BE(0);
      if (
        magic === 0xfeedface
        || magic === 0xcefaedfe
        || magic === 0xfeedfacf
        || magic === 0xcffaedfe
        || magic === 0xcafebabe
        || magic === 0xbebafeca
        || magic === 0xcafebabf
      ) {
        return "macho";
      }
    }
  } catch {
    // ignore and treat as unknown
  }

  return "unknown";
}

function isCompatibleNativeBinary(binaryPath: string): boolean {
  const format = detectNativeBinaryFormat(binaryPath);
  if (process.platform === "darwin") return format === "macho";
  if (process.platform === "linux") return format === "elf";
  if (process.platform === "win32") return format === "pe";
  return true;
}

function describeNativeBinaryHostMismatch(binaryPath: string): string {
  const format = detectNativeBinaryFormat(binaryPath);
  return `Bundled Rust backend is incompatible with ${process.platform}-${process.arch} (binary format: ${format}).`;
}

function resolveNewestExistingBinary(candidates: string[]): string | null {
  const existing = candidates
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => {
      try {
        return { candidate, mtimeMs: statSync(candidate).mtimeMs };
      } catch {
        return { candidate, mtimeMs: 0 };
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return existing[0]?.candidate ?? null;
}

export function resolveRustBackendLaunch(
  workspacePath: string,
  configPath: string,
  backendPort: number,
): RustLaunchResolution {
  const repoCargoRoot = resolveRepoCargoRoot(workspacePath);
  if (repoCargoRoot) {
    const binaryName = process.platform === "win32" ? "conductor.exe" : "conductor";
    const prebuiltCandidate = resolveNewestExistingBinary([
      join(repoCargoRoot, "target", "debug", binaryName),
      join(repoCargoRoot, "target", "release", binaryName),
    ]);

    if (prebuiltCandidate) {
      return {
        launch: {
          cmd: prebuiltCandidate,
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
        },
      };
    }

    return {
      launch: {
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
      },
    };
  }

  const bundledBinary = resolveBundledRustBinary();
  if (bundledBinary) {
    if (!isCompatibleNativeBinary(bundledBinary)) {
      return {
        launch: null,
        reason: describeNativeBinaryHostMismatch(bundledBinary),
      };
    }

    return {
      launch: {
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
      },
    };
  }

  return {
    launch: null,
    reason: "No compatible bundled Rust backend was found, and this install does not have a repo-local Cargo fallback.",
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
    .option("--tunnel", "Deprecated. Public share-link remote access has been removed")
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
        if (opts.tunnel) {
          throw new Error(
            "`--tunnel` was removed for security. Use Settings -> Remote Access to enable the private Tailscale link, or configure Cloudflare Access on a protected public URL.",
          );
        }
        const shutdownTasks: Array<() => void | Promise<void>> = [];
        let isShuttingDown = false;
        let launcherControl: LauncherControlServer | null = null;

        process.env["CONDUCTOR_WORKSPACE"] = workspacePath;
        process.env["CO_CONFIG_PATH"] = configPath;
        clearRemoteAccessRuntimeState(workspacePath);
        shutdownTasks.push(() => clearRemoteAccessRuntimeState(workspacePath));

        const runShutdown = async (): Promise<void> => {
          if (isShuttingDown) return;
          isShuttingDown = true;

          if (launcherControl) {
            try {
              await closeLauncherControlServer(launcherControl.server);
            } catch {
              // Ignore control server shutdown errors.
            }
            launcherControl = null;
          }

          for (const task of shutdownTasks) {
            try {
              await task();
            } catch (error) {
              console.error(error);
            }
          }

          process.exit(0);
        };

        const requestShutdown = (): void => {
          void runShutdown();
        };

        const requestRestart = (): void => {
          void (async () => {
            if (isShuttingDown) return;
            const launcherEntry = process.argv[1];
            if (!launcherEntry) {
              console.error(chalk.red("Could not resolve the Conductor launcher entrypoint for restart."));
              return;
            }

            const restartArgs = process.argv.slice(2).filter((arg) => arg !== "--open");
            const child = spawn(process.execPath, [launcherEntry, ...restartArgs], {
              cwd: process.cwd(),
              detached: true,
              stdio: "ignore",
              env: {
                ...process.env,
              },
            });
            child.unref();
            await runShutdown();
          })();
        };

        launcherControl = await createLauncherControlServer(requestRestart);
        process.env["CONDUCTOR_LAUNCHER_CONTROL_URL"] = launcherControl.url;
        process.env["CONDUCTOR_LAUNCHER_CONTROL_TOKEN"] = launcherControl.token;
        shutdownTasks.push(async () => {
          if (!launcherControl) return;
          await closeLauncherControlServer(launcherControl.server);
          launcherControl = null;
        });

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
          const resolution = resolveRustBackendLaunch(workspacePath, configPath, backendPort);
          const launch = resolution.launch;

          if (!launch) {
            throw new Error(resolution.reason ?? "Rust backend binary was not found. Build or package the Rust backend first.");
          } else {
            try {
              await killStalePortListener(backendPort);
              let backendStartError: Error | null = null;
              backendProcess = spawn(launch.cmd, launch.args, {
                cwd: launch.cwd,
                stdio: "inherit",
                detached: false,
                env: {
                  ...process.env,
                  CONDUCTOR_CLI_PACKAGE_NAME: cliUpdateContext.packageName,
                  CONDUCTOR_CLI_VERSION: cliUpdateContext.version,
                  CONDUCTOR_CLI_INSTALL_MODE: cliUpdateContext.installMode,
                  ...(cliRerunCommand
                    ? { CONDUCTOR_CLI_RERUN_COMMAND: cliRerunCommand }
                    : {}),
                },
              });

              backendProcess.once("error", (error) => {
                backendStartError = error;
              });

              const backendReady = await waitForHttpService(`${backendUrl}/api/health`);
              if (!backendReady) {
                const reason = (backendStartError ? String(backendStartError) : null)
                  || (backendProcess.exitCode !== null
                    ? `Rust backend exited with code ${backendProcess.exitCode}`
                    : `Rust backend did not become ready at ${backendUrl} in time.`);
                throw new Error(reason);
              }

              backendSpinner.succeed(`Rust backend running on ${backendUrl} (${launch.label})`);

              shutdownTasks.push(() => {
                if (backendProcess && backendProcess.exitCode === null) {
                  backendProcess.kill("SIGTERM");
                }
              });
            } catch (error) {
              backendSpinner.fail(`Rust backend failed: ${error}`);
              throw error;
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
        const trustedHeaderAuth = settings.access.trustedHeaders;

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
                CONDUCTOR_CLI_PACKAGE_NAME: cliUpdateContext.packageName,
                CONDUCTOR_CLI_VERSION: cliUpdateContext.version,
                CONDUCTOR_CLI_INSTALL_MODE: cliUpdateContext.installMode,
                ...(cliRerunCommand
                  ? { CONDUCTOR_CLI_RERUN_COMMAND: cliRerunCommand }
                  : {}),
                ...(backendUrl
                  ? {
                      CONDUCTOR_BACKEND_URL: backendUrl,
                      CONDUCTOR_BACKEND_PORT: String(backendPort),
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
            writeRemoteAccessRuntimeState(
              workspacePath,
              {
                status: isLoopbackHost(bindHost) ? "disabled" : "ready",
                provider: null,
                publicUrl: isLoopbackHost(bindHost) ? null : dashboardUrl,
                localUrl: dashboardInternalUrl,
                accessToken: null,
                sessionSecret: null,
                tunnelPid: null,
                logPath: null,
                lastError: null,
                startedAt: new Date().toISOString(),
              },
            );
            dashSpinner.succeed(`Web dashboard starting on ${dashboardUrl}`);

            if (opts.open) {
              const preferredUrl = publicDashboardUrl ?? dashboardUrl;
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
              console.log(chalk.yellow(
                "  Edge Auth: legacy generic trusted-header mode is no longer supported. Configure verified Cloudflare Access instead.",
              ));
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
