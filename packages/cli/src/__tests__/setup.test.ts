import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAgentCheck,
  resolveAgentSetupConfig,
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

test("Pi setup metadata points at the official package", () => {
  const config = resolveAgentSetupConfig("pi");

  assert.deepEqual(config.commands, ["pi"]);
  assert.equal(config.installPackage, "@mariozechner/pi-coding-agent");
  assert.deepEqual(config.postInstallAuthCommand, {
    label: "Run Pi setup",
    cmd: "pi",
    args: [],
  });
});

test("buildAgentCheck treats the pi binary as an installed Pi CLI", () => {
  withTemporaryPath(["npm", "pi"], () => {
    const check = buildAgentCheck("pi");

    assert.equal(check.installed, true);
    assert.equal(check.install, undefined);
    assert.equal(check.postInstallAuthCommand, undefined);
  });
});

test("Hermes setup metadata points at the official installer and setup command", () => {
  const config = resolveAgentSetupConfig("hermes");

  assert.deepEqual(config.commands, ["hermes", "hermes-agent"]);
  assert.deepEqual(config.installCommand, {
    label: "Install Hermes",
    cmd: "sh",
    args: [
      "-lc",
      "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    ],
  });
  assert.deepEqual(config.postInstallAuthCommand, {
    label: "Run Hermes setup",
    cmd: "hermes",
    args: ["setup"],
  });
});

test("buildAgentCheck treats the hermes binary as an installed Hermes CLI", () => {
  withTemporaryPath(["hermes"], () => {
    const check = buildAgentCheck("hermes");

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
