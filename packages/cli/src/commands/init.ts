/**
 * `co init`
 *
 * Scaffolds a new Conductor workspace with a CONDUCTOR.md kanban board
 * and a conductor.yaml config file. Dead-simple onboarding.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { buildConductorBoard, buildConductorYaml } from "@conductor-oss/core";

export type InitOptions = {
  force?: boolean;
  projectId?: string;
  displayName?: string;
  repo?: string;
  path?: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  ide?: string;
  markdownEditor?: string;
  defaultBranch?: string;
  defaultWorkingDirectory?: string;
  dashboardUrl?: string;
};

export type InitProjectConfig = {
  projectId: string;
  displayName: string;
  repo: string;
  path: string;
  agent: string;
  agentModel: string | null;
  agentReasoningEffort: string | null;
  ide: string;
  markdownEditor: string;
  defaultBranch: string;
  defaultWorkingDirectory: string | null;
  dashboardUrl: string | null;
};

function slugifyProjectId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "my-app";
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function parseRepoSlug(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;

  const sshMatch = remoteUrl.match(/^git@[^:]+:(.+)$/);
  const candidate = sshMatch ? sshMatch[1] : remoteUrl;

  try {
    const parsed = new URL(candidate);
    return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "") || null;
  } catch {
    return candidate.replace(/\.git$/i, "").replace(/^\/+/, "") || null;
  }
}

function detectDefaultBranch(repoPath: string): string | null {
  const remoteHead = runGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    return remoteHead.replace(/^origin\//, "");
  }

  return runGit(repoPath, ["branch", "--show-current"]);
}

export function resolveInitProjectConfig(cwd: string, options: InitOptions): InitProjectConfig {
  const repoPath = resolve(cwd, options.path?.trim() || ".");
  const detectedRepo = parseRepoSlug(runGit(repoPath, ["remote", "get-url", "origin"]));
  const detectedBranch = detectDefaultBranch(repoPath);
  const detectedName = basename(repoPath);
  const repoSlug = options.repo?.trim() || detectedRepo || `your-org/${detectedName}`;
  const displayName = options.displayName?.trim() || detectedName;
  const projectId = options.projectId?.trim() || slugifyProjectId(repoSlug.split("/").pop() || detectedName);
  const agent = options.agent?.trim() || "claude-code";
  const agentModel = options.model?.trim() || null;
  const agentReasoningEffort = options.reasoningEffort?.trim().toLowerCase() || null;
  const ide = options.ide?.trim() || "vscode";
  const markdownEditor = options.markdownEditor?.trim() || "obsidian";
  const defaultBranch = options.defaultBranch?.trim() || detectedBranch || "main";
  const defaultWorkingDirectory = options.defaultWorkingDirectory?.trim() || null;
  const dashboardUrl = options.dashboardUrl?.trim() || null;

  return {
    projectId,
    displayName,
    repo: repoSlug,
    path: repoPath,
    agent,
    agentModel,
    agentReasoningEffort,
    ide,
    markdownEditor,
    defaultBranch,
    defaultWorkingDirectory,
    dashboardUrl,
  };
}

export function runInitScaffold(cwd: string, opts: InitOptions): {
  created: number;
  project: InitProjectConfig;
  boardPath: string;
  configPath: string;
} {
  const project = resolveInitProjectConfig(cwd, opts);
  const boardPath = resolve(project.path, "CONDUCTOR.md");
  const configPath = resolve(project.path, "conductor.yaml");

  let created = 0;

  if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
    throw new Error(`Repository path does not exist: ${project.path}`);
  }

  if (!existsSync(boardPath) || opts.force) {
    writeFileSync(boardPath, buildConductorBoard(project.projectId, project.displayName), "utf-8");
    console.log(chalk.green("✔") + "  Created CONDUCTOR.md");
    created++;
  } else {
    console.log(chalk.dim("  CONDUCTOR.md already exists (use --force to overwrite)"));
  }

  if (!existsSync(configPath) || opts.force) {
    writeFileSync(configPath, buildConductorYaml({
      dashboardUrl: project.dashboardUrl,
      preferences: {
        onboardingAcknowledged: false,
        codingAgent: project.agent,
        ide: project.ide,
        markdownEditor: project.markdownEditor,
      },
      projects: [project],
    }), "utf-8");
    console.log(chalk.green("✔") + "  Created conductor.yaml");
    created++;
  } else {
    console.log(chalk.dim("  conductor.yaml already exists (use --force to overwrite)"));
  }

  return { created, project, boardPath, configPath };
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Scaffold a new Conductor workspace (CONDUCTOR.md + conductor.yaml)")
    .option("-f, --force", "Overwrite existing files")
    .option("--project-id <id>", "Project id written to conductor.yaml")
    .option("--display-name <name>", "Friendly name shown in the dashboard")
    .option("--repo <owner/repo>", "GitHub repository slug. Auto-detected from origin if omitted.")
    .option("--path <path>", "Repository path. Defaults to the current working directory.")
    .option("--agent <agent>", "Default coding agent", "claude-code")
    .option("--model <name>", "Default model written into conductor.yaml")
    .option("--reasoning-effort <level>", "Default reasoning effort written into conductor.yaml")
    .option("--ide <editor>", "Preferred code editor", "vscode")
    .option("--markdown-editor <editor>", "Preferred markdown app", "obsidian")
    .option("--default-branch <branch>", "Default target branch. Auto-detected if omitted.")
    .option("--default-working-directory <path>", "Relative directory inside the repository where agents start")
    .option("--dashboard-url <url>", "Public dashboard URL written into conductor.yaml")
    .action((opts: InitOptions) => {
      try {
        const cwd = process.cwd();
        const { created, project } = runInitScaffold(cwd, opts);

        if (created > 0) {
          console.log();
          console.log(chalk.bold("Detected project defaults:"));
          console.log(chalk.dim("  project id:"), chalk.cyan(project.projectId));
          console.log(chalk.dim("  repo:"), chalk.cyan(project.repo));
          console.log(chalk.dim("  path:"), chalk.cyan(project.path));
          console.log(chalk.dim("  default branch:"), chalk.cyan(project.defaultBranch));
          console.log(chalk.dim("  agent:"), chalk.cyan(project.agent));
          console.log();
          console.log(chalk.bold("Next steps:"));
          console.log(chalk.dim("  1."), chalk.cyan("co start"), chalk.dim("— start the orchestrator"));
          console.log(chalk.dim("  2."), chalk.cyan("Open dashboard"), chalk.dim("— review Repository Settings and Preferences"));
          console.log(chalk.dim("  3."), chalk.cyan("Open CONDUCTOR.md"), chalk.dim("— write a task in 'Ready to Dispatch'"));
          console.log();
          console.log(chalk.dim("  Tip: Running `npx conductor-oss@latest init` from a repo root now auto-detects origin + branch."));
          console.log();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Init failed: ${message}`));
        process.exitCode = 1;
      }
    });
}
