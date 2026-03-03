/**
 * `co spawn <project> [issueOrPrompt]`
 *
 * Spawns a new agent session for the given project.
 * Optionally targets a specific issue (e.g. #42) or provides a free-text prompt.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import type { SessionSpawnConfig } from "@conductor-oss/core";
import { createServices, loadConfig } from "../services.js";

interface SpawnOptions {
  agent?: string;
  model?: string;
  branch?: string;
  prompt?: string;
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a new agent session for a project")
    .argument("<project>", "Project ID from conductor config")
    .argument("[issueOrPrompt]", "Issue identifier (#42, INT-123) or inline prompt")
    .option(
      "--agent <name>",
      "Override agent plugin (e.g. claude-code, codex, gemini, amp, cursor-cli, opencode, droid, qwen-code, ccr, github-copilot, openai-codex, google-gemini, open-code)",
    )
    .option("--model <name>", "Override model (e.g. o4-mini, claude-opus-4-6)")
    .option("--branch <name>", "Override branch name")
    .option("--prompt <text>", "Explicit prompt (if issueOrPrompt is an issue)")
    .action(async (project: string, issueOrPrompt: string | undefined, opts: SpawnOptions) => {
      const config = await loadConfig();

      if (!config.projects[project]) {
        console.error(
          chalk.red(
            `Unknown project: ${project}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      // Determine whether the positional arg is an issue or a prompt.
      // Issue identifiers look like #42, GH-123, INT-456, etc.
      const isIssue = issueOrPrompt
        ? /^#?\d+$/.test(issueOrPrompt) || /^[A-Z]+-\d+$/.test(issueOrPrompt)
        : false;

      const spawnConfig: SessionSpawnConfig = {
        projectId: project,
        issueId: isIssue ? issueOrPrompt : undefined,
        prompt: opts.prompt ?? (!isIssue ? issueOrPrompt : undefined),
        branch: opts.branch,
        agent: opts.agent,
        model: opts.model,
      };

      const spinner = ora("Creating session").start();

      try {
        const { sessionManager } = await createServices(config);
        spinner.text = "Spawning agent session";

        const session = await sessionManager.spawn(spawnConfig);
        spinner.succeed(`Session ${chalk.green(session.id)} created`);

        console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
        if (session.branch) {
          console.log(`  Branch:   ${chalk.dim(session.branch)}`);
        }
        if (session.issueId) {
          console.log(`  Issue:    ${chalk.dim(session.issueId)}`);
        }

        const tmuxTarget = session.runtimeHandle?.id ?? session.id;
        console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
        console.log();
        console.log(`SESSION=${session.id}`);
      } catch (err) {
        spinner.fail("Failed to spawn session");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
