import chalk from "chalk";
import type { Command } from "commander";
import { apiCall, type TaskGraphResponse } from "../backend.js";

export function registerTask(program: Command): void {
  const task = program
    .command("task")
    .description("Task graph helpers");

  task
    .command("show")
    .description("Show task attempts, parent, and child tasks")
    .argument("<taskId>", "Task ID, e.g. t-abc123")
    .option("--json", "Output raw JSON")
    .action(async (taskId: string, opts: { json?: boolean }) => {
      try {
        const graph = await apiCall<TaskGraphResponse | null>(
          "GET",
          `/api/tasks/${encodeURIComponent(taskId)}/graph`,
        );

        if (!graph) {
          console.log(chalk.dim(`No task found for ${taskId}`));
          process.exit(1);
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(graph, null, 2));
          return;
        }

        console.log(chalk.bold(`Task ${graph.taskId}`));
        console.log(`  Parent:   ${chalk.dim(graph.parentTaskId ?? "-")}`);
        console.log(
          `  Children: ${chalk.dim(graph.childrenTaskIds.length ? graph.childrenTaskIds.join(", ") : "-")}`,
        );

        console.log();
        console.log(chalk.bold("Attempts"));
        if (graph.attempts.length === 0) {
          console.log(chalk.dim("  None"));
          return;
        }

        for (const attempt of graph.attempts) {
          console.log(
            `  ${chalk.cyan(attempt.attemptId)}  ${chalk.green(attempt.sessionId)}  ${chalk.yellow(attempt.status)}` +
            `${attempt.agent ? `  ${chalk.dim(attempt.agent)}` : ""}` +
            `${attempt.model ? `/${chalk.dim(attempt.model)}` : ""}` +
            `${attempt.branch ? `  ${chalk.dim(attempt.branch)}` : ""}`,
          );
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
