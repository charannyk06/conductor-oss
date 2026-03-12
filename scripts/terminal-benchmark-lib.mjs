const CURL_METRICS_RE = /status=(\d+)\s+total=([0-9.]+)s\s+size=(\d+)B/;

function roundMs(value) {
  return Number(value.toFixed(1));
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

function pushMetric(map, key, value) {
  if (!map[key]) {
    map[key] = [];
  }
  map[key].push(value);
}

function sortKeys(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function parseCurlMetrics(value) {
  const match = String(value ?? "").trim().match(CURL_METRICS_RE);
  if (!match) {
    throw new Error(`Unable to parse curl metrics: ${value}`);
  }

  return {
    status: Number(match[1]),
    totalMs: roundMs(Number(match[2]) * 1000),
    sizeBytes: Number(match[3]),
  };
}

export function parseServerTiming(headerValue) {
  const metrics = {};
  for (const segment of String(headerValue ?? "").split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const [name, ...params] = trimmed.split(";");
    if (!name) continue;

    for (const param of params) {
      const match = param.trim().match(/^dur=([0-9.]+)$/i);
      if (!match) continue;
      metrics[name.trim()] = roundMs(Number(match[1]));
      break;
    }
  }

  return metrics;
}

export function computeStats(values) {
  const filtered = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (filtered.length === 0) {
    return null;
  }

  const total = filtered.reduce((sum, value) => sum + value, 0);
  return {
    count: filtered.length,
    min: roundMs(filtered[0]),
    avg: roundMs(total / filtered.length),
    p50: roundMs(percentile(filtered, 50)),
    p95: roundMs(percentile(filtered, 95)),
    max: roundMs(filtered[filtered.length - 1]),
  };
}

export function primaryMetricNameForLabel(label) {
  switch (label) {
    case "connection":
      return "terminal_connection";
    case "snapshot_live":
    case "snapshot_readonly":
      return "terminal_snapshot";
    case "resize":
      return "terminal_resize";
    default:
      return null;
  }
}

export function summarizeBenchRuns(results) {
  const grouped = {};

  for (const result of results) {
    const label = result.label;
    const bucket = grouped[label] ?? {
      statuses: {},
      totalMsValues: [],
      sizeBytesValues: [],
      serverTimingValues: {},
      transports: new Set(),
      connectionPaths: new Set(),
      snapshotSources: new Set(),
      snapshotFormats: new Set(),
      interactives: new Set(),
      fallbackReasons: new Set(),
    };

    bucket.statuses[String(result.status)] = (bucket.statuses[String(result.status)] ?? 0) + 1;
    bucket.totalMsValues.push(result.totalMs);
    bucket.sizeBytesValues.push(result.sizeBytes);

    for (const [metricName, metricValue] of Object.entries(result.serverTiming ?? {})) {
      pushMetric(bucket.serverTimingValues, metricName, metricValue);
    }

    if (result.transport) bucket.transports.add(result.transport);
    if (result.connectionPath) bucket.connectionPaths.add(result.connectionPath);
    if (result.snapshotSource) bucket.snapshotSources.add(result.snapshotSource);
    if (result.snapshotFormat) bucket.snapshotFormats.add(result.snapshotFormat);
    if (result.interactive !== null && result.interactive !== undefined) {
      bucket.interactives.add(String(result.interactive));
    }
    if (result.fallbackReason) bucket.fallbackReasons.add(result.fallbackReason);

    grouped[label] = bucket;
  }

  return sortKeys(
    Object.fromEntries(
      Object.entries(grouped).map(([label, bucket]) => {
        const primaryMetricName = primaryMetricNameForLabel(label);
        const primaryMetricStats = primaryMetricName
          ? computeStats(bucket.serverTimingValues[primaryMetricName] ?? [])
          : null;

        return [
          label,
          {
            count: bucket.totalMsValues.length,
            statuses: sortKeys(bucket.statuses),
            totalMs: computeStats(bucket.totalMsValues),
            sizeBytes: computeStats(bucket.sizeBytesValues),
            primaryMetricName,
            primaryMetricMs: primaryMetricStats,
            serverTimingMs: sortKeys(
              Object.fromEntries(
                Object.entries(bucket.serverTimingValues)
                  .map(([metricName, values]) => [metricName, computeStats(values)])
                  .filter(([, stats]) => stats !== null),
              ),
            ),
            transports: [...bucket.transports].sort(),
            connectionPaths: [...bucket.connectionPaths].sort(),
            snapshotSources: [...bucket.snapshotSources].sort(),
            snapshotFormats: [...bucket.snapshotFormats].sort(),
            interactives: [...bucket.interactives].sort(),
            fallbackReasons: [...bucket.fallbackReasons].sort(),
          },
        ];
      }),
    ),
  );
}

function parseThreshold(env, key) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number of milliseconds`);
  }
  return roundMs(value);
}

function uniqueValues(results, label, field) {
  return [...new Set(
    results
      .filter((result) => result.label === label)
      .map((result) => result[field])
      .filter((value) => value !== null && value !== undefined && value !== ""),
  )].sort();
}

function normalizeBooleanString(value) {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return "true";
  if (normalized === "false") return "false";
  return value;
}

export function evaluateBenchAssertions(results, summary, env = process.env) {
  const failures = [];

  for (const result of results) {
    if (result.status < 200 || result.status >= 300) {
      failures.push(`${result.label} returned HTTP ${result.status}`);
    }
  }

  const expectations = [
    {
      key: "TERMINAL_BENCH_EXPECT_TRANSPORT",
      label: "connection",
      field: "transport",
      description: "transport",
    },
    {
      key: "TERMINAL_BENCH_EXPECT_CONNECTION_PATH",
      label: "connection",
      field: "connectionPath",
      description: "connection path",
    },
    {
      key: "TERMINAL_BENCH_EXPECT_SNAPSHOT_SOURCE",
      label: "snapshot_live",
      field: "snapshotSource",
      description: "snapshot source",
    },
    {
      key: "TERMINAL_BENCH_EXPECT_SNAPSHOT_RESTORED",
      label: "snapshot_live",
      field: "snapshotRestored",
      description: "snapshot restored flag",
    },
  ];

  for (const expectation of expectations) {
    const expectedValue = env[expectation.key];
    if (expectedValue === undefined || String(expectedValue).trim() === "") {
      continue;
    }
    const expected = normalizeBooleanString(String(expectedValue).trim());
    const observed = uniqueValues(results, expectation.label, expectation.field).map(normalizeBooleanString);
    if (observed.length === 0) {
      failures.push(`${expectation.description} was not captured for ${expectation.label}`);
      continue;
    }
    if (observed.length !== 1 || observed[0] !== expected) {
      failures.push(
        `${expectation.description} expected ${expected} but observed ${observed.join(", ")}`,
      );
    }
  }

  const thresholds = [
    {
      key: "TERMINAL_BENCH_ASSERT_CONNECTION_MS",
      label: "connection",
      description: "connection latency",
    },
    {
      key: "TERMINAL_BENCH_ASSERT_SNAPSHOT_MS",
      label: "snapshot_live",
      description: "live snapshot latency",
    },
    {
      key: "TERMINAL_BENCH_ASSERT_RESIZE_MS",
      label: "resize",
      description: "resize latency",
    },
  ];

  for (const threshold of thresholds) {
    const budgetMs = parseThreshold(env, threshold.key);
    if (budgetMs === null) {
      continue;
    }

    const bucket = summary[threshold.label];
    if (!bucket) {
      failures.push(`${threshold.description} summary is missing`);
      continue;
    }

    const sourceLabel = bucket.primaryMetricMs ? bucket.primaryMetricName : "total request time";
    const observedP95 = bucket.primaryMetricMs?.p95 ?? bucket.totalMs?.p95 ?? null;
    if (observedP95 === null) {
      failures.push(`${threshold.description} p95 is unavailable`);
      continue;
    }

    if (observedP95 > budgetMs) {
      failures.push(
        `${threshold.description} p95 ${observedP95.toFixed(1)}ms exceeded budget ${budgetMs.toFixed(1)}ms (${sourceLabel})`,
      );
    }
  }

  return failures;
}

export function formatStats(stats) {
  if (!stats) {
    return "n/a";
  }
  return `count=${stats.count} min=${stats.min.toFixed(1)}ms avg=${stats.avg.toFixed(1)}ms p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`;
}
