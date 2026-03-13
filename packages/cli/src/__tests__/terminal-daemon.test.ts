import assert from "node:assert/strict";
import test from "node:test";
import {
  getTerminalDaemonRuntimePaths,
  resolveTerminalDaemonLaunchTarget,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
} from "../terminal-daemon.js";

test("terminal daemon runtime paths stay workspace-specific and keep unix sockets short", () => {
  const first = getTerminalDaemonRuntimePaths("/tmp/workspace-one");
  const second = getTerminalDaemonRuntimePaths("/tmp/workspace-two");

  assert.notEqual(first.socketPath, second.socketPath);
  assert.match(first.socketPath, /^\/tmp\/conductor-terminal-daemon-[a-f0-9]{16}\.sock$/);
  assert.ok(first.runtimeDir.includes(".conductor/runtime/terminal-daemon/"));
  assert.equal(TERMINAL_DAEMON_PROTOCOL_VERSION, 1);
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
