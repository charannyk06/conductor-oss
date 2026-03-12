#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluateBenchAssertions,
  formatStats,
  parseCurlMetrics,
  parseServerTiming,
  summarizeBenchRuns,
} from "./terminal-benchmark-lib.mjs";

const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:3000";
const DEFAULT_RUNS = 5;
const DEFAULT_LINES = 1200;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

function usage() {
  process.stderr.write(`Usage: scripts/terminal-benchmark.sh <session-id> [--json] [--summary-only]

Environment:
  CONDUCTOR_DASHBOARD_URL                 Dashboard base URL. Default: ${DEFAULT_DASHBOARD_URL}
  TERMINAL_BENCH_RUNS                    Number of runs per endpoint. Default: ${DEFAULT_RUNS}
  TERMINAL_BENCH_LINES                   Snapshot line budget. Default: ${DEFAULT_LINES}
  TERMINAL_BENCH_COLS                    Resize width. Default: ${DEFAULT_COLS}
  TERMINAL_BENCH_ROWS                    Resize height. Default: ${DEFAULT_ROWS}
  TERMINAL_BENCH_ASSERT_CONNECTION_MS    Max allowed p95 for connection timing
  TERMINAL_BENCH_ASSERT_SNAPSHOT_MS      Max allowed p95 for live snapshot timing
  TERMINAL_BENCH_ASSERT_RESIZE_MS        Max allowed p95 for resize timing
  TERMINAL_BENCH_EXPECT_TRANSPORT        Expected connection transport, for example websocket
  TERMINAL_BENCH_EXPECT_CONNECTION_PATH  Expected connection path, for example direct
  TERMINAL_BENCH_EXPECT_SNAPSHOT_SOURCE  Expected live snapshot source, for example terminal_state
  TERMINAL_BENCH_EXPECT_SNAPSHOT_RESTORED Expected live snapshot restored flag, true or false
`);
}

function parsePositiveInteger(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${envKey} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  let sessionId = null;
  let json = false;
  let summaryOnly = false;

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--summary-only") {
      summaryOnly = true;
      continue;
    }
    if (!sessionId) {
      sessionId = argument;
      continue;
    }
    throw new Error(`Unexpected argument: ${argument}`);
  }

  if (!sessionId) {
    usage();
    process.exit(1);
  }

  return { sessionId, json, summaryOnly };
}

function ensureExecutable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} is required`);
  }
}

function extractHeader(headerText, name) {
  const target = name.toLowerCase();
  for (const rawLine of headerText.split(/\r?\n/)) {
    const separatorIndex = rawLine.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = rawLine.slice(0, separatorIndex).trim().toLowerCase();
    if (key !== target) continue;
    return rawLine.slice(separatorIndex + 1).trim();
  }
  return "";
}

function readPayloadSummary(label, payload) {
  const fieldsByLabel = {
    connection: ["transport", "interactive", "requiresToken", "tokenExpiresInSeconds", "fallbackReason"],
    snapshot_live: ["source", "live", "restored", "format", "snapshotVersion", "sequence"],
    snapshot_readonly: ["source", "live", "restored", "format", "snapshotVersion", "sequence"],
    resize: ["ok", "sessionId", "cols", "rows"],
  };
  const fields = fieldsByLabel[label] ?? [];

  return fields
    .map((field) => [field, payload?.[field]])
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
    .join(" ");
}

function runCurlRequest(request, workdir) {
  const headersPath = join(workdir, `${request.label}.headers`);
  const bodyPath = join(workdir, `${request.label}.body`);
  const curlArgs = [
    "-sS",
    "-D",
    headersPath,
    "-o",
    bodyPath,
    "-X",
    request.method,
    "-H",
    "Accept: application/json",
  ];

  if (request.body) {
    curlArgs.push("-H", "Content-Type: application/json", "--data", request.body);
  }

  curlArgs.push("-w", "status=%{http_code} total=%{time_total}s size=%{size_download}B", request.url);

  const result = spawnSync("curl", curlArgs, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `curl exited with status ${result.status}`);
  }

  const headersText = readFileSync(headersPath, "utf8");
  const bodyText = readFileSync(bodyPath, "utf8");
  const metrics = parseCurlMetrics(result.stdout.trim());
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = null;
  }

  const serverTiming = parseServerTiming(extractHeader(headersText, "server-timing"));
  return {
    label: request.label,
    status: metrics.status,
    totalMs: metrics.totalMs,
    sizeBytes: metrics.sizeBytes,
    serverTiming,
    transport: extractHeader(headersText, "x-conductor-terminal-transport") || null,
    interactive: extractHeader(headersText, "x-conductor-terminal-interactive") || null,
    connectionPath: extractHeader(headersText, "x-conductor-terminal-connection-path") || null,
    snapshotSource: extractHeader(headersText, "x-conductor-terminal-snapshot-source") || null,
    snapshotLive: extractHeader(headersText, "x-conductor-terminal-snapshot-live") || null,
    snapshotRestored: extractHeader(headersText, "x-conductor-terminal-snapshot-restored") || null,
    snapshotFormat: extractHeader(headersText, "x-conductor-terminal-snapshot-format") || null,
    resizeCols: extractHeader(headersText, "x-conductor-terminal-resize-cols") || null,
    resizeRows: extractHeader(headersText, "x-conductor-terminal-resize-rows") || null,
    fallbackReason: payload?.fallbackReason ?? null,
    payloadSummary: readPayloadSummary(request.label, payload),
    payload,
  };
}

function formatRawResult(result) {
  const fields = [
    `${result.label.padEnd(18)} status=${result.status} total=${(result.totalMs / 1000).toFixed(3)}s size=${result.sizeBytes}B`,
  ];

  const serverTimingPairs = Object.entries(result.serverTiming)
    .map(([name, value]) => `${name};dur=${value.toFixed(1)}`)
    .join(", ");
  if (serverTimingPairs) fields.push(`server_timing="${serverTimingPairs}"`);
  if (result.transport) fields.push(`transport=${result.transport}`);
  if (result.interactive) fields.push(`interactive=${result.interactive}`);
  if (result.connectionPath) fields.push(`connection_path=${result.connectionPath}`);
  if (result.snapshotSource) fields.push(`snapshot_source=${result.snapshotSource}`);
  if (result.snapshotLive) fields.push(`snapshot_live=${result.snapshotLive}`);
  if (result.snapshotRestored) fields.push(`snapshot_restored=${result.snapshotRestored}`);
  if (result.snapshotFormat) fields.push(`snapshot_format=${result.snapshotFormat}`);
  if (result.resizeCols) fields.push(`resize_cols=${result.resizeCols}`);
  if (result.resizeRows) fields.push(`resize_rows=${result.resizeRows}`);
  if (result.payloadSummary) fields.push(result.payloadSummary);

  return fields.join(" ");
}

function printSummary(summary) {
  process.stdout.write("\nsummary\n");
  for (const [label, bucket] of Object.entries(summary)) {
    const details = [];
    if (bucket.transports.length > 0) details.push(`transport=${bucket.transports.join(",")}`);
    if (bucket.connectionPaths.length > 0) details.push(`connection_path=${bucket.connectionPaths.join(",")}`);
    if (bucket.snapshotSources.length > 0) details.push(`snapshot_source=${bucket.snapshotSources.join(",")}`);
    if (bucket.snapshotFormats.length > 0) details.push(`snapshot_format=${bucket.snapshotFormats.join(",")}`);
    if (bucket.interactives.length > 0) details.push(`interactive=${bucket.interactives.join(",")}`);
    if (bucket.fallbackReasons.length > 0) details.push(`fallback=${bucket.fallbackReasons.join(" | ")}`);
    const statuses = Object.entries(bucket.statuses)
      .map(([status, count]) => `${status}x${count}`)
      .join(",");
    if (statuses) details.push(`statuses=${statuses}`);

    process.stdout.write(`${label.padEnd(18)} total_ms ${formatStats(bucket.totalMs)}`);
    if (details.length > 0) {
      process.stdout.write(` ${details.join(" ")}`);
    }
    process.stdout.write("\n");

    for (const [metricName, stats] of Object.entries(bucket.serverTimingMs)) {
      process.stdout.write(`${"".padEnd(18)} ${metricName}_ms ${formatStats(stats)}\n`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dashboardUrl = process.env.CONDUCTOR_DASHBOARD_URL?.trim() || DEFAULT_DASHBOARD_URL;
  const runs = parsePositiveInteger("TERMINAL_BENCH_RUNS", DEFAULT_RUNS);
  const lines = parsePositiveInteger("TERMINAL_BENCH_LINES", DEFAULT_LINES);
  const cols = parsePositiveInteger("TERMINAL_BENCH_COLS", DEFAULT_COLS);
  const rows = parsePositiveInteger("TERMINAL_BENCH_ROWS", DEFAULT_ROWS);

  ensureExecutable("curl");

  const requests = [
    {
      label: "connection",
      method: "GET",
      url: `${dashboardUrl}/api/sessions/${encodeURIComponent(options.sessionId)}/terminal/connection`,
    },
    {
      label: "snapshot_live",
      method: "GET",
      url: `${dashboardUrl}/api/sessions/${encodeURIComponent(options.sessionId)}/terminal/snapshot?lines=${lines}&live=1`,
    },
    {
      label: "resize",
      method: "POST",
      url: `${dashboardUrl}/api/sessions/${encodeURIComponent(options.sessionId)}/terminal/resize`,
      body: JSON.stringify({ cols, rows }),
    },
    {
      label: "snapshot_readonly",
      method: "GET",
      url: `${dashboardUrl}/api/sessions/${encodeURIComponent(options.sessionId)}/terminal/snapshot?lines=${lines}`,
    },
  ];

  const tempRoot = mkdtempSync(join(tmpdir(), "conductor-terminal-benchmark."));
  const results = [];

  try {
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      if (!options.json && !options.summaryOnly) {
        process.stdout.write(`run=${runIndex + 1} session=${options.sessionId} dashboard=${dashboardUrl}\n`);
      }

      for (const request of requests) {
        const runResult = runCurlRequest(
          request,
          mkdtempSync(join(tempRoot, `${String(runIndex + 1).padStart(2, "0")}-${request.label}.`)),
        );
        results.push(runResult);
        if (!options.json && !options.summaryOnly) {
          process.stdout.write(`${formatRawResult(runResult)}\n`);
        }
      }

      if (!options.json && !options.summaryOnly) {
        process.stdout.write("\n");
      }
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }

  const summary = summarizeBenchRuns(results);
  const failures = evaluateBenchAssertions(results, summary);
  const output = {
    config: {
      sessionId: options.sessionId,
      dashboardUrl,
      runs,
      lines,
      cols,
      rows,
    },
    results,
    summary,
    failures,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    printSummary(summary);
    if (failures.length === 0) {
      process.stdout.write("\nassertions: passed\n");
    } else {
      process.stdout.write("\nassertions: failed\n");
      for (const failure of failures) {
        process.stdout.write(`- ${failure}\n`);
      }
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
