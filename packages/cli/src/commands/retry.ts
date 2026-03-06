import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { createServices, loadConfig } from "../services.js";

interface RetryOptions {
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  baseBranch?: string;
  profile?: string;
}

export function registerRetry(program: Command): void {
  program
    .command("retry")
    .description("Retry an existing task/session attempt with optional overrides")
    .argument("<sessionOrTask>", "Session ID (pp-foo-1) or task ID (t-xxxx)")
    .option("--agent <name>", "Override agent plugin for the new attempt")
    .option("--model <name>", "Override model for the new attempt")
    .option("--reasoning-effort <level>", "Override reasoning effort for the new attempt")
    .option("--base-branch <name>", "Override base branch for the new attempt")
    .option("--profile <name>", "Use a named project profile (fast/deep/safe/auto)")
    .action(async (sessionOrTask: string, opts: RetryOptions) => {
      const spinner = ora("Creating retry attempt").start();
      try {
        const config = await loadConfig();
        const { sessionManager } = await createServices(config);
        const manager = sessionManager as unknown as {
          retry: (
            target: string,
            options?: { agent?: string; model?: string; reasoningEffort?: string; baseBranch?: string; profile?: string },
          ) => Promise<{ id: string; projectId: string; branch: string | null; metadata: Record<string, string> }>;
        };

        const next = await manager.retry(sessionOrTask, {
          agent: opts.agent,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort?.trim().toLowerCase() || undefined,
          baseBranch: opts.baseBranch,
          profile: opts.profile,
        });

        spinner.succeed(`New attempt started: ${chalk.green(next.id)}`);
        console.log(`  Project:  ${chalk.dim(next.projectId)}`);
        if (next.branch) {
          console.log(`  Branch:   ${chalk.dim(next.branch)}`);
        }
        console.log(`  Task:     ${chalk.dim(next.metadata["taskId"] ?? "-")}`);
        console.log(`  Attempt:  ${chalk.dim(next.metadata["attemptId"] ?? "-")}`);
        console.log(`  Retry Of: ${chalk.dim(next.metadata["retryOfSessionId"] ?? "-")}`);
        console.log();
        console.log(`SESSION=${next.id}`);
      } catch (err) {
        spinner.fail("Retry failed");
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
