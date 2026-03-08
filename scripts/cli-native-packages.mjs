import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const NPM_EXECUTABLE = process.platform === "win32" ? "npm.cmd" : "npm";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyOptionalFile(sourcePath, destinationPath) {
  if (!existsSync(sourcePath)) {
    return;
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath);
}

export const CLI_NATIVE_TARGETS = [
  {
    id: "darwin-universal",
    packageName: "@conductor-oss/native-darwin-universal",
    os: ["darwin"],
    cpu: ["arm64", "x64"],
    binaryName: "conductor",
    description: "Native Rust backend binary for conductor-oss on macOS (universal)",
  },
  {
    id: "linux-x64",
    packageName: "@conductor-oss/native-linux-x64",
    os: ["linux"],
    cpu: ["x64"],
    binaryName: "conductor",
    description: "Native Rust backend binary for conductor-oss on Linux x64",
  },
  {
    id: "win32-x64",
    packageName: "@conductor-oss/native-win32-x64",
    os: ["win32"],
    cpu: ["x64"],
    binaryName: "conductor.exe",
    description: "Native Rust backend binary for conductor-oss on Windows x64",
  },
];

export function findCliNativeTargetById(targetId) {
  return CLI_NATIVE_TARGETS.find((target) => target.id === targetId) ?? null;
}

export function resolveHostCliNativeTargetId() {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return "darwin-universal";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "win32-x64";
  }

  return null;
}

export function createCliNativeReleaseStage({
  rootDir = process.cwd(),
  targetId,
  binaryPath,
  stageDir,
} = {}) {
  if (!targetId) {
    throw new Error("Missing required native target id.");
  }
  if (!binaryPath) {
    throw new Error(`Missing required binaryPath for native target ${targetId}.`);
  }

  const target = findCliNativeTargetById(targetId);
  if (!target) {
    throw new Error(`Unknown native target id: ${targetId}`);
  }

  const resolvedRootDir = resolve(rootDir);
  const resolvedBinaryPath = resolve(binaryPath);
  const cliPackage = readJson(resolve(resolvedRootDir, "packages", "cli", "package.json"));

  if (!existsSync(resolvedBinaryPath)) {
    throw new Error(`Missing native binary for ${targetId} at ${resolvedBinaryPath}`);
  }

  const outputDir = stageDir
    ? resolve(stageDir)
    : mkdtempSync(join(tmpdir(), `conductor-native-${targetId}-`));

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, "bin"), { recursive: true });

  cpSync(resolvedBinaryPath, join(outputDir, "bin", target.binaryName));
  copyOptionalFile(resolve(resolvedRootDir, "README.md"), join(outputDir, "README.md"));
  copyOptionalFile(resolve(resolvedRootDir, "LICENSE"), join(outputDir, "LICENSE"));

  writeJson(join(outputDir, "package.json"), {
    name: target.packageName,
    version: cliPackage.version,
    license: cliPackage.license,
    private: false,
    os: target.os,
    cpu: target.cpu,
    files: ["bin/", "README.md", "LICENSE"],
    description: target.description,
    repository: cliPackage.repository,
    homepage: cliPackage.homepage,
    bugs: cliPackage.bugs,
  });

  return {
    stageDir: outputDir,
    version: cliPackage.version,
    packageName: target.packageName,
    target,
    binaryPath: resolvedBinaryPath,
  };
}

export function packCliNativeReleasePackage({
  rootDir = process.cwd(),
  targetId,
  binaryPath,
  stageDir,
  packDestination,
} = {}) {
  const stage = createCliNativeReleaseStage({ rootDir, targetId, binaryPath, stageDir });
  const destinationDir = packDestination ? resolve(packDestination) : stage.stageDir;
  mkdirSync(destinationDir, { recursive: true });

  const tarballName = execFileSync(NPM_EXECUTABLE, ["pack", "--silent", "--pack-destination", destinationDir], {
    cwd: stage.stageDir,
    encoding: "utf8",
  }).trim();

  return {
    ...stage,
    tarballPath: join(destinationDir, tarballName),
  };
}
