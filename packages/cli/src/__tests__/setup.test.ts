import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAgentCheck,
  buildTunnelCheck,
  resolveAgentSetupConfig,
  resolveTunnelSetupConfig,
} from "../commands/setup.js";

const BASE_SYSTEM_PATH = "/bin:/usr/bin:/usr/sbin:/sbin";

function makeExecutable(dir: string, name: string): void {
  const target = join(dir, name);
  writeFileSync(target, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(target, 0o755);
}

function withTemporaryPath(commands: string[], run: () => void): void {
  const sandbox = mkdtempSync(join(tmpdir(), "conductor-cli-setup-"));
  const originalPath = process.env.PATH;

  try {
    for (const command of commands) {
      makeExecutable(sandbox, command);
    }
    process.env.PATH = `${sandbox}:${BASE_SYSTEM_PATH}`;
    run();
  } finally {
    process.env.PATH = originalPath;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("Qwen setup metadata points at the official package and auth command", () => {
  const config = resolveAgentSetupConfig("qwen-code");

  assert.deepEqual(config.commands, ["qwen", "qwen-code"]);
  assert.equal(config.installPackage, "@qwen-code/qwen-code@latest");
  assert.equal(config.requiredNodeMajor, 20);
  assert.deepEqual(config.postInstallAuthCommand, {
    label: "Connect Qwen Code",
    cmd: "qwen",
    args: [],
  });
});

test("buildAgentCheck treats the qwen binary as an installed Qwen Code CLI", () => {
  withTemporaryPath(["npm", "qwen"], () => {
    const check = buildAgentCheck("qwen-code");

    assert.equal(check.installed, true);
    assert.equal(check.install, undefined);
    assert.equal(check.postInstallAuthCommand, undefined);
  });
});

test("Codex setup metadata points at the current official npm package", () => {
  const config = resolveAgentSetupConfig("codex");

  assert.deepEqual(config.commands, ["codex"]);
  assert.equal(config.installPackage, "@openai/codex");
  assert.deepEqual(config.postInstallAuthCommand, {
    label: "Connect OpenAI Codex",
    cmd: "codex",
    args: ["login"],
  });
});

test("Cloudflare tunnel setup metadata points at the free tunnel binary", () => {
  const config = resolveTunnelSetupConfig("cloudflare");

  assert.deepEqual(config.commands, ["cloudflared"]);
  assert.equal(config.install?.label, "Install Cloudflare Tunnel");
  assert.ok(config.install === undefined || config.install.args.includes("cloudflared"));
});

test("buildTunnelCheck recognizes cloudflared on PATH", () => {
  withTemporaryPath(["cloudflared"], () => {
    const check = buildTunnelCheck("cloudflare");

    assert.equal(check.installed, true);
    assert.equal(check.install, undefined);
  });
});
