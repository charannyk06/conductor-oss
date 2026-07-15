#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findCliNativeTargetById } from "./cli-native-packages.mjs";
import { execTarArchiveSync, readPackageManifestFromTarball } from "./release-workflow-lib.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tarball") {
      options.tarball = argv[++index];
    } else if (argument === "--target") {
      options.targetId = argv[++index];
    } else if (argument === "--version") {
      options.version = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  for (const name of ["tarball", "targetId", "version"]) {
    if (!options[name]) {
      throw new Error(`missing required --${name === "targetId" ? "target" : name}`);
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const target = findCliNativeTargetById(options.targetId);
if (!target) {
  throw new Error(`unknown native target: ${options.targetId}`);
}

const tarball = resolve(options.tarball);
const manifest = readPackageManifestFromTarball(tarball);
if (manifest.name !== target.packageName) {
  throw new Error(`native package name is ${manifest.name}; expected ${target.packageName}`);
}
if (manifest.version !== options.version) {
  throw new Error(`native package version is ${manifest.version}; expected ${options.version}`);
}
for (const field of ["os", "cpu"]) {
  if (JSON.stringify(manifest[field]) !== JSON.stringify(target[field])) {
    throw new Error(
      `native package ${field} metadata is ${JSON.stringify(manifest[field])}; expected ${JSON.stringify(target[field])}`,
    );
  }
}

const extractDir = mkdtempSync(join(tmpdir(), `conductor-native-verify-${options.targetId}-`));
try {
  execTarArchiveSync(tarball, ["-xzf"], ["-C", extractDir], { stdio: "pipe" });
  const binaryPath = join(extractDir, "package", "bin", target.binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`native package is missing bin/${target.binaryName}`);
  }
  if (target.id === "darwin-universal" && process.platform !== "darwin") {
    throw new Error("darwin-universal artifacts must be verified on macOS");
  }
  const actualVersion = execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim();
  const expectedVersion = `conductor ${options.version}`;
  if (actualVersion !== expectedVersion) {
    throw new Error(`native package binary reports ${actualVersion || "no version"}; expected ${expectedVersion}`);
  }
  if (target.id === "darwin-universal") {
    execFileSync("lipo", [binaryPath, "-verify_arch", "x86_64", "arm64"], { stdio: "pipe" });
  }
} finally {
  rmSync(extractDir, { recursive: true, force: true });
}

console.log(`Verified ${target.packageName}@${options.version} and its packaged binary.`);
