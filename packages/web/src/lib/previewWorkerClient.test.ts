import assert from "node:assert/strict";
import test from "node:test";
import { getPreviewWorkerClient } from "./previewWorkerClient";

const env = process.env as Record<string, string | undefined>;
const originalWorkerUrl = env.CONDUCTOR_PREVIEW_WORKER_URL;
const originalWorkerKey = env.CONDUCTOR_PREVIEW_WORKER_KEY;
const originalRelayUrl = env.CONDUCTOR_BRIDGE_RELAY_URL;
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
  if (originalRelayUrl === undefined) {
    delete env.CONDUCTOR_BRIDGE_RELAY_URL;
  } else {
    env.CONDUCTOR_BRIDGE_RELAY_URL = originalRelayUrl;
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
      const body = JSON.parse(String(init.body)) as { clientSessionId?: string };
      assert.equal(body.clientSessionId, "session-c");
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

test("destroySession omits the JSON content type when deleting a worker session", async () => {
  env.CONDUCTOR_PREVIEW_WORKER_URL = "http://127.0.0.1:3099";
  env.CONDUCTOR_PREVIEW_WORKER_KEY = "unit-test-key";

  let deleteRequest: RequestInit | undefined;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;

    if (url.endsWith("/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ sessionId: "remote-delete-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/sessions/remote-delete-1/command")) {
      return new Response(JSON.stringify({ kind: "status", connected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/sessions/remote-delete-1") && init?.method === "DELETE") {
      deleteRequest = init;
      return new Response(null, { status: 204 });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const client = getPreviewWorkerClient();
  await client.runCommand("session-delete", { command: "reload" });
  await client.destroySession("session-delete");

  assert.ok(deleteRequest);
  const headers = new Headers(deleteRequest.headers);
  assert.equal(headers.get("Authorization"), "Bearer unit-test-key");
  assert.equal(headers.get("Content-Type"), null);
  assert.equal(deleteRequest.body, undefined);
});


test("configureBridgePreview forwards bridge relay metadata when creating a remote session", async () => {
  env.CONDUCTOR_PREVIEW_WORKER_URL = "http://127.0.0.1:3099";
  env.CONDUCTOR_PREVIEW_WORKER_KEY = "unit-test-key";
  env.CONDUCTOR_BRIDGE_RELAY_URL = "https://relay.example.com";

  let createBody = null as null | Record<string, unknown>;

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;

    if (url.endsWith("/sessions") && init?.method === "POST") {
      createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ sessionId: "remote-bridge-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/sessions/remote-bridge-1/command")) {
      return new Response(JSON.stringify({ kind: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const client = getPreviewWorkerClient();
  await client.configureBridgePreview(
    "session-bridge",
    {
      bridgeId: "bridge-1",
      sessionId: "session-1",
      allowedOrigins: ["http://127.0.0.1:3000"],
    },
    { Authorization: "Bearer relay-token", "x-bridge-user-id": "local-admin" },
  );

  await client.runCommand("session-bridge", { command: "reload" });

  assert.ok(createBody);
  assert.deepEqual(createBody, {
    clientSessionId: "session-bridge",
    bridgePreview: {
      bridgeId: "bridge-1",
      sessionId: "session-1",
      allowedOrigins: ["http://127.0.0.1:3000"],
      relayUrl: "https://relay.example.com/",
      forwardedHeaders: { authorization: "Bearer relay-token", "x-bridge-user-id": "local-admin" },
    },
  });
});

test("runCommand preserves actionable worker errors instead of collapsing them to service unavailable", async () => {
  env.CONDUCTOR_PREVIEW_WORKER_URL = "http://127.0.0.1:3099";
  env.CONDUCTOR_PREVIEW_WORKER_KEY = "unit-test-key";

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;

    if (url.endsWith("/sessions") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: "Timed out while waiting for a reachable cloudflared tunnel URL." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const client = getPreviewWorkerClient();
  await assert.rejects(
    () => client.runCommand("session-error", { command: "reload" }),
    /Timed out while waiting for a reachable cloudflared tunnel URL/,
  );
});
