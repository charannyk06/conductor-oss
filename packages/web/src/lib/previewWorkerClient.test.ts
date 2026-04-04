import assert from "node:assert/strict";
import test from "node:test";
import { getPreviewWorkerClient } from "./previewWorkerClient";

const env = process.env as Record<string, string | undefined>;
const originalWorkerUrl = env.CONDUCTOR_PREVIEW_WORKER_URL;
const originalWorkerKey = env.CONDUCTOR_PREVIEW_WORKER_KEY;
const originalFetch = global.fetch;

function resetWorkerSingleton(): void {
  const g = globalThis as typeof globalThis & {
    _conductorPreviewWorkerClient?: unknown;
  };
  delete g._conductorPreviewWorkerClient;
}

function restoreEnv(): void {
  if (originalWorkerUrl === undefined) {
    delete env.CONDUCTOR_PREVIEW_WORKER_URL;
  } else {
    env.CONDUCTOR_PREVIEW_WORKER_URL = originalWorkerUrl;
  }
  if (originalWorkerKey === undefined) {
    delete env.CONDUCTOR_PREVIEW_WORKER_KEY;
  } else {
    env.CONDUCTOR_PREVIEW_WORKER_KEY = originalWorkerKey;
  }
}

test.afterEach(() => {
  resetWorkerSingleton();
  restoreEnv();
  global.fetch = originalFetch;
});

test("getStatus reports configuration error when preview worker env is missing", async () => {
  delete env.CONDUCTOR_PREVIEW_WORKER_URL;
  delete env.CONDUCTOR_PREVIEW_WORKER_KEY;

  const client = getPreviewWorkerClient();
  const status = await client.getStatus("session-a", ["http://127.0.0.1:3000/"]);

  assert.equal(status.connected, false);
  assert.equal(status.lastError, "Preview worker is not configured");
});

test("getStatus returns disconnected without lastError when worker is configured but no remote session exists", async () => {
  env.CONDUCTOR_PREVIEW_WORKER_URL = "http://127.0.0.1:3099";
  env.CONDUCTOR_PREVIEW_WORKER_KEY = "unit-test-key";

  const client = getPreviewWorkerClient();
  const status = await client.getStatus("session-b", ["https://preview.example.com/"]);

  assert.equal(status.connected, false);
  assert.equal(status.lastError, null);
});

test("runCommand creates a remote session and posts the command to the worker", async () => {
  env.CONDUCTOR_PREVIEW_WORKER_URL = "http://127.0.0.1:3099";
  env.CONDUCTOR_PREVIEW_WORKER_KEY = "unit-test-key";

  const calls: string[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (url.endsWith("/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ sessionId: "remote-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/sessions/remote-1/command")) {
      return new Response(JSON.stringify({ kind: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const client = getPreviewWorkerClient();
  await client.runCommand("session-c", { command: "reload" });

  assert.ok(calls.some((c) => c.includes("POST") && c.endsWith("/sessions")));
  assert.ok(calls.some((c) => c.includes("POST") && c.includes("/sessions/remote-1/command")));
});
