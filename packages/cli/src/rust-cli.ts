import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RustCliLaunch {
  cmd: string;
  argsPrefix: string[];
  cwd: string;
  label: string;
}

function isRepoCargoRoot(candidate: string): boolean {
  return existsSync(join(candidate, "Cargo.toml"))
    && existsSync(join(candidate, "crates", "conductor-cli", "Cargo.toml"));
}

function findRepoCargoRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (isRepoCargoRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
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

function resolveBundledRustCliBinary(moduleDir: string): string | null {
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

  const candidates = [
    resolve(moduleDir, "..", "..", "native", binaryName),
    resolve(moduleDir, "..", "..", "..", "native", binaryName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveRustCliLaunch(): RustCliLaunch {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoCargoRoot(process.cwd())
    ?? findRepoCargoRoot(moduleDir)
    ?? findRepoCargoRoot(resolve(moduleDir, "..", "..", ".."));

  if (repoRoot) {
    const binaryName = process.platform === "win32" ? "conductor.exe" : "conductor";
    const prebuiltBinary = resolveNewestExistingBinary([
      join(repoRoot, "target", "debug", binaryName),
      join(repoRoot, "target", "release", binaryName),
    ]);

    if (prebuiltBinary) {
      return {
        cmd: prebuiltBinary,
        argsPrefix: [],
        cwd: repoRoot,
        label: "prebuilt Rust CLI",
      };
    }

    return {
      cmd: "cargo",
      argsPrefix: ["run", "-p", "conductor-cli", "--"],
      cwd: repoRoot,
      label: "cargo-run Rust CLI",
    };
  }

  const bundledBinary = resolveBundledRustCliBinary(moduleDir);
  if (bundledBinary) {
    return {
      cmd: bundledBinary,
      argsPrefix: [],
      cwd: dirname(bundledBinary),
      label: "bundled Rust CLI",
    };
  }

  throw new Error("Rust CLI was not found. Build the workspace or run from a source checkout.");
}

export function rustCliGlobalArgs(): string[] {
  const args: string[] = [];
  const workspace = process.env["CONDUCTOR_WORKSPACE"]?.trim();
  const configPath = process.env["CO_CONFIG_PATH"]?.trim();

  if (workspace) {
    args.push("--workspace", workspace);
  }
  if (configPath) {
    args.push("--config", configPath);
  }

  return args;
}
