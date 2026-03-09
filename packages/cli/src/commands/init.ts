import { spawnSync } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import { resolveRustCliLaunch } from "../rust-cli.js";

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

type InitScaffoldResult = {
  created: number;
  project: InitProjectConfig;
  boardPath: string;
  configPath: string;
};

function buildInitArgs(opts: InitOptions, json = false): string[] {
  const args = ["init", opts.path?.trim() || "."];

  if (opts.force) args.push("--force");
  if (opts.projectId) args.push("--project-id", opts.projectId);
  if (opts.displayName) args.push("--display-name", opts.displayName);
  if (opts.repo) args.push("--repo", opts.repo);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
  if (opts.ide) args.push("--ide", opts.ide);
  if (opts.markdownEditor) args.push("--markdown-editor", opts.markdownEditor);
  if (opts.defaultBranch) args.push("--default-branch", opts.defaultBranch);
  if (opts.defaultWorkingDirectory) {
    args.push("--default-working-directory", opts.defaultWorkingDirectory);
  }
  if (opts.dashboardUrl) args.push("--dashboard-url", opts.dashboardUrl);
  if (json) args.push("--json");

  return args;
}

export function runInitScaffold(cwd: string, opts: InitOptions): InitScaffoldResult {
  const launch = resolveRustCliLaunch();
  const result = spawnSync(
    launch.cmd,
    [...launch.argsPrefix, ...buildInitArgs(opts, true)],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || "Rust init failed";
    throw new Error(message);
  }

  const payload = result.stdout?.trim();
  if (!payload) {
    throw new Error("Rust init returned no scaffold result");
  }

  return JSON.parse(payload) as InitScaffoldResult;
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
        const launch = resolveRustCliLaunch();
        const result = spawnSync(
          launch.cmd,
          [...launch.argsPrefix, ...buildInitArgs(opts)],
          {
            cwd: process.cwd(),
            stdio: "inherit",
          },
        );

        if (result.error) {
          throw result.error;
        }
        if (typeof result.status === "number" && result.status !== 0) {
          process.exit(result.status);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Init failed: ${message}`));
        process.exitCode = 1;
      }
    });
}
