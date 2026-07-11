import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

export function readPackageManifestFromTarball(path) {
  const raw = execFileSync("tar", ["-xOf", path, "package/package.json"], {
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
    execFileSync("tar", ["-tzf", path], {
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
