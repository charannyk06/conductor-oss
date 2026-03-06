import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { packCliReleasePackage } from "./cli-release-stage.mjs";

function fail(message) {
  throw new Error(`release preflight failed: ${message}`);
}

function createTempDir(prefix, tempDirs) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function getInstalledCliEntry(installDir) {
  return join(installDir, "node_modules", "conductor-oss", "dist", "index.js");
}

function readTextFile(path) {
  return readFileSync(path, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlContainsProject(content, projectId) {
  return new RegExp(`(^|\\n)  ${escapeRegExp(projectId)}:`, "m").test(content);
}

function spawnInstalledCli(installDir, args, options = {}) {
  const cliEntry = getInstalledCliEntry(installDir);
  const child = spawn("node", [cliEntry, ...args], {
    cwd: installDir,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  let bufferedStdout = "";
  let bufferedStderr = "";
  child.stdout?.on("data", (chunk) => {
    bufferedStdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    bufferedStderr += chunk.toString();
  });

  return {
    child,
    getLogs() {
      return `${bufferedStdout}\n${bufferedStderr}`.trim();
    },
  };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await sleep(1000);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
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

async function waitForCondition(description, check, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      // Condition is not ready yet.
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function verifyDashboardAssets(baseUrl) {
  const response = await fetch(baseUrl);
  if (!response.ok) {
    throw new Error(`dashboard home page returned ${response.status}`);
  }

  const html = await response.text();
  const assetPaths = [...html.matchAll(/(?:href|src)=\"(\/_next\/static\/[^\"]+)\"/g)]
    .map((match) => match[1])
    .filter(Boolean);

  if (assetPaths.length === 0) {
    throw new Error("dashboard home page did not reference any static assets");
  }

  for (const assetPath of assetPaths.slice(0, 5)) {
    await waitForCondition(`dashboard asset ${assetPath}`, async () => {
      const assetResponse = await fetch(new URL(assetPath, baseUrl));
      return assetResponse.ok;
    }, 10_000);
  }
}

async function withBrowser(run) {
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

async function clickButtonByText(page, label) {
  await page.evaluate((expectedLabel) => {
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      return candidate.textContent?.trim() === expectedLabel && !candidate.disabled;
    });

    if (!button) {
      throw new Error(`Button not found: ${expectedLabel}`);
    }

    button.click();
  }, label);
}

async function fillInput(page, selector, value) {
  const isMac = process.platform === "darwin";
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.down(isMac ? "Meta" : "Control");
  await page.keyboard.press("A");
  await page.keyboard.up(isMac ? "Meta" : "Control");
  await page.keyboard.press("Backspace");
  if (String(value).length > 0) {
    await page.type(selector, String(value));
  }
}

async function clickOnboardingPrimaryAction(page) {
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((candidate) => {
      const label = candidate.textContent?.trim();
      return (label === "Continue" || label === "Finish Setup") && !candidate.disabled;
    }),
    { timeout: 20_000 },
  );

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => {
      const label = candidate.textContent?.trim();
      return (label === "Continue" || label === "Finish Setup") && !candidate.disabled;
    });

    if (!button) {
      throw new Error("Onboarding action button not found");
    }

    button.click();
  });
}

async function verifyFirstRunOnboarding(baseUrl) {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.body?.innerText?.includes("Choose your preferences"),
      { timeout: 20_000 },
    );

    await clickButtonByText(page, "Claude Code");
    await clickButtonByText(page, "Cursor");
    await clickButtonByText(page, "Notion");
    await clickButtonByText(page, "No sound");
    await fillInput(page, 'input[placeholder="e.g., conductor-dev or 203.0.113.10"]', "conductor-dev");
    await fillInput(page, 'input[placeholder="e.g., ubuntu"]', "pm");
    await clickOnboardingPrimaryAction(page);

    await page.waitForFunction(
      () => document.body?.innerText?.includes("Add Workspace"),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => document.body?.innerText?.includes("Local Folder")
        && document.body?.innerText?.includes("Git Repository"),
      { timeout: 10_000 },
    );

    if (pageErrors.length > 0) {
      throw new Error(`browser onboarding triggered runtime errors: ${pageErrors.join("; ")}`);
    }
  });
}

async function verifyConfiguredWorkspaceOnboarding(baseUrl) {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.body?.innerText?.includes("Choose your preferences"),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => document.body?.innerText?.includes("Step 1 of 2"),
      { timeout: 10_000 },
    );

    await clickButtonByText(page, "Cursor");
    await clickButtonByText(page, "Notion");
    await clickButtonByText(page, "No sound");
    await fillInput(page, 'input[placeholder="e.g., conductor-dev or 203.0.113.10"]', "conductor-dev");
    await fillInput(page, 'input[placeholder="e.g., ubuntu"]', "pm");
    await clickButtonByText(page, "Continue");

    await page.waitForFunction(
      () => document.body?.innerText?.includes("Review repository defaults"),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => document.body?.innerText?.includes("Step 2 of 2"),
      { timeout: 10_000 },
    );

    await fillInput(page, 'input[placeholder="e.g., your-org/your-repo"]', "example/release-smoke-onboarded");
    await clickButtonByText(page, "Finish Setup");

    await page.waitForFunction(
      () => !document.body?.innerText?.includes("Review repository defaults")
        && !document.body?.innerText?.includes("Finish Setup"),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => document.body?.innerText?.includes("What would you like to work on?"),
      { timeout: 20_000 },
    );

    if (pageErrors.length > 0) {
      throw new Error(`browser onboarding triggered runtime errors: ${pageErrors.join("; ")}`);
    }
  });
}

async function verifyDashboardReadyState(baseUrl) {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.body?.innerText?.includes("What would you like to work on?"),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => !document.body?.innerText?.includes("Choose your preferences"),
      { timeout: 10_000 },
    );
  });
}

async function verifyBrowserFirstLauncherFlow(installDir, tempDirs) {
  const homeDir = createTempDir("conductor-cli-home-", tempDirs);
  const projectDir = createTempDir("conductor-cli-project-", tempDirs);
  const baseUrl = "http://127.0.0.1:4747";

  const launcher = spawnInstalledCli(installDir, [], {
    env: {
      ...process.env,
      HOME: homeDir,
    },
  });

  try {
    await waitForDashboard(`${baseUrl}/api/config`, 25_000);
    await verifyDashboardAssets(baseUrl);
    await verifyFirstRunOnboarding(baseUrl);

    const bootstrapWorkspace = join(homeDir, ".openclaw", "workspace");
    const bootstrapConfigPath = join(bootstrapWorkspace, "conductor.yaml");
    const bootstrapBoardPath = join(bootstrapWorkspace, "CONDUCTOR.md");

    if (!existsSync(bootstrapConfigPath)) {
      throw new Error("bare launcher did not create ~/.openclaw/workspace/conductor.yaml");
    }
    if (!existsSync(bootstrapBoardPath)) {
      throw new Error("bare launcher did not create ~/.openclaw/workspace/CONDUCTOR.md");
    }

    await waitForCondition("first-run preferences to persist", async () => {
      const { response, payload } = await fetchJson(`${baseUrl}/api/preferences`);
      if (!response.ok) return false;

      const preferences = payload?.preferences;
      return preferences?.onboardingAcknowledged === true
        && preferences?.codingAgent === "claude-code"
        && preferences?.ide === "cursor"
        && preferences?.markdownEditor === "notion"
        && preferences?.notifications?.soundEnabled === false
        && preferences?.remoteSshHost === "conductor-dev"
        && preferences?.remoteSshUser === "pm";
    });

    const createWorkspaceResult = await fetchJson(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "local",
        path: projectDir,
        defaultBranch: "main",
        agent: "claude-code",
        initializeGit: true,
        useWorktree: true,
      }),
    });

    if (!createWorkspaceResult.response.ok) {
      throw new Error(
        `browser-first project creation failed (${createWorkspaceResult.response.status}): ${createWorkspaceResult.payload?.error ?? "unknown error"}`,
      );
    }

    const createdProjectId = createWorkspaceResult.payload?.project?.id;
    if (typeof createdProjectId !== "string" || createdProjectId.trim().length === 0) {
      throw new Error("browser-first project creation did not return a project id");
    }

    const projectBoardPath = join(projectDir, "CONDUCTOR.md");
    const projectConfigPath = join(projectDir, "conductor.yaml");
    const projectTagsPath = join(projectDir, "CONDUCTOR-TAGS.md");
    const projectSnippetsPath = join(projectDir, ".vscode", "conductor.code-snippets");
    const workspaceTagsPath = join(bootstrapWorkspace, "CONDUCTOR-TAGS.md");
    const workspaceSnippetsPath = join(bootstrapWorkspace, ".vscode", "conductor.code-snippets");

    await waitForCondition("project scaffolding to be written", async () => {
      return existsSync(projectBoardPath)
        && existsSync(projectConfigPath)
        && existsSync(projectTagsPath)
        && existsSync(projectSnippetsPath)
        && existsSync(workspaceTagsPath)
        && existsSync(workspaceSnippetsPath);
    });

    const boardContents = readFileSync(projectBoardPath, "utf8");
    if (!boardContents.includes(`#project/${createdProjectId}`)) {
      throw new Error("generated CONDUCTOR.md is missing the project tag");
    }

    const projectTags = readTextFile(projectTagsPath);
    if (!projectTags.includes(`#project/${createdProjectId}`)) {
      throw new Error("generated CONDUCTOR-TAGS.md is missing the project tag");
    }

    const projectSnippets = readTextFile(projectSnippetsPath);
    if (!projectSnippets.includes(createdProjectId)) {
      throw new Error("generated VS Code snippets are missing the project id");
    }

    await waitForCondition("repo-local config to reflect onboarding preferences", async () => {
      const projectYaml = readTextFile(projectConfigPath);
      return yamlContainsProject(projectYaml, createdProjectId)
        && projectYaml.includes("codingAgent: claude-code")
        && projectYaml.includes("ide: cursor")
        && projectYaml.includes("markdownEditor: notion")
        && projectYaml.includes("soundEnabled: false")
        && projectYaml.includes("remoteSshHost: conductor-dev")
        && projectYaml.includes("remoteSshUser: pm")
        && projectYaml.includes(`path: ${projectDir}`)
        && projectYaml.includes("agent: claude-code");
    });

    const repositoriesResult = await fetchJson(`${baseUrl}/api/repositories`);
    if (!repositoriesResult.response.ok) {
      throw new Error(`failed to load repositories after first-run setup (${repositoriesResult.response.status})`);
    }

    const repository = repositoriesResult.payload?.repositories?.find((item) => item.id === createdProjectId);
    if (!repository) {
      throw new Error("new project was not exposed through /api/repositories");
    }

    const updateRepositoryResult = await fetchJson(`${baseUrl}/api/repositories`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: repository.id,
        displayName: repository.displayName,
        repo: "example/browser-first-smoke",
        path: repository.path,
        agent: repository.agent,
        defaultWorkingDirectory: "app",
        defaultBranch: repository.defaultBranch,
        devServerScript: repository.devServerScript,
        setupScript: repository.setupScript,
        runSetupInParallel: repository.runSetupInParallel,
        cleanupScript: repository.cleanupScript,
        archiveScript: repository.archiveScript,
        copyFiles: repository.copyFiles,
      }),
    });

    if (!updateRepositoryResult.response.ok) {
      throw new Error(
        `repository settings update failed (${updateRepositoryResult.response.status}): ${updateRepositoryResult.payload?.error ?? "unknown error"}`,
      );
    }

    await waitForCondition("repo-local config to reflect repository settings", async () => {
      const projectYaml = readTextFile(projectConfigPath);
      return yamlContainsProject(projectYaml, createdProjectId)
        && projectYaml.includes("repo: example/browser-first-smoke")
        && projectYaml.includes("defaultWorkingDirectory: app");
    });

    const updatePreferencesResult = await fetchJson(`${baseUrl}/api/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        onboardingAcknowledged: true,
        codingAgent: "claude-code",
        ide: "vscode",
        remoteSshHost: "conductor-prod",
        remoteSshUser: "pm-team",
        markdownEditor: "obsidian",
        notifications: {
          soundEnabled: true,
          soundFile: "abstract-sound-4",
        },
      }),
    });

    if (!updatePreferencesResult.response.ok) {
      throw new Error(
        `preferences update failed (${updatePreferencesResult.response.status}): ${updatePreferencesResult.payload?.error ?? "unknown error"}`,
      );
    }

    await waitForCondition("repo-local config to reflect preferences updates", async () => {
      const projectYaml = readTextFile(projectConfigPath);
      return projectYaml.includes("codingAgent: claude-code")
        && projectYaml.includes("ide: vscode")
        && projectYaml.includes("markdownEditor: obsidian")
        && projectYaml.includes("soundEnabled: true")
        && projectYaml.includes("soundFile: abstract-sound-4")
        && projectYaml.includes("remoteSshHost: conductor-prod")
        && projectYaml.includes("remoteSshUser: pm-team");
    });

    const spawnResult = await fetchJson(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: createdProjectId,
        prompt: "Smoke test the agent launcher",
        agent: "codex",
      }),
    });

    if (spawnResult.response.status === 404 || spawnResult.response.status === 400) {
      throw new Error(
        `spawn endpoint rejected dashboard launch inputs (${spawnResult.response.status}): ${spawnResult.payload?.error ?? "unknown error"}`,
      );
    }

    await waitForCondition("repo-local config to reflect spawn agent selection", async () => {
      const projectYaml = readTextFile(projectConfigPath);
      return projectYaml.includes("codingAgent: codex")
        && yamlContainsProject(projectYaml, createdProjectId)
        && projectYaml.includes("agent: codex");
    });

    const createdSessionId = spawnResult.payload?.session?.id;
    if (typeof createdSessionId === "string" && createdSessionId.length > 0) {
      await fetch(`${baseUrl}/api/sessions/${createdSessionId}/kill`, {
        method: "POST",
      }).catch(() => {
        // Best-effort cleanup.
      });
    }

    const bootstrapConfig = readTextFile(bootstrapConfigPath);
    if (!yamlContainsProject(bootstrapConfig, createdProjectId) || !bootstrapConfig.includes(`path: ${projectDir}`)) {
      throw new Error("home workspace config did not retain the created project");
    }

    await verifyDashboardReadyState(baseUrl);

    if (launcher.child.exitCode !== null && launcher.child.exitCode !== 0) {
      throw new Error(`bare launcher exited early with code ${launcher.child.exitCode}\n${launcher.getLogs()}`);
    }
  } finally {
    await stopProcess(launcher.child);
  }
}

async function verifyConfiguredWorkspaceFlow(installDir, tempDirs) {
  const repoDir = createTempDir("conductor-cli-repo-", tempDirs);
  const baseUrl = "http://127.0.0.1:4111";

  execFileSync("git", ["init", "-b", "main", repoDir], {
    cwd: installDir,
    stdio: "ignore",
  });

  execFileSync(
    "node",
    [
      getInstalledCliEntry(installDir),
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

  execFileSync(
    "node",
    [
      getInstalledCliEntry(installDir),
      "doctor",
      "--workspace",
      repoDir,
      "--json",
    ],
    {
      cwd: installDir,
      stdio: "inherit",
    },
  );

  const dashboard = spawnInstalledCli(installDir, [
    "start",
    "--no-watcher",
    "--port",
    "4111",
    "--workspace",
    repoDir,
  ], {
    env: {
      ...process.env,
      CONDUCTOR_WORKSPACE: repoDir,
      CO_CONFIG_PATH: configPath,
    },
  });

  try {
    await waitForDashboard(`${baseUrl}/api/config`, 20_000);
    await verifyDashboardAssets(baseUrl);
    await verifyConfiguredWorkspaceOnboarding(baseUrl);

    let preferences = null;
    await waitForCondition("configured-workspace onboarding preferences to persist", async () => {
      const { response, payload } = await fetchJson(`${baseUrl}/api/preferences`);
      if (!response.ok) {
        return false;
      }

      const nextPreferences = payload?.preferences;
      if (!nextPreferences?.onboardingAcknowledged) return false;
      if (nextPreferences.ide !== "cursor") return false;
      if (nextPreferences.markdownEditor !== "notion") return false;
      if (nextPreferences.notifications?.soundEnabled !== false) return false;
      if (nextPreferences.remoteSshHost !== "conductor-dev" || nextPreferences.remoteSshUser !== "pm") return false;

      preferences = nextPreferences;
      return true;
    });

    if (!preferences) {
      throw new Error("configured-workspace onboarding preferences were not available after persistence wait");
    }

    let repository = null;
    await waitForCondition("configured-workspace repository settings to persist", async () => {
      const { response, payload } = await fetchJson(`${baseUrl}/api/repositories`);
      if (!response.ok) {
        return false;
      }

      const nextRepository = payload?.repositories?.[0];
      if (!nextRepository) {
        return false;
      }
      if (nextRepository.repo !== "example/release-smoke-onboarded") {
        return false;
      }

      repository = nextRepository;
      return true;
    });

    if (!repository) {
      throw new Error("configured-workspace repository settings were not available after onboarding persistence wait");
    }

    if (dashboard.child.exitCode !== null && dashboard.child.exitCode !== 0) {
      throw new Error(`configured-workspace dashboard exited early with code ${dashboard.child.exitCode}\n${dashboard.getLogs()}`);
    }
  } finally {
    await stopProcess(dashboard.child);
  }
}

const rootDir = resolve(process.cwd());
const tempDirs = [];
const packDir = createTempDir("conductor-cli-pack-", tempDirs);
const installDir = createTempDir("conductor-cli-install-", tempDirs);
let exitCode = 0;

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
  execFileSync("node", [getInstalledCliEntry(installDir), "--version"], {
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

  await verifyBrowserFirstLauncherFlow(installDir, tempDirs);
  await verifyConfiguredWorkspaceFlow(installDir, tempDirs);

  console.log("release preflight passed");
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}
