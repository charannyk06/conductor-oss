import chalk from "chalk";
import type { Command } from "commander";
import {
  apiCall,
  type HealthResponse,
  type SessionHealthMetric,
  type SessionHealthResponse,
} from "../backend.js";

interface DoctorOptions {
  workspace?: string;
  json?: boolean;
  fixConfig?: boolean;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatMs(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000) return `${Math.floor(milliseconds / 3_600_000)}h`;
  return `${Math.floor(milliseconds / 86_400_000)}d`;
}

function healthColor(value: string): string {
  switch (value) {
    case "healthy":
      return chalk.green(value);
    case "pending":
      return chalk.blue(value);
    case "warning":
      return chalk.yellow(value);
    case "critical":
      return chalk.red(value);
    default:
      return chalk.dim(value);
  }
}

function printMetric(metric: SessionHealthMetric): void {
  console.log(
    `  ${healthColor(metric.health)} ${chalk.green(metric.id)} ${chalk.dim(metric.projectId)} ` +
    `${chalk.yellow(metric.status)} idle=${chalk.dim(formatMs(metric.idleMs))} age=${chalk.dim(formatMs(metric.ageMs))}`,
  );
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose Rust backend health and session runtime issues")
    .option("-w, --workspace <path>", "Workspace path (reported for context only)")
    .option("--json", "Output JSON report")
    .option("--fix-config", "Deprecated. Config sync now happens through the Rust backend")
    .action(async (opts: DoctorOptions) => {
      try {
        const [health, sessionHealth] = await Promise.all([
          apiCall<HealthResponse>("GET", "/api/health"),
          apiCall<SessionHealthResponse>("GET", "/api/health/sessions"),
        ]);

        const unhealthyMetrics = sessionHealth.metrics.filter((metric) => metric.health !== "healthy");
        const hints: string[] = [];

        if (health.queue_depth > 0) {
          hints.push(`${health.queue_depth} session${health.queue_depth !== 1 ? "s are" : " is"} queued waiting for launch capacity.`);
        }
        if (health.recovering_sessions > 0) {
          hints.push(`${health.recovering_sessions} session${health.recovering_sessions !== 1 ? "s are" : " is"} currently in recovery.`);
        }
        if (sessionHealth.summary.critical > 0) {
          hints.push(`${sessionHealth.summary.critical} session${sessionHealth.summary.critical !== 1 ? "s are" : " is"} in a critical state. Review \`co status\` and session output.`);
        }
        if (opts.fixConfig) {
          hints.push("`--fix-config` moved out of the JS CLI path. Restart the Rust backend to rerun config/support-file sync.");
        }
        if (hints.length === 0) {
          hints.push("No backend health issues detected.");
        }

        const report = {
          backend: health,
          sessions: sessionHealth,
          hints,
          workspace: opts.workspace ?? process.env["CONDUCTOR_WORKSPACE"] ?? null,
        };

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log(chalk.bold("Conductor Doctor"));
        if (report.workspace) {
          console.log(chalk.dim(`Workspace: ${report.workspace}`));
        }
        console.log();

        console.log(chalk.bold("Backend Health"));
        console.log(`  Status:      ${health.status === "ok" ? chalk.green(health.status) : chalk.red(health.status)}`);
        console.log(`  Version:     ${chalk.cyan(health.version)}`);
        console.log(`  Uptime:      ${chalk.dim(formatDuration(health.uptime_secs))}`);
        console.log(`  Executors:   ${chalk.dim(String(health.executors))}`);
        console.log(`  Subscribers: ${chalk.dim(String(health.event_subscribers))}`);
        console.log(`  Queue depth: ${chalk.dim(String(health.queue_depth))}`);
        console.log(`  Launching:   ${chalk.dim(String(health.launching_sessions))}`);
        console.log(`  Recovering:  ${chalk.dim(String(health.recovering_sessions))}`);
        console.log(`  Detached:    ${chalk.dim(String(health.detached_sessions))}`);

        console.log();
        console.log(chalk.bold("Session Health"));
        console.log(
          `  total=${chalk.dim(String(sessionHealth.summary.total))} ` +
          `healthy=${chalk.green(String(sessionHealth.summary.healthy))} ` +
          `pending=${chalk.blue(String(sessionHealth.summary.pending))} ` +
          `warning=${chalk.yellow(String(sessionHealth.summary.warning))} ` +
          `critical=${chalk.red(String(sessionHealth.summary.critical))}`,
        );

        console.log();
        console.log(chalk.bold("Sessions Needing Attention"));
        if (unhealthyMetrics.length === 0) {
          console.log(chalk.green("  None"));
        } else {
          for (const metric of unhealthyMetrics) {
            printMetric(metric);
          }
        }

        console.log();
        console.log(chalk.bold("Fix Hints"));
        for (const hint of hints) {
          console.log(`  ${chalk.yellow("-")} ${hint}`);
        }
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
