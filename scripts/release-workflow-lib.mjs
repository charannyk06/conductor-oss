import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function tarArchiveInvocation(
  archivePath,
  beforeArchiveArgs,
  afterArchiveArgs = [],
  platform = process.platform,
) {
  // A drive-letter colon can be interpreted as remote-archive syntax. Run tar
  // from the archive directory and pass only its basename instead. This works
  // with both GNU tar from Git Bash and Windows' bsdtar.
  const pathApi = platform === "win32" ? win32 : posix;
  const resolvedArchivePath = pathApi.resolve(archivePath);
  return {
    args: [...beforeArchiveArgs, pathApi.basename(resolvedArchivePath), ...afterArchiveArgs],
    cwd: pathApi.dirname(resolvedArchivePath),
  };
}

export function execTarArchiveSync(
  archivePath,
  beforeArchiveArgs,
  afterArchiveArgs = [],
  options = {},
) {
  const invocation = tarArchiveInvocation(archivePath, beforeArchiveArgs, afterArchiveArgs);
  return execFileSync("tar", invocation.args, { ...options, cwd: invocation.cwd });
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function highestStableRegistryVersion(raw) {
  let versions;
  try {
    versions = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`npm returned invalid version JSON: ${error.message}`);
  }

  if (typeof versions === "string") {
    versions = [versions];
  }
  if (!Array.isArray(versions)) {
    throw new Error("npm version response must be a string or array");
  }

  const stable = versions
    .map((version) => String(version).trim())
    .filter((version) => STABLE_VERSION_RE.test(version))
    .sort(compareStableVersions);

  if (stable.length === 0) {
    throw new Error("npm returned no stable conductor-oss versions");
  }
  return stable.at(-1);
}

export function detectReleaseBump(commitBodies) {
  const bodies = Array.isArray(commitBodies)
    ? commitBodies.map((body) => String(body).replace(/^[\r\n]+/, ""))
    : String(commitBodies).split("\0").map((body) => body.replace(/^[\r\n]+/, ""));

  for (const body of bodies) {
    const subject = body.split(/\r?\n/, 1)[0] ?? "";
    if (/^[a-z]+(?:\([^)]*\))?!:/i.test(subject)) {
      return "major";
    }
    if (/^BREAKING(?: CHANGE|-CHANGE):/m.test(body)) {
      return "major";
    }
  }

  if (bodies.some((body) => /^feat(?:\([^)]*\))?:/i.test(body.split(/\r?\n/, 1)[0] ?? ""))) {
    return "minor";
  }
  return "patch";
}

export function calculateFileIntegrity(path, algorithm = "sha512") {
  return `${algorithm}-${createHash(algorithm).update(readFileSync(path)).digest("base64")}`;
}

export function assertArtifactIntegrity(path, expectedIntegrity) {
  if (typeof expectedIntegrity !== "string" || !expectedIntegrity.startsWith("sha512-")) {
    throw new Error("registry metadata is missing a sha512 integrity value");
  }
  const actualIntegrity = calculateFileIntegrity(path);
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(
      `artifact integrity mismatch for ${path}: expected ${expectedIntegrity}, got ${actualIntegrity}`,
    );
  }
  return actualIntegrity;
}

export function resolveExistingArtifact(path, expectedIntegrity, mode) {
  if (mode === "reject") {
    throw new Error("refusing an existing package version during a new release");
  }
  try {
    assertArtifactIntegrity(path, expectedIntegrity);
    return "verified";
  } catch (error) {
    if (mode !== "canonicalize") {
      throw error;
    }
    return "canonicalize";
  }
}

export function assertBundledDependencyVersions(packageManifest, bundledManifests) {
  const version = packageManifest?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("published package manifest is missing its version");
  }

  const bundleDependencies = packageManifest.bundleDependencies
    ?? packageManifest.bundledDependencies
    ?? [];
  if (!Array.isArray(bundleDependencies)) {
    throw new Error("published package bundleDependencies must be an array");
  }

  for (const dependencyName of bundleDependencies) {
    const declaredVersion = packageManifest.dependencies?.[dependencyName];
    if (declaredVersion !== version) {
      throw new Error(
        `bundled dependency ${dependencyName} must be declared at ${version} (found ${declaredVersion ?? "missing"})`,
      );
    }

    const bundledManifest = bundledManifests?.[dependencyName];
    if (!bundledManifest) {
      throw new Error(`bundled dependency ${dependencyName} is missing from the installed package`);
    }
    if (bundledManifest.name !== dependencyName) {
      throw new Error(
        `bundled dependency ${dependencyName} has package identity ${bundledManifest.name ?? "missing"}`,
      );
    }
    if (bundledManifest.version !== version) {
      throw new Error(
        `bundled dependency ${dependencyName} has version ${bundledManifest.version ?? "missing"}; expected ${version}`,
      );
    }
  }

  return bundleDependencies;
}

function bundledManifestEntry(dependencyName) {
  if (typeof dependencyName !== "string" || dependencyName.length === 0) {
    throw new Error("bundled dependency name must be a non-empty string");
  }
  const parts = dependencyName.split("/");
  const validShape = dependencyName.startsWith("@")
    ? parts.length === 2 && parts[0].length > 1 && parts[1].length > 0
    : parts.length === 1 && parts[0].length > 0;
  if (
    !validShape
    || parts.some((part) => part === "." || part === ".." || part.includes("\\") || part.includes("\0"))
  ) {
    throw new Error(`invalid bundled dependency name: ${dependencyName}`);
  }
  return `package/node_modules/${parts.join("/")}/package.json`;
}

export function assertBundledDependencyVersionsInTarball(path, { requiredDependencies = [] } = {}) {
  const packageManifest = readPackageManifestFromTarball(path);
  const bundleDependencies = packageManifest.bundleDependencies
    ?? packageManifest.bundledDependencies
    ?? [];
  if (!Array.isArray(bundleDependencies)) {
    throw new Error("published package bundleDependencies must be an array");
  }

  for (const dependencyName of requiredDependencies) {
    if (!bundleDependencies.includes(dependencyName)) {
      throw new Error(`published package is missing required bundled dependency ${dependencyName}`);
    }
  }

  const bundledManifests = {};
  for (const dependencyName of bundleDependencies) {
    const entry = bundledManifestEntry(dependencyName);
    let raw;
    try {
      raw = execTarArchiveSync(path, ["-xOf"], [entry], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error(`tarball ${path} is missing bundled manifest ${entry}`);
    }
    try {
      bundledManifests[dependencyName] = JSON.parse(raw);
    } catch (error) {
      throw new Error(`tarball ${path} has invalid JSON in ${entry}: ${error.message}`);
    }
  }

  assertBundledDependencyVersions(packageManifest, bundledManifests);
  return packageManifest;
}

function validateReleaseTarballPaths(path) {
  const entries = execTarArchiveSync(path, ["-tzf"], [], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\n").filter(Boolean);
  const seen = new Set();
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\/$/, "");
    const parts = entry.split("/");
    if (
      (entry !== "package" && !entry.startsWith("package/"))
      || entry.startsWith("/")
      || entry.includes("\\")
      || parts.some((part) => part === ".." || part === ".")
    ) {
      throw new Error(`tarball ${path} contains an unsafe entry: ${rawEntry}`);
    }
    if (seen.has(entry)) {
      throw new Error(`tarball ${path} contains duplicate entry ${entry}`);
    }
    seen.add(entry);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function collectRegularFileDigests(rootDir, relativeDir = "", result = new Map()) {
  const directory = join(rootDir, relativeDir);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const path = join(rootDir, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`release artifact contains unsupported symbolic link ${relativePath}`);
    }
    if (stat.isDirectory()) {
      collectRegularFileDigests(rootDir, relativePath, result);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`release artifact contains unsupported file type at ${relativePath}`);
    }

    let contents = readFileSync(path);
    if (relativePath === "package.json") {
      const manifest = JSON.parse(contents.toString("utf8"));
      delete manifest.name;
      delete manifest.publishConfig;
      contents = Buffer.from(JSON.stringify(canonicalJson(manifest)));
    }
    const digest = createHash("sha256").update(contents).digest("hex");
    result.set(relativePath, `${(stat.mode & 0o777).toString(8)}:${digest}`);
  }
  return result;
}

export function assertCliReleaseTarballEquivalence({ publicTarball, githubTarball, version }) {
  const publicManifest = readPackageManifestFromTarball(publicTarball);
  const githubManifest = readPackageManifestFromTarball(githubTarball);
  if (publicManifest.name !== "conductor-oss" || publicManifest.version !== version) {
    throw new Error(`public CLI artifact identity must be conductor-oss@${version}`);
  }
  if (githubManifest.name !== "@charannyk06/conductor-oss" || githubManifest.version !== version) {
    throw new Error(`GitHub CLI artifact identity must be @charannyk06/conductor-oss@${version}`);
  }

  validateReleaseTarballPaths(publicTarball);
  validateReleaseTarballPaths(githubTarball);
  const directory = mkdtempSync(join(tmpdir(), "conductor-cli-equivalence-"));
  const publicDir = join(directory, "public");
  const githubDir = join(directory, "github");
  mkdirSync(publicDir);
  mkdirSync(githubDir);
  try {
    execTarArchiveSync(publicTarball, ["-xzf"], ["-C", publicDir], { stdio: "pipe" });
    execTarArchiveSync(githubTarball, ["-xzf"], ["-C", githubDir], { stdio: "pipe" });
    const publicFiles = collectRegularFileDigests(join(publicDir, "package"));
    const githubFiles = collectRegularFileDigests(join(githubDir, "package"));
    const publicPaths = [...publicFiles.keys()].sort();
    const githubPaths = [...githubFiles.keys()].sort();
    if (JSON.stringify(publicPaths) !== JSON.stringify(githubPaths)) {
      throw new Error("public and GitHub CLI artifacts contain different file sets");
    }
    for (const path of publicPaths) {
      if (publicFiles.get(path) !== githubFiles.get(path)) {
        throw new Error(`public and GitHub CLI artifacts differ at ${path}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readPackageManifestFromTarball(path) {
  const raw = execTarArchiveSync(path, ["-xOf"], ["package/package.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const manifest = JSON.parse(raw);
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`tarball ${path} has an invalid package manifest`);
  }
  return manifest;
}

export function assertTarballFiles(path, requiredFiles) {
  if (!requiredFiles.length) {
    return;
  }
  const entries = new Set(
    execTarArchiveSync(path, ["-tzf"], [], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split("\n")
      .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
      .filter(Boolean),
  );
  for (const relativePath of requiredFiles) {
    if (!entries.has(`package/${relativePath}`)) {
      throw new Error(`tarball ${path} is missing required file ${relativePath}`);
    }
  }
}

export function isNpmNotFound(output) {
  return /(?:^|\s)E404(?:\s|$)|404 Not Found|is not in this registry/i.test(String(output));
}

export function parseNpmDistMetadata(raw) {
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`npm returned invalid dist metadata JSON: ${error.message}`);
  }

  if (typeof value?.integrity !== "string" || typeof value?.tarball !== "string") {
    throw new Error("npm dist metadata must contain integrity and tarball values");
  }
  const tarballUrl = new URL(value.tarball);
  if (tarballUrl.protocol !== "https:") {
    throw new Error("npm dist tarball URL must use HTTPS");
  }
  return { integrity: value.integrity, tarball: tarballUrl.toString() };
}

export function registryDownloadHeaders(tarball, registry, token) {
  if (!token) {
    return {};
  }
  const tarballUrl = new URL(tarball);
  const registryUrl = new URL(registry);
  return tarballUrl.origin === registryUrl.origin
    ? { authorization: `Bearer ${token}` }
    : {};
}
