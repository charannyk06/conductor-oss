import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRustCliLaunch, rustCliGlobalArgs } from "./rust-cli.js";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 1;
const TERMINAL_DAEMON_READY_TIMEOUT_MS = 5_000;
const TERMINAL_DAEMON_CONNECT_TIMEOUT_MS = 750;
const TERMINAL_DAEMON_PING_RETRY_DELAY_MS = 150;
const TERMINAL_DAEMON_REUSE_GRACE_PERIOD_MS = 2_000;
const TERMINAL_DAEMON_SHUTDOWN_TIMEOUT_MS = 1_500;

type TerminalDaemonRuntimePaths = {
  runtimeDir: string;
  socketPath: string;
  infoPath: string;
  statePath: string;
};

type TerminalDaemonInfo = {
  protocolVersion: number;
  pid: number;
  socketPath: string;
  token: string;
  workspacePath: string;
  startedAt: string;
  updatedAt: string;
};

type TerminalDaemonSessionState = {
  sessionId: string;
  specPath: string;
  readyPath: string;
  hostPid: number | null;
  childPid: number | null;
  status: "spawning" | "ready" | "exited" | "failed";
  startedAt: string;
  updatedAt: string;
  error: string | null;
};

type TerminalDaemonState = {
  protocolVersion: number;
  daemonPid: number;
  workspacePath: string;
  sessions: Record<string, TerminalDaemonSessionState>;
  updatedAt: string;
};

type TerminalDaemonRuntime = {
  socketPath: string;
  token: string;
  protocolVersion: number;
};

type TerminalDaemonLaunchTarget = {
  cmd: string;
  args: string[];
};

type TerminalDaemonRequest =
  | {
    command: "ping";
    protocol_version: number;
    token: string;
  }
  | {
    command: "spawn_host";
    protocol_version: number;
    token: string;
    session_id: string;
    spec_path: string;
    ready_path: string;
  };

type TerminalDaemonResponse = {
  protocolVersion: number;
  ok: boolean;
  daemonPid: number | null;
  hostPid: number | null;
  childPid: number | null;
  error: string | null;
};

type SpawnQueuePermit = () => void;

type SemaphoreState = {
  active: number;
  queue: Array<() => void>;
  maxConcurrent: number;
};

function isUnixLikePlatform(): boolean {
  return process.platform !== "win32";
}

function workspaceRuntimeKey(workspacePath: string): string {
  return createHash("sha256").update(workspacePath.trim()).digest("hex");
}

export function getTerminalDaemonRuntimePaths(workspacePath: string): TerminalDaemonRuntimePaths {
  const key = workspaceRuntimeKey(workspacePath);
  const runtimeDir = join(homedir(), ".conductor", "runtime", "terminal-daemon", key);
  return {
    runtimeDir,
    socketPath: join("/tmp", `conductor-terminal-daemon-${key.slice(0, 16)}.sock`),
    infoPath: join(runtimeDir, "info.json"),
    statePath: join(runtimeDir, "state.json"),
  };
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalTsxCliPath(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const packageJsonPath = require.resolve("tsx/package.json");
    const candidate = join(dirname(packageJsonPath), "dist", "cli.mjs");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveTerminalDaemonLaunchTarget(
  baseUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
  tsxCliPath: string | null = resolveLocalTsxCliPath(),
): TerminalDaemonLaunchTarget {
  const compiledEntry = fileURLToPath(new URL("./terminal-daemon.js", baseUrl));
  if (pathExists(compiledEntry)) {
    return {
      cmd: process.execPath,
      args: [compiledEntry],
    };
  }

  const sourceEntry = fileURLToPath(new URL("./terminal-daemon.ts", baseUrl));
  if (pathExists(sourceEntry) && tsxCliPath) {
    return {
      cmd: process.execPath,
      args: [tsxCliPath, sourceEntry],
    };
  }

  throw new Error("Unable to resolve the terminal daemon entrypoint for this CLI install");
}

function parseDaemonArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (typeof value === "string" && !value.startsWith("--")) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function createSemaphore(maxConcurrent: number): {
  acquire: () => Promise<SpawnQueuePermit>;
} {
  const state: SemaphoreState = {
    active: 0,
    queue: [],
    maxConcurrent,
  };

  const release = (): void => {
    state.active = Math.max(0, state.active - 1);
    const next = state.queue.shift();
    if (next) {
      state.active += 1;
      next();
    }
  };

  const acquire = async (): Promise<SpawnQueuePermit> => {
    if (state.active < state.maxConcurrent) {
      state.active += 1;
      return release;
    }

    return await new Promise<SpawnQueuePermit>((resolvePermit) => {
      state.queue.push(() => resolvePermit(release));
    });
  };

  return { acquire };
}

async function readLineFromSocket(socket: Socket): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let buffer = "";
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      cleanup();
      resolveLine(buffer.slice(0, index));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectLine(error);
    };
    const onEnd = (): void => {
      cleanup();
      rejectLine(new Error("Socket closed before a full response line arrived"));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}

async function sendTerminalDaemonRequest(
  socketPath: string,
  request: TerminalDaemonRequest,
): Promise<TerminalDaemonResponse> {
  return await new Promise<TerminalDaemonResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Timed out waiting for terminal daemon response"));
    }, TERMINAL_DAEMON_CONNECT_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timeout);
    };

    socket.once("error", (error) => {
      cleanup();
      rejectResponse(error);
    });

    socket.once("connect", () => {
      void (async () => {
        try {
          socket.write(`${JSON.stringify(request)}\n`);
          const line = await readLineFromSocket(socket);
          cleanup();
          socket.end();
          resolveResponse(JSON.parse(line) as TerminalDaemonResponse);
        } catch (error) {
          cleanup();
          socket.destroy();
          rejectResponse(error);
        }
      })();
    });
  });
}

async function pingTerminalDaemon(runtime: TerminalDaemonRuntime): Promise<boolean> {
  const maxAttempts = Math.max(
    1,
    Math.ceil(TERMINAL_DAEMON_REUSE_GRACE_PERIOD_MS / TERMINAL_DAEMON_PING_RETRY_DELAY_MS),
  );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await sendTerminalDaemonRequest(runtime.socketPath, {
        command: "ping",
        protocol_version: TERMINAL_DAEMON_PROTOCOL_VERSION,
        token: runtime.token,
      });
      return response.ok && response.protocolVersion === TERMINAL_DAEMON_PROTOCOL_VERSION;
    } catch {
      if (attempt + 1 >= maxAttempts) {
        return false;
      }
      await wait(TERMINAL_DAEMON_PING_RETRY_DELAY_MS);
    }
  }

  return false;
}

function loadRuntimeInfo(workspacePath: string): TerminalDaemonRuntime | null {
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const info = readJsonFile<TerminalDaemonInfo>(paths.infoPath);
  if (!info) return null;
  if (info.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION) return null;
  if (!info.socketPath || !info.token) return null;
  return {
    socketPath: info.socketPath,
    token: info.token,
    protocolVersion: info.protocolVersion,
  };
}

function loadDaemonInfo(workspacePath: string): TerminalDaemonInfo | null {
  return readJsonFile<TerminalDaemonInfo>(getTerminalDaemonRuntimePaths(workspacePath).infoPath);
}

async function terminateTerminalDaemon(pid: number): Promise<boolean> {
  if (!processIsAlive(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !processIsAlive(pid);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < TERMINAL_DAEMON_SHUTDOWN_TIMEOUT_MS) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await wait(50);
  }

  return !processIsAlive(pid);
}

function spawnTerminalDaemonProcess(workspacePath: string, configPath: string, runtime: TerminalDaemonRuntime): void {
  const launchTarget = resolveTerminalDaemonLaunchTarget();
  const child = spawn(
    launchTarget.cmd,
    [
      ...launchTarget.args,
      "--workspace",
      workspacePath,
      "--config",
      configPath,
      "--socket",
      runtime.socketPath,
      "--token",
      runtime.token,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CONDUCTOR_WORKSPACE: workspacePath,
        CO_CONFIG_PATH: configPath,
      },
    },
  );
  child.unref();
}

async function waitForTerminalDaemon(runtime: TerminalDaemonRuntime): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TERMINAL_DAEMON_READY_TIMEOUT_MS) {
    if (await pingTerminalDaemon(runtime)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw new Error(`Terminal daemon did not become ready at ${runtime.socketPath}`);
}

export async function ensureTerminalDaemon(
  workspacePath: string,
  configPath: string,
): Promise<TerminalDaemonRuntime | null> {
  if (!isUnixLikePlatform()) {
    return null;
  }

  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const existingInfo = loadDaemonInfo(workspacePath);
  const existing = loadRuntimeInfo(workspacePath);
  if (existing && await pingTerminalDaemon(existing)) {
    return existing;
  }

  if (existingInfo?.pid && processIsAlive(existingInfo.pid)) {
    if (existing && await pingTerminalDaemon(existing)) {
      return existing;
    }

    const terminated = await terminateTerminalDaemon(existingInfo.pid);
    if (!terminated) {
      return null;
    }
  }

  const runtime: TerminalDaemonRuntime = {
    socketPath: paths.socketPath,
    token: existing?.token ?? existingInfo?.token ?? randomBytes(24).toString("base64url"),
    protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
  };

  rmSync(paths.socketPath, { force: true });
  spawnTerminalDaemonProcess(workspacePath, configPath, runtime);
  await waitForTerminalDaemon(runtime);
  return runtime;
}

async function waitForReadyFile(readyPath: string): Promise<{ hostPid: number; childPid: number; protocolVersion: number }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TERMINAL_DAEMON_READY_TIMEOUT_MS) {
    const ready = readJsonFile<{
      protocolVersion?: number;
      hostPid?: number;
      childPid?: number;
    }>(readyPath);
    if (ready?.childPid && ready?.hostPid) {
      return {
        protocolVersion: ready.protocolVersion ?? TERMINAL_DAEMON_PROTOCOL_VERSION,
        hostPid: ready.hostPid,
        childPid: ready.childPid,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error(`Timed out waiting for PTY host readiness at ${readyPath}`);
}

function buildDaemonInfo(
  workspacePath: string,
  socketPath: string,
  token: string,
): TerminalDaemonInfo {
  const now = new Date().toISOString();
  return {
    protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
    pid: process.pid,
    socketPath,
    token,
    workspacePath,
    startedAt: now,
    updatedAt: now,
  };
}

function persistDaemonState(
  statePath: string,
  workspacePath: string,
  sessions: Map<string, TerminalDaemonSessionState>,
): void {
  const payload: TerminalDaemonState = {
    protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
    daemonPid: process.pid,
    workspacePath,
    sessions: Object.fromEntries(sessions.entries()),
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(statePath, payload);
}

function loadExistingSessions(statePath: string): Map<string, TerminalDaemonSessionState> {
  const payload = readJsonFile<TerminalDaemonState>(statePath);
  if (!payload || payload.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION) {
    return new Map();
  }

  const sessions = new Map<string, TerminalDaemonSessionState>();
  for (const [sessionId, session] of Object.entries(payload.sessions ?? {})) {
    if (session.status === "ready" && processIsAlive(session.hostPid)) {
      sessions.set(sessionId, session);
    }
  }
  return sessions;
}

async function runTerminalDaemonServer(options: {
  workspacePath: string;
  configPath: string;
  socketPath: string;
  token: string;
}): Promise<void> {
  if (!isUnixLikePlatform()) {
    throw new Error("Terminal daemon requires a Unix platform");
  }

  const paths = getTerminalDaemonRuntimePaths(options.workspacePath);
  mkdirSync(paths.runtimeDir, { recursive: true });
  rmSync(options.socketPath, { force: true });

  const info = buildDaemonInfo(options.workspacePath, options.socketPath, options.token);
  writeJsonFile(paths.infoPath, info);
  const sessions = loadExistingSessions(paths.statePath);
  persistDaemonState(paths.statePath, options.workspacePath, sessions);

  const semaphore = createSemaphore(
    Number.parseInt(process.env["CONDUCTOR_TERMINAL_DAEMON_MAX_SPAWNS"] ?? "4", 10) || 4,
  );
  const server = createServer((socket) => {
    void handleDaemonConnection(socket, {
      workspacePath: options.workspacePath,
      configPath: options.configPath,
      token: options.token,
      sessions,
      statePath: paths.statePath,
      semaphore,
    });
  });

  server.listen(options.socketPath);

  const shutdown = (): void => {
    server.close();
    rmSync(options.socketPath, { force: true });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("listening", () => resolveServer());
    server.once("error", (error) => rejectServer(error));
  });
}

async function handleDaemonConnection(
  socket: Socket,
  context: {
    workspacePath: string;
    configPath: string;
    token: string;
    sessions: Map<string, TerminalDaemonSessionState>;
    statePath: string;
    semaphore: { acquire: () => Promise<SpawnQueuePermit> };
  },
): Promise<void> {
  try {
    const line = await readLineFromSocket(socket);
    const request = JSON.parse(line) as TerminalDaemonRequest;
    const response = await handleDaemonRequest(request, context);
    socket.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    socket.write(`${JSON.stringify({
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: message,
    } satisfies TerminalDaemonResponse)}\n`);
  } finally {
    socket.end();
  }
}

async function handleDaemonRequest(
  request: TerminalDaemonRequest,
  context: {
    workspacePath: string;
    configPath: string;
    token: string;
    sessions: Map<string, TerminalDaemonSessionState>;
    statePath: string;
    semaphore: { acquire: () => Promise<SpawnQueuePermit> };
  },
): Promise<TerminalDaemonResponse> {
  if (request.protocol_version !== TERMINAL_DAEMON_PROTOCOL_VERSION) {
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: `Unsupported terminal daemon protocol version: ${request.protocol_version}`,
    };
  }

  if (request.token !== context.token) {
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: "Unauthorized terminal daemon request",
    };
  }

  if (request.command === "ping") {
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: null,
    };
  }

  const release = await context.semaphore.acquire();
  try {
    const launch = resolveRustCliLaunch();
    const args = [
      ...launch.argsPrefix,
      ...rustCliGlobalArgs(),
      "pty-host",
      "--spec",
      request.spec_path,
    ];
    const child = spawn(launch.cmd, args, {
      cwd: launch.cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CONDUCTOR_WORKSPACE: context.workspacePath,
        CO_CONFIG_PATH: context.configPath,
      },
    });
    child.unref();

    const sessionState: TerminalDaemonSessionState = {
      sessionId: request.session_id,
      specPath: request.spec_path,
      readyPath: request.ready_path,
      hostPid: child.pid ?? null,
      childPid: null,
      status: "spawning",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };
    context.sessions.set(request.session_id, sessionState);
    persistDaemonState(context.statePath, context.workspacePath, context.sessions);

    child.on("exit", () => {
      const current = context.sessions.get(request.session_id);
      if (!current) return;
      current.status = "exited";
      current.updatedAt = new Date().toISOString();
      persistDaemonState(context.statePath, context.workspacePath, context.sessions);
    });

    const ready = await waitForReadyFile(request.ready_path);
    sessionState.hostPid = ready.hostPid || child.pid || null;
    sessionState.childPid = ready.childPid;
    sessionState.status = "ready";
    sessionState.updatedAt = new Date().toISOString();
    persistDaemonState(context.statePath, context.workspacePath, context.sessions);

    return {
      protocolVersion: ready.protocolVersion,
      ok: true,
      daemonPid: process.pid,
      hostPid: sessionState.hostPid,
      childPid: ready.childPid,
      error: null,
    };
  } catch (error) {
    const session = context.sessions.get(request.session_id);
    if (session) {
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
      session.error = error instanceof Error ? error.message : String(error);
      persistDaemonState(context.statePath, context.workspacePath, context.sessions);
    }
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: session?.hostPid ?? null,
      childPid: session?.childPid ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    release();
  }
}

async function runAsDaemonCli(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));
  const workspacePath = args["workspace"];
  const configPath = args["config"];
  const socketPath = args["socket"];
  const token = args["token"];

  if (!workspacePath || !configPath || !socketPath || !token) {
    throw new Error("Missing required terminal daemon arguments");
  }

  await runTerminalDaemonServer({
    workspacePath,
    configPath,
    socketPath,
    token,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runAsDaemonCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
