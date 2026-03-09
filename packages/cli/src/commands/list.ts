/**
 * `co list [project]`
 *
 * Lists all sessions in a table format.
 * Optionally filters by project ID.
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  apiCall,
  fetchConfiguredProjects,
  fetchProjects,
  type BackendSession,
  type SessionsResponse,
} from "../backend.js";

// ---- Formatting helpers ----

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function padCol(str: string, width: number): string {
  const visible = str.replace(ANSI_RE, "");
  if (visible.length > width) {
    return visible.slice(0, width - 1) + "\u2026";
  }
  return str + " ".repeat(Math.max(0, width - visible.length));
}

function formatAge(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function statusColor(status: string): string {
  switch (status) {
    case "working":
    case "approved":
    case "mergeable":
    case "merged":
      return chalk.green(status);
    case "spawning":
      return chalk.cyan(status);
    case "pr_open":
    case "review_pending":
      return chalk.blue(status);
    case "ci_failed":
    case "errored":
    case "stuck":
      return chalk.red(status);
    case "changes_requested":
    case "needs_input":
      return chalk.magenta(status);
    case "killed":
    case "terminated":
    case "cleanup":
    case "done":
      return chalk.dim(status);
    default:
      return chalk.yellow(status);
  }
}

function activityLabel(activity: string | null): string {
  switch (activity) {
    case "active":
      return chalk.green("active");
    case "ready":
      return chalk.cyan("ready");
    case "idle":
      return chalk.yellow("idle");
    case "waiting_input":
      return chalk.magenta("waiting");
    case "blocked":
      return chalk.red("blocked");
    case "exited":
      return chalk.dim("exited");
    default:
      return chalk.dim("-");
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}

// ---- Column widths ----

const COL = {
  id: 18,
  status: 14,
  activity: 10,
  branch: 22,
  issue: 10,
  summary: 24,
  age: 6,
};

function printHeader(): void {
  const hdr =
    padCol("ID", COL.id) +
    padCol("Status", COL.status) +
    padCol("Activity", COL.activity) +
    padCol("Branch", COL.branch) +
    padCol("Issue", COL.issue) +
    padCol("Summary", COL.summary) +
    "Age";
  console.log(chalk.dim(`  ${hdr}`));
  const totalWidth = COL.id + COL.status + COL.activity + COL.branch + COL.issue + COL.summary + 4;
  console.log(chalk.dim(`  ${"─".repeat(totalWidth)}`));
}

function printRow(session: BackendSession): void {
  const summary = session.summary ?? session.metadata["summary"] ?? "-";
  const row =
    padCol(chalk.green(session.id), COL.id) +
    padCol(statusColor(session.status), COL.status) +
    padCol(activityLabel(session.activity), COL.activity) +
    padCol(session.branch ? chalk.cyan(truncate(session.branch, COL.branch - 1)) : chalk.dim("-"), COL.branch) +
    padCol(session.issueId ? chalk.blue(session.issueId) : chalk.dim("-"), COL.issue) +
    padCol(chalk.dim(truncate(summary, COL.summary - 1)), COL.summary) +
    chalk.dim(formatAge(new Date(session.createdAt)));

  console.log(`  ${row}`);
}

// ---- Command registration ----

export function registerList(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("List all sessions (table format)")
    .argument("[project]", "Filter by project ID")
    .option("--json", "Output as JSON")
    .option("--all", "Include terminal (killed/done/merged) sessions")
    .action(async (project: string | undefined, opts: { json?: boolean; all?: boolean }) => {
      try {
        const [configuredProjects, projects] = await Promise.all([
          fetchConfiguredProjects(),
          fetchProjects(),
        ]);

        if (project && !configuredProjects.has(project)) {
          console.error(
            chalk.red(`Unknown project: ${project}\nAvailable: ${[...configuredProjects.keys()].join(", ")}`),
          );
          process.exit(1);
        }

        const query = project ? `?project=${encodeURIComponent(project)}` : "";
        let sessions = (await apiCall<SessionsResponse>("GET", `/api/sessions${query}`)).sessions;

        // Filter out terminal sessions unless --all is passed
        const TERMINAL: ReadonlySet<string> = new Set(["killed", "terminated", "done", "cleanup", "errored", "merged"]);
        if (!opts.all) {
          sessions = sessions.filter((s) => !TERMINAL.has(s.status));
        }

        if (opts.json) {
          console.log(JSON.stringify(sessions, null, 2));
          return;
        }

        if (sessions.length === 0) {
          console.log(chalk.dim("No active sessions."));
          if (!opts.all) {
            console.log(chalk.dim("Use --all to include completed/killed sessions."));
          }
          return;
        }

        // Group by project
        const byProject = new Map<string, BackendSession[]>();
        for (const s of sessions) {
          const list = byProject.get(s.projectId) ?? [];
          list.push(s);
          byProject.set(s.projectId, list);
        }

        for (const [projectId, projectSessions] of byProject) {
          const label = projects.get(projectId)?.name ?? projectId;
          console.log(chalk.bold(`\n${label}`));
          printHeader();
          for (const s of projectSessions.sort((a, b) => a.id.localeCompare(b.id))) {
            printRow(s);
          }
        }
        console.log();
        console.log(
          chalk.dim(`  ${sessions.length} session${sessions.length !== 1 ? "s" : ""} total`),
        );
        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err}`));
        process.exit(1);
      }
    });
}
