import assert from "node:assert/strict";
import test from "node:test";
import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTerminalDaemonCheckpointPayload,
  ensureTerminalDaemon,
  getTerminalDaemonRuntimePaths,
  readTerminalDaemonReplayPayload,
  readTerminalDaemonSessionReplayInfo,
  resolveTerminalDaemonLaunchTarget,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
} from "../terminal-daemon.js";

test("terminal daemon runtime paths stay workspace-specific and keep unix sockets short", () => {
  const first = getTerminalDaemonRuntimePaths("/tmp/workspace-one");
  const second = getTerminalDaemonRuntimePaths("/tmp/workspace-two");

  assert.notEqual(first.socketPath, second.socketPath);
  // Socket path uses tmpdir() which may resolve differently on macOS (e.g.
  // /var/folders/...) vs Linux (/tmp).  Just check the filename pattern.
  assert.match(first.socketPath, /co-daemon-[a-f0-9]{16}\.sock$/);
  assert.ok(first.runtimeDir.includes(".conductor/runtime/terminal-daemon/"));
  assert.equal(TERMINAL_DAEMON_PROTOCOL_VERSION, 2);
});

test("terminal daemon launch target falls back to tsx in source checkouts", () => {
  const launch = resolveTerminalDaemonLaunchTarget(
    "file:///repo/packages/cli/src/terminal-daemon.ts",
    (path) => path.endsWith("terminal-daemon.ts"),
    "/repo/node_modules/tsx/dist/cli.mjs",
  );

  assert.equal(launch.cmd, process.execPath);
  assert.deepEqual(launch.args, [
    "/repo/node_modules/tsx/dist/cli.mjs",
    "/repo/packages/cli/src/terminal-daemon.ts",
  ]);
});

test("terminal daemon launch target prefers the compiled entry when present", () => {
  const launch = resolveTerminalDaemonLaunchTarget(
    "file:///repo/packages/cli/dist/terminal-daemon.js",
    (path) => path.endsWith("terminal-daemon.js"),
    "/repo/node_modules/tsx/dist/cli.mjs",
  );

  assert.equal(launch.cmd, process.execPath);
  assert.deepEqual(launch.args, [
    "/repo/packages/cli/dist/terminal-daemon.js",
  ]);
});

function sendTerminalDaemonRequest(
  socketPath: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection({ path: socketPath });
    let data = "";

    const cleanup = (): void => {
      socket.off("error", onError);
      socket.off("data", onData);
      socket.off("end", onEnd);
    };

    const onError = (error: Error): void => {
      cleanup();
      rejectRequest(error);
    };

    const onData = (chunk: Buffer): void => {
      data += chunk.toString("utf8");
    };

    const onEnd = (): void => {
      cleanup();
      try {
        const line = data.trim().split("\n")[0];
        resolveRequest(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        rejectRequest(
          error instanceof Error
            ? error
            : new Error("Failed to parse terminal daemon response"),
        );
      }
    };

    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

test("terminal daemon exposes empty session detail and no-op termination for unknown sessions", async () => {
  const workspacePath = join(tmpdir(), `conductor-terminal-daemon-session-${randomBytes(4).toString("hex")}`);
  const configPath = join(workspacePath, "conductor.yaml");
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(configPath, "projects: []\n", "utf8");

  let daemonPid: number | null = null;
  try {
    const runtime = await ensureTerminalDaemon(workspacePath, configPath);
    if (!runtime) return;

    const info = JSON.parse(readFileSync(paths.infoPath, "utf8")) as { pid: number };
    daemonPid = info.pid;

    const sessionResponse = await sendTerminalDaemonRequest(paths.socketPath, {
      command: "get_session",
      protocol_version: TERMINAL_DAEMON_PROTOCOL_VERSION,
      token: runtime.token,
      session_id: "missing-session",
    });
    assert.equal(sessionResponse["ok"], true);
    assert.equal(sessionResponse["session"], null);

    const terminateResponse = await sendTerminalDaemonRequest(paths.socketPath, {
      command: "terminate_session",
      protocol_version: TERMINAL_DAEMON_PROTOCOL_VERSION,
      token: runtime.token,
      session_id: "missing-session",
    });
    assert.equal(terminateResponse["ok"], true);
    assert.equal(terminateResponse["session"], null);
  } finally {
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // best-effort cleanup
      }
    }
    rmSync(paths.runtimeDir, { force: true, recursive: true });
    rmSync(configPath, { force: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("terminal daemon derives replay metadata from the PTY spec", () => {
  const workspacePath = join(tmpdir(), `conductor-terminal-daemon-replay-${randomBytes(4).toString("hex")}`);
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const specPath = join(paths.runtimeDir, "seed.spec.json");
  const readyPath = join(paths.runtimeDir, "seed.ready.json");
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(specPath, JSON.stringify({
    protocolVersion: 1,
    token: "daemon-token",
    binary: "/bin/sh",
    args: ["-lc", "echo hi"],
    cwd: workspacePath,
    env: {},
    cols: 132,
    rows: 40,
    controlSocketPath: join(paths.runtimeDir, "host.ctrl.sock"),
    streamSocketPath: join(paths.runtimeDir, "host.stream.sock"),
    logPath: join(paths.runtimeDir, "host.log"),
    checkpointPath: join(paths.runtimeDir, "host.checkpoint.json"),
    exitPath: join(paths.runtimeDir, "host.exit"),
    readyPath,
  }, null, 2), "utf8");
  try {
    const session = readTerminalDaemonSessionReplayInfo(specPath);
    assert.equal(session["protocolVersion"], 1);
    assert.equal(session["cols"], 132);
    assert.equal(session["rows"], 40);
    assert.equal(session["controlSocketPath"], join(paths.runtimeDir, "host.ctrl.sock"));
    assert.equal(session["streamSocketPath"], join(paths.runtimeDir, "host.stream.sock"));
    assert.equal(session["controlToken"], "daemon-token");
    assert.equal(session["logPath"], join(paths.runtimeDir, "host.log"));
    assert.equal(session["checkpointPath"], join(paths.runtimeDir, "host.checkpoint.json"));
    assert.equal(session["exitPath"], join(paths.runtimeDir, "host.exit"));
  } finally {
    rmSync(paths.runtimeDir, { force: true, recursive: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("terminal daemon replay payload returns bounded log bytes", () => {
  const workspacePath = join(tmpdir(), `conductor-terminal-daemon-replay-bytes-${randomBytes(4).toString("hex")}`);
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const logPath = join(paths.runtimeDir, "host.log");
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(logPath, "hello\nworld\nfrom daemon replay\n", "utf8");

  try {
    const replay = readTerminalDaemonReplayPayload(logPath, 12);
    assert.ok(replay);
    assert.equal(replay["byteLength"], 12);
    assert.equal(replay["startOffset"], 19);
    assert.equal(replay["endOffset"], 31);
    assert.equal(replay["truncated"], true);
    assert.equal(
      Buffer.from(replay["bytesBase64"], "base64").toString("utf8"),
      "emon replay\n",
    );
  } finally {
    rmSync(paths.runtimeDir, { force: true, recursive: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("terminal daemon checkpoint payload combines replay bytes with dimensions", async () => {
  const workspacePath = join(tmpdir(), `conductor-terminal-daemon-checkpoint-${randomBytes(4).toString("hex")}`);
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const logPath = join(paths.runtimeDir, "host.log");
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(logPath, "hello\nworld\nfrom daemon replay\n", "utf8");

  try {
    const checkpoint = await buildTerminalDaemonCheckpointPayload({
      sessionId: "session-1",
      specPath: join(paths.runtimeDir, "host.spec.json"),
      readyPath: join(paths.runtimeDir, "host.ready.json"),
      hostPid: 123,
      childPid: 456,
      protocolVersion: 1,
      cols: 132,
      rows: 40,
      controlSocketPath: null,
      streamSocketPath: null,
      controlToken: null,
      logPath,
      checkpointPath: join(paths.runtimeDir, "host.checkpoint.json"),
      exitPath: null,
      status: "ready",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    }, 12);
    assert.ok(checkpoint);
    assert.equal(checkpoint["cols"], 132);
    assert.equal(checkpoint["rows"], 40);
    assert.equal(checkpoint["startOffset"], 19);
    assert.equal(checkpoint["endOffset"], 31);
    assert.equal(checkpoint["restoreSnapshot"], null);
  } finally {
    rmSync(paths.runtimeDir, { force: true, recursive: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("terminal daemon checkpoint payload prefers a live host restore snapshot", async () => {
  const workspacePath = join(tmpdir(), `conductor-terminal-daemon-host-checkpoint-${randomBytes(4).toString("hex")}`);
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const controlSocketPath = join(tmpdir(), `conductor-host-checkpoint-${randomBytes(4).toString("hex")}.sock`);
  mkdirSync(paths.runtimeDir, { recursive: true });

  const snapshot = {
    version: 1,
    sequence: 7,
    cols: 144,
    rows: 48,
    hasOutput: true,
    modes: {
      alternateScreen: false,
      applicationKeypad: false,
      applicationCursor: false,
      hideCursor: false,
      bracketedPaste: false,
      mouseProtocolMode: "none",
      mouseProtocolEncoding: "default",
    },
    history: "",
    screen: Buffer.from("hello from host").toString("base64"),
  };

  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(`${JSON.stringify({
        protocolVersion: 1,
        ok: true,
        childPid: 456,
        outputOffset: 27,
        restoreSnapshot: snapshot,
        error: null,
      })}\n`);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlSocketPath, resolve);
    });

    const checkpoint = await buildTerminalDaemonCheckpointPayload({
      sessionId: "session-1",
      specPath: join(paths.runtimeDir, "host.spec.json"),
      readyPath: join(paths.runtimeDir, "host.ready.json"),
      hostPid: 123,
      childPid: 456,
      protocolVersion: 1,
      cols: 132,
      rows: 40,
      controlSocketPath,
      streamSocketPath: null,
      controlToken: "daemon-token",
      logPath: join(paths.runtimeDir, "host.log"),
      checkpointPath: join(paths.runtimeDir, "host.checkpoint.json"),
      exitPath: null,
      status: "ready",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    }, 12);
    assert.ok(checkpoint);
    assert.equal(checkpoint["cols"], 144);
    assert.equal(checkpoint["rows"], 48);
    assert.equal(checkpoint["byteLength"], 0);
    assert.equal(checkpoint["outputOffset"], 27);
    assert.deepEqual(checkpoint["restoreSnapshot"], snapshot);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(controlSocketPath, { force: true });
    rmSync(paths.runtimeDir, { force: true, recursive: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("terminal daemon checkpoint payload falls back to a persisted checkpoint artifact", async () => {
  const workspacePath = join(tmpdir(), `conductor-terminal-daemon-persisted-checkpoint-${randomBytes(4).toString("hex")}`);
  const paths = getTerminalDaemonRuntimePaths(workspacePath);
  const checkpointPath = join(paths.runtimeDir, "host.checkpoint.json");
  mkdirSync(paths.runtimeDir, { recursive: true });

  const snapshot = {
    version: 1,
    sequence: 9,
    cols: 150,
    rows: 50,
    hasOutput: true,
    modes: {
      alternateScreen: false,
      applicationKeypad: false,
      applicationCursor: false,
      hideCursor: false,
      bracketedPaste: false,
      mouseProtocolMode: "none",
      mouseProtocolEncoding: "default",
    },
    history: Buffer.from("history").toString("base64"),
    screen: Buffer.from("screen").toString("base64"),
  };
  writeFileSync(checkpointPath, JSON.stringify({
    outputOffset: 41,
    restoreSnapshot: snapshot,
  }, null, 2), "utf8");

  try {
    const checkpoint = await buildTerminalDaemonCheckpointPayload({
      sessionId: "session-1",
      specPath: join(paths.runtimeDir, "host.spec.json"),
      readyPath: join(paths.runtimeDir, "host.ready.json"),
      hostPid: 123,
      childPid: 456,
      protocolVersion: 1,
      cols: 132,
      rows: 40,
      controlSocketPath: join(tmpdir(), `missing-host-${randomBytes(4).toString("hex")}.sock`),
      streamSocketPath: null,
      controlToken: "daemon-token",
      logPath: join(paths.runtimeDir, "host.log"),
      checkpointPath,
      exitPath: null,
      status: "ready",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    }, 12);
    assert.ok(checkpoint);
    assert.equal(checkpoint["cols"], 150);
    assert.equal(checkpoint["rows"], 50);
    assert.equal(checkpoint["outputOffset"], 41);
    assert.deepEqual(checkpoint["restoreSnapshot"], snapshot);
  } finally {
    rmSync(paths.runtimeDir, { force: true, recursive: true });
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
