import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { packCliReleasePackage } from "./cli-release-stage.mjs";

function fail(message) {
  console.error(`release preflight failed: ${message}`);
  process.exit(1);
}

async function waitForDashboard(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

const rootDir = resolve(process.cwd());
const packDir = mkdtempSync(join(tmpdir(), "conductor-cli-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "conductor-cli-install-"));
const repoDir = mkdtempSync(join(tmpdir(), "conductor-cli-repo-"));
let dashboardProcess = null;

try {
  const { tarballPath } = packCliReleasePackage({ rootDir, packDestination: packDir });
  execFileSync("npm", ["init", "-y"], {
    cwd: installDir,
    stdio: "ignore",
  });
  execFileSync("npm", ["install", "--silent", tarballPath], {
    cwd: installDir,
    stdio: "inherit",
  });
  execFileSync("node", ["node_modules/conductor-oss/dist/index.js", "--version"], {
    cwd: installDir,
    stdio: "inherit",
  });

  const installedDashboardRoot = join(installDir, "node_modules", "conductor-oss", "web", ".next", "standalone");
  if (!existsSync(installedDashboardRoot)) {
    fail("installed CLI package is missing the dashboard standalone directory");
  }

  const installedDashboardServer = join(
    installDir,
    "node_modules",
    "conductor-oss",
    "web",
    ".next",
    "standalone",
    "packages",
    "web",
    "server.js",
  );
  if (!existsSync(installedDashboardServer)) {
    fail("installed CLI package is missing the dashboard server entrypoint");
  }

  const bundledCorePackage = join(
    installDir,
    "node_modules",
    "conductor-oss",
    "node_modules",
    "@conductor-oss",
    "core",
    "package.json",
  );
  if (!existsSync(bundledCorePackage)) {
    fail("installed CLI package is missing bundled internal runtime packages");
  }

  execFileSync(
    "node",
    [
      "node_modules/conductor-oss/dist/index.js",
      "init",
      "--path",
      repoDir,
      "--project-id",
      "release-smoke",
      "--display-name",
      "Release Smoke",
      "--repo",
      "example/release-smoke",
      "--default-branch",
      "main",
    ],
    {
      cwd: installDir,
      stdio: "inherit",
    },
  );

  const configPath = join(repoDir, "conductor.yaml");
  const configContents = readFileSync(configPath, "utf8").replace(/^port:\s*4747$/m, "port: 4111");
  writeFileSync(configPath, configContents, "utf8");

  dashboardProcess = spawn(
    "node",
    [
      "node_modules/conductor-oss/dist/index.js",
      "start",
      "--no-watcher",
      "--port",
      "4111",
      "--workspace",
      repoDir,
    ],
    {
      cwd: installDir,
      env: {
        ...process.env,
        CO_CONFIG_PATH: configPath,
        CONDUCTOR_WORKSPACE: repoDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let bufferedStdout = "";
  let bufferedStderr = "";
  dashboardProcess.stdout?.on("data", (chunk) => {
    bufferedStdout += chunk.toString();
  });
  dashboardProcess.stderr?.on("data", (chunk) => {
    bufferedStderr += chunk.toString();
  });

  await waitForDashboard("http://127.0.0.1:4111/api/config", 20000);

  if (dashboardProcess.exitCode !== null && dashboardProcess.exitCode !== 0) {
    fail(`packaged dashboard process exited early with code ${dashboardProcess.exitCode}\n${bufferedStdout}\n${bufferedStderr}`);
  }

  console.log("release preflight passed");
} catch (error) {
  if (error instanceof Error) {
    fail(error.message);
  }
  fail(String(error));
} finally {
  if (dashboardProcess && dashboardProcess.exitCode === null) {
    dashboardProcess.kill("SIGTERM");
    await sleep(1000);
    if (dashboardProcess.exitCode === null) {
      dashboardProcess.kill("SIGKILL");
    }
  }
  rmSync(packDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
}
