import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createCliReleaseStage } from "./cli-release-stage.mjs";

function readPublishedVersion(packageName) {
  try {
    return execFileSync("npm", ["view", packageName, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function ensureGitTag(rootDir, tagName) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", tagName], {
      cwd: rootDir,
      stdio: "ignore",
    });
  } catch {
    execFileSync("git", ["tag", "-a", tagName, "-m", tagName], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }
}

const rootDir = resolve(process.cwd());
const { stageDir, packageName, version } = createCliReleaseStage({ rootDir });
const tagName = `${packageName}@${version}`;

try {
  const publishedVersion = readPublishedVersion(packageName);
  if (publishedVersion === version) {
    console.log(`${packageName}@${version} is already published`);
    ensureGitTag(rootDir, tagName);
    process.exit(0);
  }

  execFileSync("npm", ["publish", "--access", "public"], {
    cwd: stageDir,
    stdio: "inherit",
  });
  ensureGitTag(rootDir, tagName);
} finally {
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
