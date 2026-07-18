import chalk from "chalk";
import type { Command } from "commander";
import {
  apiCall,
  type HealthResponse,
  type SessionHealthMetric,
  type SessionHealthResponse,
} from "../backend.js";
import { workspaceIdForPath } from "../workspaceIdentity.js";

interface DoctorOptions {
  workspace?: string;
  json?: boolean;
  fixConfig?: boolean;
}

export interface DoctorWorkspaceCheck {
  requestedPath: string | null;
  expectedId: string | null;
  backendId: string | null;
  status: "not-requested" | "match" | "mismatch" | "unsupported";
}

export function buildDoctorWorkspaceCheck(
  requestedPath: string | null,
  backendWorkspaceId: string | null | undefined,
): DoctorWorkspaceCheck {
  if (!requestedPath) {
    return {
      requestedPath: null,
      expectedId: null,
      backendId: backendWorkspaceId ?? null,
      status: "not-requested",
    };
  }

  const expectedId = workspaceIdForPath(requestedPath);
  if (!backendWorkspaceId) {
    return {
      requestedPath,
      expectedId,
      backendId: null,
      status: "unsupported",
    };
  }

  return {
    requestedPath,
    expectedId,
    backendId: backendWorkspaceId,
    status: expectedId === backendWorkspaceId ? "match" : "mismatch",
  };
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
    .option("-w, --workspace <path>", "Expected workspace path; backend mismatches fail")
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
        const requestedWorkspace = opts.workspace ?? process.env["CONDUCTOR_WORKSPACE"] ?? null;
        const workspaceCheck = buildDoctorWorkspaceCheck(
          requestedWorkspace,
          health.workspace_id,
        );

        if (workspaceCheck.status === "mismatch") {
          hints.push(
            `Backend workspace mismatch: requested ${workspaceCheck.expectedId}, connected to ${workspaceCheck.backendId}. Start the backend for the requested workspace or set CONDUCTOR_BACKEND_URL explicitly.`,
          );
        } else if (workspaceCheck.status === "unsupported") {
          hints.push(
            "The backend does not report workspace identity, so this doctor run cannot verify that it belongs to the requested workspace. Update and restart Conductor.",
          );
        }

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
          workspace: requestedWorkspace,
          workspaceCheck,
        };

        const workspaceValidationFailed =
          workspaceCheck.status === "mismatch" || workspaceCheck.status === "unsupported";

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          if (workspaceValidationFailed) process.exitCode = 1;
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
        console.log(`  Workspace:   ${chalk.dim(health.workspace_id ?? "unknown")}`);
        if (typeof health.project_count === "number") {
          console.log(`  Projects:    ${chalk.dim(String(health.project_count))}`);
        }
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
        if (workspaceValidationFailed) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }
    });
}
