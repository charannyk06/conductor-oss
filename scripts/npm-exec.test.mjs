import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveNpmCommand } from "./npm-exec.mjs";

function createFixturePath(name) {
  return join(tmpdir(), `npm-exec-${name}-${process.pid}-${Date.now()}`);
}

test("resolveNpmCommand avoids shell invocation on Unix-like platforms", () => {
  const rootDir = createFixturePath("unix");
  const binDir = join(rootDir, "bin");
  const npmCliPath = join(rootDir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(rootDir, "lib", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(binDir, "npm"), "#!/bin/sh\n");
  writeFileSync(npmCliPath, "console.log('npm');\n");

  const resolved = resolveNpmCommand("npm", {
    platform: "darwin",
    pathValue: binDir,
  });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [realpathSync(npmCliPath)]);
});

test("resolveNpmCommand resolves the Windows npm shim to npm-cli.js", () => {
  const rootDir = createFixturePath("win32");
  const npmCmdPath = join(rootDir, "npm.cmd");
  const npmCliPath = join(rootDir, "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(rootDir, "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(npmCmdPath, "@ECHO OFF\r\n");
  writeFileSync(npmCliPath, "console.log('npm');\n");

  const resolved = resolveNpmCommand("npm", {
    platform: "win32",
    pathValue: rootDir,
    pathExt: ".CMD;.EXE",
  });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [realpathSync(npmCliPath)]);
});

test("resolveNpmCommand preserves explicit command paths", () => {
  assert.deepEqual(resolveNpmCommand("/custom/npm", { platform: "win32" }), {
    command: "/custom/npm",
    argsPrefix: [],
  });
});
