import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRustCliLaunch, rustCliGlobalArgs } from "./rust-cli.js";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 2;
const TERMINAL_DAEMON_READY_TIMEOUT_MS = 5_000;
const TERMINAL_DAEMON_CONNECT_TIMEOUT_MS = 750;
const TERMINAL_DAEMON_PING_RETRY_DELAY_MS = 150;
const TERMINAL_DAEMON_REUSE_GRACE_PERIOD_MS = 2_000;
const TERMINAL_DAEMON_SHUTDOWN_TIMEOUT_MS = 1_500;
const TERMINAL_DAEMON_SESSION_SHUTDOWN_TIMEOUT_MS = 2_000;

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
  protocolVersion?: number | null;
  cols?: number | null;
  rows?: number | null;
  controlSocketPath?: string | null;
  streamSocketPath?: string | null;
  controlToken?: string | null;
  logPath?: string | null;
  checkpointPath?: string | null;
  exitPath?: string | null;
  headlessSnapshot?: Record<string, unknown> | null;
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

type TerminalDaemonReplayPayload = {
  bytesBase64: string;
  byteLength: number;
  startOffset: number;
  endOffset: number;
  truncated: boolean;
};

type TerminalDaemonCheckpointPayload = TerminalDaemonReplayPayload & {
  cols: number;
  rows: number;
  outputOffset?: number | null;
  restoreSnapshot?: Record<string, unknown> | null;
};

type DetachedPtyHostResponse = {
  protocolVersion: number;
  ok: boolean;
  childPid: number | null;
  outputOffset?: number | null;
  restoreSnapshot?: Record<string, unknown> | null;
  error: string | null;
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
  }
  | {
    command: "list_sessions";
    protocol_version: number;
    token: string;
  }
  | {
    command: "get_session";
    protocol_version: number;
    token: string;
    session_id: string;
  }
  | {
    command: "get_session_replay";
    protocol_version: number;
    token: string;
    session_id: string;
    max_bytes: number;
  }
  | {
    command: "get_session_checkpoint";
    protocol_version: number;
    token: string;
    session_id: string;
    max_bytes: number;
  }
  | {
    command: "terminate_session";
    protocol_version: number;
    token: string;
    session_id: string;
  }
  | {
    command: "signal";
    protocol_version: number;
    token: string;
    session_id: string;
    signal: string;
  }
  | {
    command: "write_no_ack";
    protocol_version: number;
    token: string;
    session_id: string;
    data: string;
  };

type TerminalDaemonResponse = {
  protocolVersion: number;
  ok: boolean;
  daemonPid: number | null;
  hostPid: number | null;
  childPid: number | null;
  error: string | null;
  sessions?: string[];
  session?: TerminalDaemonSessionState | null;
  replay?: TerminalDaemonReplayPayload | null;
  checkpoint?: TerminalDaemonCheckpointPayload | null;
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
  // Unix sockets have a 104-byte path limit on macOS (108 on Linux).
  // The runtimeDir-based path can exceed this, so place the socket in
  // /tmp with a short hash prefix to stay well under the limit.
  const shortKey = key.slice(0, 16);
  const socketPath = join(tmpdir(), `co-daemon-${shortKey}.sock`);
  return {
    runtimeDir,
    socketPath,
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
  return resolveNodeEntrypointLaunchTarget(
    "./terminal-daemon.js",
    "./terminal-daemon.ts",
    "Unable to resolve the terminal daemon entrypoint for this CLI install",
    baseUrl,
    pathExists,
    tsxCliPath,
  );
}

function resolveDetachedPtyHostLaunchTarget(
  baseUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
  tsxCliPath: string | null = resolveLocalTsxCliPath(),
): TerminalDaemonLaunchTarget {
  return resolveNodeEntrypointLaunchTarget(
    "./pty-host.js",
    "./pty-host.ts",
    "Unable to resolve the detached PTY host entrypoint for this CLI install",
    baseUrl,
    pathExists,
    tsxCliPath,
  );
}

function resolveNodeEntrypointLaunchTarget(
  compiledRelativePath: string,
  sourceRelativePath: string,
  errorMessage: string,
  baseUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
  tsxCliPath: string | null = resolveLocalTsxCliPath(),
): TerminalDaemonLaunchTarget {
  const compiledEntry = fileURLToPath(new URL(compiledRelativePath, baseUrl));
  if (pathExists(compiledEntry)) {
    return {
      cmd: process.execPath,
      args: [compiledEntry],
    };
  }

  const sourceEntry = fileURLToPath(new URL(sourceRelativePath, baseUrl));
  if (pathExists(sourceEntry) && tsxCliPath) {
    return {
      cmd: process.execPath,
      args: [tsxCliPath, sourceEntry],
    };
  }

  throw new Error(errorMessage);
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
      if (!existsSync(runtime.socketPath)) {
        throw new Error("Socket not found yet");
      }
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

let pendingEnsureDaemon: Promise<TerminalDaemonRuntime | null> | null = null;

export async function ensureTerminalDaemon(
  workspacePath: string,
  configPath: string,
): Promise<TerminalDaemonRuntime | null> {
  if (pendingEnsureDaemon) {
    return pendingEnsureDaemon;
  }
  pendingEnsureDaemon = ensureTerminalDaemonImpl(workspacePath, configPath);
  try {
    return await pendingEnsureDaemon;
  } finally {
    pendingEnsureDaemon = null;
  }
}

async function ensureTerminalDaemonImpl(
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

async function waitForReadyFile(
  readyPath: string,
  hostProcess?: ChildProcess,
): Promise<{ hostPid: number; childPid: number; protocolVersion: number }> {
  const startedAt = Date.now();
  // These are assigned inside event callbacks which TS control-flow can't
  // track, so we type them as mutable records read at each loop iteration.
  const exitState: { exit: { code: number | null; signal: NodeJS.Signals | null } | null; error: Error | null } = {
    exit: null,
    error: null,
  };

  const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitState.exit = { code, signal };
  };
  const handleError = (error: Error): void => {
    exitState.error = error;
  };

  hostProcess?.once("exit", handleExit);
  hostProcess?.once("error", handleError);

  try {
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

      if (exitState.error) {
        throw new Error(`PTY host failed before readiness: ${exitState.error.message}`);
      }

      if (exitState.exit) {
        const detail = [
          exitState.exit.code !== null ? `code ${exitState.exit.code}` : null,
          exitState.exit.signal ? `signal ${exitState.exit.signal}` : null,
        ].filter(Boolean).join(", ");
        throw new Error(
          detail.length > 0
            ? `PTY host exited before readiness (${detail})`
            : "PTY host exited before readiness",
        );
      }

      await wait(50);
    }
  } finally {
    hostProcess?.off("exit", handleExit);
    hostProcess?.off("error", handleError);
  }

  throw new Error(`Timed out waiting for PTY host readiness at ${readyPath}`);
}

function cloneTerminalDaemonSessionState(
  session: TerminalDaemonSessionState,
): TerminalDaemonSessionState {
  return {
    ...session,
    ...readTerminalDaemonSessionReplayInfo(session.specPath),
  };
}

export function readTerminalDaemonSessionReplayInfo(
  specPath: string,
): Partial<TerminalDaemonSessionState> {
  const spec = readJsonFile<{
    protocolVersion?: number;
    cols?: number;
    rows?: number;
    controlSocketPath?: string;
    streamSocketPath?: string;
    token?: string;
    logPath?: string;
    checkpointPath?: string;
    exitPath?: string;
  }>(specPath);
  if (!spec) {
    return {};
  }

  return {
    protocolVersion: spec.protocolVersion ?? TERMINAL_DAEMON_PROTOCOL_VERSION,
    cols: spec.cols ?? null,
    rows: spec.rows ?? null,
    controlSocketPath: spec.controlSocketPath ?? null,
    streamSocketPath: spec.streamSocketPath ?? null,
    controlToken: spec.token ?? null,
    logPath: spec.logPath ?? null,
    checkpointPath: spec.checkpointPath ?? null,
    exitPath: spec.exitPath ?? null,
  };
}

export function readTerminalDaemonReplayPayload(
  logPath: string,
  maxBytes: number,
): TerminalDaemonReplayPayload | null {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return null;
  }

  try {
    const fd = openSync(logPath, "r");
    try {
      const stat = fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize === 0) {
        return null;
      }
      const readLength = Math.min(fileSize, Math.floor(maxBytes));
      const start = fileSize - readLength;
      const buffer = Buffer.alloc(readLength);
      readSync(fd, buffer, 0, readLength, start);
      return {
        bytesBase64: buffer.toString("base64"),
        byteLength: readLength,
        startOffset: start,
        endOffset: fileSize,
        truncated: start > 0,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

async function sendDetachedPtyHostRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<DetachedPtyHostResponse> {
  return await new Promise<DetachedPtyHostResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Timed out waiting for detached PTY host response"));
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
          resolveResponse(JSON.parse(line) as DetachedPtyHostResponse);
        } catch (error) {
          cleanup();
          socket.destroy();
          rejectResponse(error);
        }
      })();
    });
  });
}

async function readDetachedPtyHostCheckpoint(
  session: TerminalDaemonSessionState | null,
): Promise<DetachedPtyHostResponse | null> {
  if (
    session?.status !== "ready"
    || !session.controlSocketPath
    || !session.controlToken
  ) {
    return null;
  }

  try {
    const response = await sendDetachedPtyHostRequest(session.controlSocketPath, {
      protocolVersion: session.protocolVersion ?? TERMINAL_DAEMON_PROTOCOL_VERSION,
      token: session.controlToken,
      kind: "checkpoint",
    });
    if (!response.ok) {
      return null;
    }
    return response;
  } catch {
    return null;
  }
}

function readPersistedCheckpointArtifact(
  checkpointPath: string,
): DetachedPtyHostResponse | null {
  const checkpoint = readJsonFile<{
    outputOffset?: number;
    restoreSnapshot?: Record<string, unknown>;
  }>(checkpointPath);
  if (!checkpoint?.restoreSnapshot) {
    return null;
  }

  return {
    protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
    ok: true,
    childPid: null,
    outputOffset: checkpoint.outputOffset ?? null,
    restoreSnapshot: checkpoint.restoreSnapshot,
    error: null,
  };
}

export async function buildTerminalDaemonCheckpointPayload(
  session: TerminalDaemonSessionState | null,
  maxBytes: number,
): Promise<TerminalDaemonCheckpointPayload | null> {
  const hostCheckpoint = await readDetachedPtyHostCheckpoint(session);
  const persistedCheckpoint = !hostCheckpoint?.restoreSnapshot && session?.checkpointPath
    ? readPersistedCheckpointArtifact(session.checkpointPath)
    : null;
  const restoreSnapshot = hostCheckpoint?.restoreSnapshot ?? persistedCheckpoint?.restoreSnapshot ?? null;
  const snapshotCols = Number(restoreSnapshot?.["cols"]);
  const snapshotRows = Number(restoreSnapshot?.["rows"]);
  if (restoreSnapshot) {
    return {
      bytesBase64: "",
      byteLength: 0,
      startOffset: 0,
      endOffset: 0,
      truncated: false,
      cols: Number.isFinite(snapshotCols) && snapshotCols > 0
        ? snapshotCols
        : (session?.cols ?? 120),
      rows: Number.isFinite(snapshotRows) && snapshotRows > 0
        ? snapshotRows
        : (session?.rows ?? 32),
      outputOffset: hostCheckpoint?.outputOffset ?? persistedCheckpoint?.outputOffset ?? null,
      restoreSnapshot,
    };
  }

  if (!session?.logPath) {
    return null;
  }
  const replay = readTerminalDaemonReplayPayload(session.logPath, maxBytes);
  if (!replay) {
    return null;
  }

  return {
    ...replay,
    cols: session.cols ?? 120,
    rows: session.rows ?? 32,
    outputOffset: replay.endOffset,
    restoreSnapshot: null,
  };
}

function syncTerminalDaemonSessionLiveness(
  workspacePath: string,
  sessions: Map<string, TerminalDaemonSessionState>,
  sessionId: string,
  statePath: string,
): TerminalDaemonSessionState | null {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if ((session.status === "ready" || session.status === "spawning") && !processIsAlive(session.hostPid)) {
    session.status = "exited";
    session.updatedAt = new Date().toISOString();
    persistDaemonState(statePath, workspacePath, sessions);
  }

  return cloneTerminalDaemonSessionState(session);
}

function syncAllTerminalDaemonSessions(
  workspacePath: string,
  statePath: string,
  sessions: Map<string, TerminalDaemonSessionState>,
): void {
  let changed = false;
  for (const session of sessions.values()) {
    if ((session.status === "ready" || session.status === "spawning") && !processIsAlive(session.hostPid)) {
      session.status = "exited";
      session.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) {
    persistDaemonState(statePath, workspacePath, sessions);
  }
}

/**
 * Signal a process group or individual process.
 * NOTE: There is a TOCTOU window between liveness checks and this kill call —
 * if the PID is reused after the host exits, an unrelated process group could
 * be signaled.  This is accepted for local-only daemon operation; callers
 * should verify liveness before invoking.
 */
const VALID_DAEMON_SIGNALS = new Set<string>([
  "SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGUSR1", "SIGUSR2",
  "SIGQUIT", "SIGCONT", "SIGSTOP", "SIGTSTP",
]);

function signalTerminalDaemonSessionProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // Validate signal against a known whitelist before sending.
  if (!VALID_DAEMON_SIGNALS.has(signal)) {
    return;
  }

  // Liveness check: verify the PID is still alive before signaling to reduce
  // the TOCTOU window where a reused PID could be targeted.
  if (!processIsAlive(pid)) {
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to the host pid directly if the process group no longer exists.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort termination only.
  }
}

async function terminateTerminalDaemonSessionHost(pid: number | null | undefined): Promise<boolean> {
  if (!pid || pid <= 0 || !processIsAlive(pid)) {
    return true;
  }

  signalTerminalDaemonSessionProcessGroup(pid, "SIGTERM");

  const startedAt = Date.now();
  while (Date.now() - startedAt < TERMINAL_DAEMON_SESSION_SHUTDOWN_TIMEOUT_MS) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await wait(50);
  }

  signalTerminalDaemonSessionProcessGroup(pid, "SIGKILL");
  const forcedAt = Date.now();
  while (Date.now() - forcedAt < 1_000) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await wait(50);
  }

  return !processIsAlive(pid);
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
    socket.on("error", () => {
      // Ignore socket errors to prevent unhandled exception crash
    });
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
    try {
      socket.write(`${JSON.stringify({
        protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
        ok: false,
        daemonPid: process.pid,
        hostPid: null,
        childPid: null,
        error: message,
      } satisfies TerminalDaemonResponse)}\n`);
    } catch {
      // Ignore write errors to closed sockets
    }
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
  // Backward compat: v1 clients can still use ping and spawn_host.
  // All other commands require v2.
  const isV1BackwardCompat =
    request.protocol_version === 1 &&
    (request.command === "ping" || request.command === "spawn_host");
  if (request.protocol_version !== TERMINAL_DAEMON_PROTOCOL_VERSION && !isV1BackwardCompat) {
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

  if (request.command === "list_sessions") {
    syncAllTerminalDaemonSessions(
      context.workspacePath,
      context.statePath,
      context.sessions,
    );
    const sessions = Array.from(context.sessions.entries())
      .filter(([, session]) => session.status === "ready")
      .filter(([, session]) => processIsAlive(session.hostPid))
      .map(([sessionId]) => sessionId)
      .sort();

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: null,
      sessions,
    };
  }

  if (request.command === "get_session") {
    const session = syncTerminalDaemonSessionLiveness(
        context.workspacePath,
        context.sessions,
        request.session_id,
        context.statePath,
    );
    let headlessSnapshot: Record<string, unknown> | null = null;
    if (session?.status === "ready" && session.controlSocketPath && session.controlToken) {
        try {
            const response = await sendDetachedPtyHostRequest(session.controlSocketPath, {
                protocolVersion: session.protocolVersion ?? TERMINAL_DAEMON_PROTOCOL_VERSION,
                token: session.controlToken,
                kind: "snapshot",
            });
            if (response.ok) {
                headlessSnapshot = response.restoreSnapshot ?? null;
            }
        } catch {
            // Best-effort snapshot; continue if it fails.
        }
    }
    if (session) {
        session.headlessSnapshot = headlessSnapshot;
    }
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: null,
      session: session ? cloneTerminalDaemonSessionState(session) : null,
    };
  }

  if (request.command === "get_session_replay") {
    const session = syncTerminalDaemonSessionLiveness(
      context.workspacePath,
      context.sessions,
      request.session_id,
      context.statePath,
    );
    const replay = session?.logPath
      ? readTerminalDaemonReplayPayload(session.logPath, request.max_bytes)
      : null;

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: session?.hostPid ?? null,
      childPid: session?.childPid ?? null,
      error: null,
      session,
      replay,
    };
  }

  if (request.command === "get_session_checkpoint") {
    const session = syncTerminalDaemonSessionLiveness(
      context.workspacePath,
      context.sessions,
      request.session_id,
      context.statePath,
    );
    const checkpoint = await buildTerminalDaemonCheckpointPayload(session, request.max_bytes);

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: session?.hostPid ?? null,
      childPid: session?.childPid ?? null,
      error: null,
      session,
      checkpoint,
    };
  }

  if (request.command === "terminate_session") {
    const session = syncTerminalDaemonSessionLiveness(
      context.workspacePath,
      context.sessions,
      request.session_id,
      context.statePath,
    );
    if (!session) {
      return {
        protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
        ok: true,
        daemonPid: process.pid,
        hostPid: null,
        childPid: null,
        error: null,
        session: null,
      };
    }

    const terminated = await terminateTerminalDaemonSessionHost(session.hostPid);
    const current = context.sessions.get(request.session_id);
    if (current) {
      current.status = terminated ? "exited" : "failed";
      current.updatedAt = new Date().toISOString();
      current.error = terminated ? null : "Timed out waiting for PTY host termination";
      persistDaemonState(context.statePath, context.workspacePath, context.sessions);
    }

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: terminated,
      daemonPid: process.pid,
      hostPid: current?.hostPid ?? session.hostPid ?? null,
      childPid: current?.childPid ?? session.childPid ?? null,
      error: terminated ? null : "Timed out waiting for PTY host termination",
      session: current ? cloneTerminalDaemonSessionState(current) : session,
    };
  }

  if (request.command === "signal") {
    const session = syncTerminalDaemonSessionLiveness(
      context.workspacePath,
      context.sessions,
      request.session_id,
      context.statePath,
    );
    if (!session || !session.hostPid || !processIsAlive(session.hostPid)) {
      return {
        protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
        ok: false,
        daemonPid: process.pid,
        hostPid: session?.hostPid ?? null,
        childPid: session?.childPid ?? null,
        error: "Session host is not running",
        session: session ?? null,
      };
    }

    const sig = request.signal as NodeJS.Signals;
    if (!VALID_DAEMON_SIGNALS.has(sig)) {
      return {
        protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
        ok: false,
        daemonPid: process.pid,
        hostPid: session.hostPid,
        childPid: session.childPid ?? null,
        error: `Invalid signal: ${String(request.signal)}`,
        session: cloneTerminalDaemonSessionState(session),
      };
    }
    try {
      signalTerminalDaemonSessionProcessGroup(session.hostPid, sig);
    } catch {
      // best-effort
    }

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: session.hostPid,
      childPid: session.childPid ?? null,
      error: null,
      session: cloneTerminalDaemonSessionState(session),
    };
  }

  if (request.command === "write_no_ack") {
    const session = context.sessions.get(request.session_id);
    if (
      session?.status === "ready" &&
      session.controlSocketPath &&
      session.controlToken
    ) {
      // Fire-and-forget: write to the pty-host's control socket without
      // waiting for a response.  This avoids timeout overhead for input.
      try {
        const socket = createConnection(session.controlSocketPath);
        const writeRequest = {
          protocolVersion: session.protocolVersion ?? TERMINAL_DAEMON_PROTOCOL_VERSION,
          token: session.controlToken,
          kind: "raw",
          data: request.data,
        };
        socket.write(`${JSON.stringify(writeRequest)}\n`);
        // Don't wait for response — fire and forget
        socket.on("error", () => {});
        // Close after a brief drain period
        setTimeout(() => socket.destroy(), 100);
      } catch {
        // best-effort
      }
    }

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: session?.hostPid ?? null,
      childPid: session?.childPid ?? null,
      error: null,
    };
  }

  if (request.command !== "spawn_host") {
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: `Unknown terminal daemon command: ${String((request as Record<string, unknown>).command)}`,
    };
  }

  // Validate that spec_path and ready_path are within the workspace directory
  // to prevent arbitrary file access via crafted daemon requests.
  // The Rust backend stores these in .conductor/rust-backend/direct/ under the
  // workspace root, so we validate against the workspace path (not the daemon's
  // own runtime directory which lives under ~/.conductor/runtime/).
  const normalizedSpec = resolve(request.spec_path);
  const normalizedReady = resolve(request.ready_path);
  const normalizedWorkspace = resolve(context.workspacePath);
  if (!normalizedSpec.startsWith(normalizedWorkspace + sep) || !normalizedReady.startsWith(normalizedWorkspace + sep)) {
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: null,
      childPid: null,
      error: `spec_path and ready_path must be within the workspace directory (${normalizedWorkspace})`,
    };
  }

  const release = await context.semaphore.acquire();
  let stderrChunks: Buffer[] = [];
  let stderrStream: import("node:stream").Readable | null = null;
  try {
    const launchTarget = resolveDetachedPtyHostLaunchTarget();
    const child = spawn(launchTarget.cmd, [...launchTarget.args, "--spec", request.spec_path], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        CONDUCTOR_WORKSPACE: context.workspacePath,
        CO_CONFIG_PATH: context.configPath,
      },
    });

    // Capture early stderr output from the child to aid crash diagnosis.
    // The pipe is closed once the child is unref'd and the ready file is
    // detected, so this only captures startup failures.
    stderrStream = child.stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: Buffer) => {
        if (stderrChunks.length < 20) {
          stderrChunks.push(chunk);
        }
      });
    }
    child.unref();

    const sessionState: TerminalDaemonSessionState = {
      sessionId: request.session_id,
      specPath: request.spec_path,
      readyPath: request.ready_path,
      hostPid: child.pid ?? null,
      childPid: null,
      ...readTerminalDaemonSessionReplayInfo(request.spec_path),
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

    const ready = await waitForReadyFile(request.ready_path, child);
    sessionState.hostPid = ready.hostPid || child.pid || null;
    sessionState.childPid = ready.childPid;
    sessionState.status = "ready";
    sessionState.updatedAt = new Date().toISOString();
    persistDaemonState(context.statePath, context.workspacePath, context.sessions);

    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: true,
      daemonPid: process.pid,
      hostPid: sessionState.hostPid,
      childPid: ready.childPid,
      error: null,
    };
  } catch (error) {
    const session = context.sessions.get(request.session_id);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const capturedStderr = stderrChunks.length > 0
      ? Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 2048)
      : null;
    const fullError = capturedStderr
      ? `${errorMessage} [stderr: ${capturedStderr}]`
      : errorMessage;

    if (session) {
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
      session.error = fullError;
      persistDaemonState(context.statePath, context.workspacePath, context.sessions);
    }
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      ok: false,
      daemonPid: process.pid,
      hostPid: session?.hostPid ?? null,
      childPid: session?.childPid ?? null,
      error: fullError,
    };
  } finally {
    // Clean up stderr pipe to avoid holding the child process
    if (stderrStream) {
      stderrStream.removeAllListeners("data");
      stderrStream.destroy();
    }
    stderrChunks = [];
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
