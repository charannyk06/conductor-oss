/**
 * `co status`
 *
 * Kanban-style summary grouped by attention level.
 * Shows sessions bucketed into: needs response, needs review,
 * working, pending, and ready to merge.
 */

import chalk from "chalk";
import type { Command } from "commander";
import type { Session, SessionStatus } from "@conductor-oss/core";
import { createServices, loadConfig } from "../services.js";

// ---- Attention buckets ----

interface AttentionBucket {
  label: string;
  color: (s: string) => string;
  statuses: ReadonlySet<SessionStatus>;
}

const BUCKETS: AttentionBucket[] = [
  {
    label: "NEEDS RESPONSE",
    color: chalk.red,
    statuses: new Set(["needs_input", "stuck", "errored"]),
  },
  {
    label: "NEEDS REVIEW",
    color: chalk.magenta,
    statuses: new Set(["changes_requested", "ci_failed"]),
  },
  {
    label: "WORKING",
    color: chalk.green,
    statuses: new Set(["spawning", "working"]),
  },
  {
    label: "PENDING",
    color: chalk.blue,
    statuses: new Set(["pr_open", "review_pending"]),
  },
  {
    label: "READY TO MERGE",
    color: chalk.cyan,
    statuses: new Set(["approved", "mergeable"]),
  },
];

function formatAge(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function printSessionLine(session: Session): void {
  const parts: string[] = [
    chalk.green(session.id),
  ];

  if (session.branch) {
    parts.push(chalk.cyan(session.branch));
  }
  if (session.issueId) {
    parts.push(chalk.blue(session.issueId));
  }

  const summary = session.agentInfo?.summary ?? session.metadata["summary"];
  if (summary) {
    const truncated = summary.length > 50 ? summary.slice(0, 49) + "\u2026" : summary;
    parts.push(chalk.dim(truncated));
  }

  parts.push(chalk.dim(`(${formatAge(session.lastActivityAt)})`));

  console.log(`    ${parts.join("  ")}`);
}

// ---- Command registration ----

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Kanban-style status summary grouped by attention level")
    .option("-p, --project <id>", "Filter by project ID")
    .action(async (opts: { project?: string }) => {
      try {
        const config = await loadConfig();

        if (opts.project && !config.projects[opts.project]) {
          console.error(chalk.red(`Unknown project: ${opts.project}`));
          process.exit(1);
        }

        const { sessionManager } = await createServices(config);
        const sessions = await sessionManager.list(opts.project);

        // Exclude terminal sessions
        const TERMINAL: ReadonlySet<string> = new Set([
          "killed", "terminated", "done", "cleanup", "merged",
        ]);
        const active = sessions.filter((s) => !TERMINAL.has(s.status));

        if (active.length === 0) {
          console.log(chalk.dim("\nNo active sessions.\n"));
          return;
        }

        // Banner
        const line = "=".repeat(60);
        console.log(chalk.dim(`\n${line}`));
        console.log(chalk.bold.cyan("  CONDUCTOR STATUS"));
        console.log(chalk.dim(line));

        // Bucket sessions
        const bucketed = new Set<string>();
        for (const bucket of BUCKETS) {
          const matching = active.filter((s) => bucket.statuses.has(s.status));
          if (matching.length === 0) continue;

          matching.forEach((s) => bucketed.add(s.id));

          console.log();
          console.log(
            `  ${bucket.color(bucket.label)} ${chalk.dim(`(${matching.length})`)}`,
          );

          for (const session of matching) {
            printSessionLine(session);
          }
        }

        // Catch any sessions not in a bucket
        const unbucketed = active.filter((s) => !bucketed.has(s.id));
        if (unbucketed.length > 0) {
          console.log();
          console.log(`  ${chalk.yellow("OTHER")} ${chalk.dim(`(${unbucketed.length})`)}`);
          for (const session of unbucketed) {
            printSessionLine(session);
          }
        }

        // Summary line
        console.log();
        console.log(chalk.dim(`  ${active.length} active session${active.length !== 1 ? "s" : ""}`));

        // Recently merged count
        const merged = sessions.filter((s) => s.status === "merged");
        if (merged.length > 0) {
          console.log(chalk.dim(`  ${merged.length} merged`));
        }

        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err}`));
        process.exit(1);
      }
    });
}
