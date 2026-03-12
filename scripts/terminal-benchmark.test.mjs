import assert from "node:assert/strict";
import test from "node:test";

import {
  computeStats,
  evaluateBenchAssertions,
  formatStats,
  parseCurlMetrics,
  parseServerTiming,
  summarizeBenchRuns,
} from "./terminal-benchmark-lib.mjs";

test("parseCurlMetrics converts curl output into millisecond timings", () => {
  assert.deepEqual(parseCurlMetrics("status=200 total=0.143s size=512B"), {
    status: 200,
    totalMs: 143,
    sizeBytes: 512,
  });
});

test("parseServerTiming captures multiple metric durations", () => {
  assert.deepEqual(
    parseServerTiming("terminal_connection;dur=84.2, terminal_token;dur=11.4"),
    {
      terminal_connection: 84.2,
      terminal_token: 11.4,
    },
  );
});

test("summarizeBenchRuns reports total and primary metric percentiles", () => {
  const summary = summarizeBenchRuns([
    {
      label: "connection",
      status: 200,
      totalMs: 90,
      sizeBytes: 512,
      serverTiming: { terminal_connection: 55, terminal_token: 8 },
      transport: "websocket",
      interactive: "true",
      connectionPath: "direct",
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
    {
      label: "connection",
      status: 200,
      totalMs: 105,
      sizeBytes: 520,
      serverTiming: { terminal_connection: 67, terminal_token: 10 },
      transport: "websocket",
      interactive: "true",
      connectionPath: "direct",
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
    {
      label: "connection",
      status: 200,
      totalMs: 130,
      sizeBytes: 530,
      serverTiming: { terminal_connection: 79, terminal_token: 12 },
      transport: "websocket",
      interactive: "true",
      connectionPath: "direct",
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
    {
      label: "connection",
      status: 200,
      totalMs: 150,
      sizeBytes: 540,
      serverTiming: { terminal_connection: 84, terminal_token: 13 },
      transport: "websocket",
      interactive: "true",
      connectionPath: "direct",
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
    {
      label: "connection",
      status: 200,
      totalMs: 180,
      sizeBytes: 560,
      serverTiming: { terminal_connection: 102, terminal_token: 14 },
      transport: "websocket",
      interactive: "true",
      connectionPath: "direct",
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
  ]);

  assert.equal(summary.connection.totalMs?.p95, 180);
  assert.equal(summary.connection.primaryMetricName, "terminal_connection");
  assert.equal(summary.connection.primaryMetricMs?.p95, 102);
  assert.equal(summary.connection.serverTimingMs.terminal_token?.p50, 12);
});

test("evaluateBenchAssertions uses primary metrics and correctness expectations", () => {
  const results = [
    {
      label: "connection",
      status: 200,
      totalMs: 120,
      sizeBytes: 512,
      serverTiming: { terminal_connection: 82 },
      transport: "websocket",
      interactive: "true",
      connectionPath: "direct",
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
    {
      label: "snapshot_live",
      status: 200,
      totalMs: 190,
      sizeBytes: 2048,
      serverTiming: { terminal_snapshot: 145 },
      transport: null,
      interactive: null,
      connectionPath: null,
      snapshotSource: "terminal_state",
      snapshotLive: "true",
      snapshotRestored: "true",
      snapshotFormat: "restore-frame",
      resizeCols: null,
      resizeRows: null,
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
    {
      label: "resize",
      status: 200,
      totalMs: 88,
      sizeBytes: 64,
      serverTiming: { terminal_resize: 66 },
      transport: null,
      interactive: null,
      connectionPath: null,
      snapshotSource: null,
      snapshotLive: null,
      snapshotRestored: null,
      snapshotFormat: null,
      resizeCols: "120",
      resizeRows: "32",
      payloadSummary: "",
      payload: null,
      fallbackReason: null,
    },
  ];
  const summary = summarizeBenchRuns(results);

  const failures = evaluateBenchAssertions(results, summary, {
    TERMINAL_BENCH_ASSERT_CONNECTION_MS: "80",
    TERMINAL_BENCH_EXPECT_TRANSPORT: "websocket",
    TERMINAL_BENCH_EXPECT_CONNECTION_PATH: "direct",
    TERMINAL_BENCH_EXPECT_SNAPSHOT_SOURCE: "terminal_state",
    TERMINAL_BENCH_EXPECT_SNAPSHOT_RESTORED: "true",
  });

  assert.deepEqual(failures, [
    "connection latency p95 82.0ms exceeded budget 80.0ms (terminal_connection)",
  ]);
});

test("computeStats and formatStats stay stable for empty and populated samples", () => {
  assert.equal(computeStats([]), null);
  assert.equal(formatStats(null), "n/a");
  assert.equal(
    formatStats(computeStats([100, 120, 140])),
    "count=3 min=100.0ms avg=120.0ms p50=120.0ms p95=140.0ms max=140.0ms",
  );
});
