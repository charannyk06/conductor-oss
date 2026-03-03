/**
 * `co init`
 *
 * Scaffolds a new Conductor workspace with a CONDUCTOR.md kanban board
 * and a conductor.yaml config file. Dead-simple onboarding.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

const CONDUCTOR_MD = `# My Project

> 🤖 Conductor — AI agent orchestrator. Write tasks here, agents do the work.
> Tags: \`#agent/claude-code\` · \`#agent/codex\` · \`#agent/gemini\` · \`#agent/amp\` · \`#agent/cursor-cli\` · \`#agent/opencode\` · \`#agent/droid\` · \`#agent/qwen-code\` · \`#agent/ccr\` · \`#agent/github-copilot\` · \`#project/my-app\` · \`#type/feature\` · \`#priority/high\`

## Inbox

> Drop rough ideas here. Conductor auto-tags them within 20s.

## Ready to Dispatch

> Move tagged tasks here to dispatch an agent.

## Dispatching

## In Progress

## Review

> Agent finished — review the PR, then move to Done.

## Done

## Blocked
`;

const CONDUCTOR_YAML = `# Conductor Configuration
# Docs: https://github.com/conductor-oss/conductor

port: 4747

projects:
  my-app:
    path: ~/projects/my-app        # Path to your project
    repo: your-org/my-app          # GitHub org/repo for PR tracking
    agent: claude-code             # "claude-code", "codex", "gemini", "amp", "cursor-cli", "opencode", "droid", "qwen-code", "ccr", or "github-copilot"
    agentConfig:
      model: claude-sonnet-4-6
      permissions: skip            # Fully autonomous (no prompts)
    workspace: worktree            # Git worktree isolation per task
    runtime: tmux
    scm: github

# Add more projects below:
# another-project:
#   path: ~/projects/another
#   repo: your-org/another
#   agent: codex
#   agentConfig:
#     model: o4-mini

# Optional: Discord notifications
# plugins:
#   discord:
#     channelId: "YOUR_CHANNEL_ID"
#     tokenEnvVar: DISCORD_BOT_TOKEN
`;

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Scaffold a new Conductor workspace (CONDUCTOR.md + conductor.yaml)")
    .option("-f, --force", "Overwrite existing files")
    .action((opts: { force?: boolean }) => {
      const cwd = process.cwd();

      const boardPath = resolve(cwd, "CONDUCTOR.md");
      const configPath = resolve(cwd, "conductor.yaml");

      let created = 0;

      if (!existsSync(boardPath) || opts.force) {
        writeFileSync(boardPath, CONDUCTOR_MD, "utf-8");
        console.log(chalk.green("✔") + "  Created CONDUCTOR.md");
        created++;
      } else {
        console.log(chalk.dim("  CONDUCTOR.md already exists (use --force to overwrite)"));
      }

      if (!existsSync(configPath) || opts.force) {
        writeFileSync(configPath, CONDUCTOR_YAML, "utf-8");
        console.log(chalk.green("✔") + "  Created conductor.yaml");
        created++;
      } else {
        console.log(chalk.dim("  conductor.yaml already exists (use --force to overwrite)"));
      }

      if (created > 0) {
        console.log();
        console.log(chalk.bold("Next steps:"));
        console.log(chalk.dim("  1."), chalk.cyan("Edit conductor.yaml"), chalk.dim("— set your project path, repo, and agent"));
        console.log(chalk.dim("  2."), chalk.cyan("co start"), chalk.dim("         — start the orchestrator"));
        console.log(chalk.dim("  3."), chalk.cyan("Open CONDUCTOR.md"), chalk.dim("— write a task in 'Ready to Dispatch'"));
        console.log();
        console.log(chalk.dim("  Tip: Install the Obsidian Kanban plugin for the best board experience."));
        console.log();
      }
    });
}
