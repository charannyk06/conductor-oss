#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  assertArtifactIntegrity,
  assertBundledDependencyVersionsInTarball,
  assertTarballFiles,
  isNpmNotFound,
  parseNpmDistMetadata,
  readPackageManifestFromTarball,
  registryDownloadHeaders,
  resolveExistingArtifact,
} from "./release-workflow-lib.mjs";

function parseArguments(argv) {
  const options = {
    allowMissing: false,
    onExisting: "verify",
    registry: "https://registry.npmjs.org",
    requireBundledDependencies: [],
    requireFiles: [],
    waitMs: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-missing") {
      options.allowMissing = true;
    } else if (argument === "--tarball") {
      options.tarball = argv[++index];
    } else if (argument === "--registry") {
      options.registry = argv[++index];
    } else if (argument === "--on-existing") {
      options.onExisting = argv[++index];
    } else if (argument === "--require-file") {
      options.requireFiles.push(argv[++index]);
    } else if (argument === "--require-bundled-dependency") {
      options.requireBundledDependencies.push(argv[++index]);
    } else if (argument === "--wait-ms") {
      options.waitMs = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!options.tarball) {
    throw new Error("missing required --tarball");
  }
  if (!["verify", "canonicalize", "reject"].includes(options.onExisting)) {
    throw new Error("--on-existing must be verify, canonicalize, or reject");
  }
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) {
    throw new Error("--wait-ms must be a non-negative number");
  }
  const registryUrl = new URL(options.registry);
  if (registryUrl.protocol !== "https:") {
    throw new Error("--registry must use HTTPS");
  }
  options.registry = registryUrl.toString();
  return options;
}

function queryDist(packageName, version, registry) {
  const result = spawnSync(
    "npm",
    ["view", `${packageName}@${version}`, "dist", "--json", "--registry", registry],
    { encoding: "utf8", env: process.env },
  );
  if (result.status === 0) {
    return { status: "found", metadata: parseNpmDistMetadata(result.stdout) };
  }
  const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (isNpmNotFound(diagnostic)) {
    return { status: "missing" };
  }
  throw new Error(
    `npm registry lookup failed for ${packageName}@${version}: ${diagnostic.trim() || `exit ${result.status}`}`,
  );
}

async function downloadCanonicalTarball(metadata, destination, registry) {
  const tarballUrl = new URL(metadata.tarball);
  const headers = registryDownloadHeaders(
    tarballUrl,
    registry,
    process.env.NODE_AUTH_TOKEN,
  );
  const response = await fetch(tarballUrl, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`failed to download canonical npm tarball: ${response.status} ${response.statusText}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  assertArtifactIntegrity(destination, metadata.integrity);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const expectedManifest = options.requireBundledDependencies.length > 0
    ? assertBundledDependencyVersionsInTarball(options.tarball, {
      requiredDependencies: options.requireBundledDependencies,
    })
    : readPackageManifestFromTarball(options.tarball);
  assertTarballFiles(options.tarball, options.requireFiles);
  const startedAt = Date.now();

  while (true) {
    const result = queryDist(expectedManifest.name, expectedManifest.version, options.registry);
    if (result.status === "missing") {
      if (options.waitMs > 0 && Date.now() - startedAt < options.waitMs) {
        await sleep(Math.min(10_000, options.waitMs));
        continue;
      }
      if (options.allowMissing) {
        process.stdout.write("missing\n");
        return;
      }
      throw new Error(`${expectedManifest.name}@${expectedManifest.version} is not published`);
    }

    let resolution;
    try {
      resolution = resolveExistingArtifact(
        options.tarball,
        result.metadata.integrity,
        options.onExisting,
      );
    } catch (error) {
      if (options.onExisting === "reject") {
        throw new Error(
          `${expectedManifest.name}@${expectedManifest.version} already exists; refusing a new release collision`,
          { cause: error },
        );
      }
      throw error;
    }
    if (resolution === "verified") {
      process.stdout.write("verified\n");
      return;
    }

    const directory = mkdtempSync(join(tmpdir(), "conductor-release-canonical-"));
    const canonicalPath = join(directory, "package.tgz");
    try {
      await downloadCanonicalTarball(result.metadata, canonicalPath, options.registry);
      const canonicalManifest = readPackageManifestFromTarball(canonicalPath);
      if (
        canonicalManifest.name !== expectedManifest.name
        || canonicalManifest.version !== expectedManifest.version
      ) {
        throw new Error("canonical npm tarball package identity does not match the release artifact");
      }
      assertTarballFiles(canonicalPath, options.requireFiles);
      if (options.requireBundledDependencies.length > 0) {
        assertBundledDependencyVersionsInTarball(canonicalPath, {
          requiredDependencies: options.requireBundledDependencies,
        });
      }
      copyFileSync(canonicalPath, options.tarball);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write("canonicalized\n");
    return;
  }
}

await main();
