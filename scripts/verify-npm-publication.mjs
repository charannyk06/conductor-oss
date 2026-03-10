import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

function parseArgs(argv) {
  const options = {
    packageName: "",
    version: "",
    requireFiles: [],
    timeoutMs: 600_000,
    pollIntervalMs: 10_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--package") {
      options.packageName = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--version") {
      options.version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--require-file") {
      options.requireFiles.push(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.packageName) {
    throw new Error("Missing required --package.");
  }

  if (!options.version) {
    throw new Error("Missing required --version.");
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }

  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error(`Invalid --poll-interval-ms value: ${options.pollIntervalMs}`);
  }

  return options;
}

function encodePackageName(packageName) {
  return encodeURIComponent(packageName);
}

async function fetchPublishedMetadata(packageName, version) {
  const response = await fetch(`https://registry.npmjs.org/${encodePackageName(packageName)}/${encodeURIComponent(version)}`, {
    headers: { accept: "application/json" },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Registry metadata lookup failed for ${packageName}@${version}: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

async function checkTarball(url) {
  let response = await fetch(url, { method: "HEAD", redirect: "follow" });

  if (response.status === 405) {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    });
  }

  return response;
}

async function waitForPublication({ packageName, version, timeoutMs, pollIntervalMs }) {
  const startedAt = Date.now();
  let lastProblem = "package metadata not found";

  while (Date.now() - startedAt < timeoutMs) {
    const metadata = await fetchPublishedMetadata(packageName, version);
    if (metadata?.dist?.tarball) {
      const tarballResponse = await checkTarball(metadata.dist.tarball);
      if (tarballResponse.ok) {
        return metadata;
      }
      lastProblem = `tarball ${metadata.dist.tarball} returned ${tarballResponse.status} ${tarballResponse.statusText}`;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${packageName}@${version} to become downloadable: ${lastProblem}`);
}

async function downloadPublishedTarball({ packageName, version, tarballUrl, destinationDir }) {
  const response = await fetch(tarballUrl, {
    method: "GET",
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download tarball for ${packageName}@${version}: ${response.status} ${response.statusText}`);
  }

  const tarballPath = join(destinationDir, `${packageName.replaceAll("/", "-")}-${version}.tgz`);
  writeFileSync(tarballPath, Buffer.from(await response.arrayBuffer()));
  return tarballPath;
}

function unpackTarball(tarballPath, destinationDir) {
  execFileSync("tar", ["-xzf", tarballPath, "-C", destinationDir], {
    stdio: "pipe",
  });
}

function verifyExtractedPackage({ packageName, version, unpackRoot, requireFiles }) {
  const packageDir = join(unpackRoot, "package");
  const manifestPath = join(packageDir, "package.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Downloaded tarball for ${packageName}@${version} is missing package/package.json`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== packageName) {
    throw new Error(`Downloaded tarball name mismatch: expected ${packageName}, received ${manifest.name}`);
  }

  if (manifest.version !== version) {
    throw new Error(`Downloaded tarball version mismatch: expected ${version}, received ${manifest.version}`);
  }

  for (const relativePath of requireFiles) {
    if (!relativePath) {
      continue;
    }
    const requiredPath = join(packageDir, relativePath);
    if (!existsSync(requiredPath)) {
      throw new Error(`Downloaded tarball for ${packageName}@${version} is missing required file ${relativePath}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempDir = mkdtempSync(join(tmpdir(), "conductor-npm-publication-"));

  try {
    const metadata = await waitForPublication(options);
    const tarballPath = await downloadPublishedTarball({
      packageName: options.packageName,
      version: options.version,
      tarballUrl: metadata.dist.tarball,
      destinationDir: tempDir,
    });
    unpackTarball(tarballPath, tempDir);
    verifyExtractedPackage({
      packageName: options.packageName,
      version: options.version,
      unpackRoot: tempDir,
      requireFiles: options.requireFiles,
    });

    console.log(`Verified ${options.packageName}@${options.version} from ${metadata.dist.tarball}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
