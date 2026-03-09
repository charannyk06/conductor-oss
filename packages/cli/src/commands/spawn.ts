/**
 * `co spawn <project> [issueOrPrompt]`
 *
 * Spawns a new agent session for the given project.
 * Optionally targets a specific issue (e.g. #42) or provides a free-text prompt.
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  apiCall,
  fetchConfiguredProjects,
  sessionTmuxTarget,
  sessionWorktree,
  type SessionResponse,
} from "../backend.js";

interface SpawnOptions {
  agent?: string;
  model?: string;
  reasoningEffort?: string;
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
    .option("--reasoning-effort <level>", "Override reasoning effort when the target CLI supports it")
    .option("--branch <name>", "Override branch name")
    .option("--prompt <text>", "Explicit prompt (if issueOrPrompt is an issue)")
    .action(async (project: string, issueOrPrompt: string | undefined, opts: SpawnOptions) => {
      const projects = await fetchConfiguredProjects();

      if (!projects.has(project)) {
        console.error(
          chalk.red(
            `Unknown project: ${project}\nAvailable: ${[...projects.keys()].join(", ")}`,
          ),
        );
        process.exit(1);
      }

      // Determine whether the positional arg is an issue or a prompt.
      // Issue identifiers look like #42, GH-123, INT-456, etc.
      const isIssue = issueOrPrompt
        ? /^#?\d+$/.test(issueOrPrompt) || /^[A-Z]+-\d+$/.test(issueOrPrompt)
        : false;

      const spinner = ora("Creating session").start();

      try {
        spinner.text = "Spawning agent session";

        const { session } = await apiCall<SessionResponse>("POST", "/api/sessions/spawn", {
          projectId: project,
          issueId: isIssue ? issueOrPrompt : undefined,
          prompt: opts.prompt ?? (!isIssue ? issueOrPrompt : undefined),
          branch: opts.branch,
          agent: opts.agent,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort?.trim().toLowerCase() || undefined,
          useWorktree: true,
        });
        spinner.succeed(`Session ${chalk.green(session.id)} created`);

        console.log(`  Worktree: ${chalk.dim(sessionWorktree(session) ?? "-")}`);
        if (session.branch) {
          console.log(`  Branch:   ${chalk.dim(session.branch)}`);
        }
        if (session.issueId) {
          console.log(`  Issue:    ${chalk.dim(session.issueId)}`);
        }

        const tmuxTarget = sessionTmuxTarget(session);
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
