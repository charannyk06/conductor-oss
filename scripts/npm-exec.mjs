import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const WINDOWS_PATH_EXTENSIONS = [".cmd", ".exe", ".bat", ".com"];

function isBareCommand(command) {
  return !command.includes("/") && !command.includes("\\");
}

function normalizeWindowsPathExtensions(pathExt) {
  const normalized = [];
  const seen = new Set();

  for (const extension of pathExt.split(";").map((value) => value.trim()).filter(Boolean)) {
    const candidate = extension.startsWith(".")
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      normalized.push(candidate);
    }
  }

  return normalized;
}

function commandPathCandidates(
  executable,
  { platform = process.platform, pathExt = process.env.PATHEXT ?? WINDOWS_PATH_EXTENSIONS.join(";") } = {},
) {
  if (platform !== "win32" || !isBareCommand(executable)) {
    return [executable];
  }

  const lowerExecutable = executable.toLowerCase();
  const extensions = normalizeWindowsPathExtensions(pathExt);
  if (extensions.some((extension) => lowerExecutable.endsWith(extension))) {
    return [executable];
  }

  return extensions.map((extension) => `${executable}${extension}`);
}

function findCommandOnPath(
  executable,
  {
    platform = process.platform,
    pathValue = process.env.PATH ?? "",
    pathExt = process.env.PATHEXT ?? WINDOWS_PATH_EXTENSIONS.join(";"),
    pathExists = existsSync,
  } = {},
) {
  const candidates = commandPathCandidates(executable, { platform, pathExt });
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidateName of candidates) {
      const candidate = join(entry, candidateName);
      if (pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function safeRealpath(path, realpath = realpathSync) {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

function resolveNpmCliPath(
  npmCommandPath,
  {
    pathExists = existsSync,
    realpath = realpathSync,
  } = {},
) {
  const candidatePaths = [safeRealpath(npmCommandPath, realpath), npmCommandPath];
  const visited = new Set();

  for (const candidatePath of candidatePaths) {
    if (visited.has(candidatePath)) {
      continue;
    }
    visited.add(candidatePath);

    if (basename(candidatePath).toLowerCase() === "npm-cli.js" && pathExists(candidatePath)) {
      return candidatePath;
    }

    const candidateDir = dirname(candidatePath);
    for (const relativePath of [
      join("node_modules", "npm", "bin", "npm-cli.js"),
      join("..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]) {
      const npmCliPath = join(candidateDir, relativePath);
      if (pathExists(npmCliPath)) {
        return safeRealpath(npmCliPath, realpath);
      }
    }
  }

  return null;
}

export function resolveNpmCommand(
  executable = "npm",
  {
    platform = process.platform,
    pathValue = process.env.PATH ?? "",
    pathExt = process.env.PATHEXT ?? WINDOWS_PATH_EXTENSIONS.join(";"),
    pathExists = existsSync,
    realpath = realpathSync,
  } = {},
) {
  if (isBareCommand(executable) && executable === "npm") {
    const npmPath = findCommandOnPath(executable, {
      platform,
      pathValue,
      pathExt,
      pathExists,
    });
    const npmCliPath = npmPath
      ? resolveNpmCliPath(npmPath, {
        pathExists,
        realpath,
      })
      : null;
    if (npmCliPath) {
      return {
        command: process.execPath,
        argsPrefix: [npmCliPath],
      };
    }
  }

  return {
    command: executable,
    argsPrefix: [],
  };
}

export function execNpmCommandSync(
  executable,
  args,
  options = {},
) {
  const {
    env: optionEnv,
    platform,
    pathValue,
    pathExt,
    pathExists,
    realpath,
    ...execOptions
  } = options;
  const { command, argsPrefix } = resolveNpmCommand(executable, {
    platform,
    pathValue,
    pathExt,
    pathExists,
    realpath,
  });
  const npmCacheDir = join(tmpdir(), "conductor-npm-cache");
  mkdirSync(npmCacheDir, { recursive: true });
  const env = {
    ...process.env,
    ...optionEnv,
    npm_config_cache: optionEnv?.npm_config_cache ?? npmCacheDir,
  };
  return execFileSync(command, [...argsPrefix, ...args], { ...execOptions, env });
}
