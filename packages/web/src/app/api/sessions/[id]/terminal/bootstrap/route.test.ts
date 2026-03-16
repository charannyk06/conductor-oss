import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalFetch = global.fetch;

function resetEnv(): void {
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
}

test.afterEach(() => {
  resetEnv();
});

test.after(() => {
  if (originalBackendUrl === undefined) {
    delete process.env.CONDUCTOR_BACKEND_URL;
  } else {
    process.env.CONDUCTOR_BACKEND_URL = originalBackendUrl;
  }
  global.fetch = originalFetch;
});

test("GET proxies the backend-owned terminal bootstrap payload and preserves query parameters", async () => {
  resetEnv();
  const requests: string[] = [];

  global.fetch = (async (input: string | Request | URL) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);
    requests.push(`${url.pathname}${url.search}`);

    return new Response(JSON.stringify({
      connection: {
        transport: "eventstream",
        wsUrl: "/api/sessions/session-1/terminal/stream",
        pollIntervalMs: 700,
        interactive: true,
        requiresToken: false,
        tokenExpiresInSeconds: null,
        fallbackReason: "proxied",
        connectionPath: "dashboard_proxy",
        stream: {
          transport: "eventstream",
          wsUrl: "/api/sessions/session-1/terminal/stream",
          pollIntervalMs: 700,
          fallbackUrl: "/api/sessions/session-1/terminal/stream",
        },
        control: {
          transport: "http",
          wsUrl: null,
          interactive: true,
          requiresToken: false,
          tokenExpiresInSeconds: null,
          fallbackReason: "proxied",
          sendPath: "/api/sessions/session-1/send",
          keysPath: "/api/sessions/session-1/keys",
          resizePath: "/api/sessions/session-1/terminal/resize",
        },
      },
      snapshot: {
        snapshot: "prompt> ",
        transcript: "prompt>",
        source: "terminal_state",
        live: true,
        restored: true,
        sequence: 13,
      },
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-conductor-terminal-transport": "eventstream",
        "x-conductor-terminal-interactive": "true",
        "x-conductor-terminal-connection-path": "dashboard_proxy",
      },
    });
  }) as typeof fetch;

  const response = await GET(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/terminal/bootstrap?lines=4096"),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-conductor-terminal-transport"),
    "eventstream",
  );
  assert.equal(
    response.headers.get("x-conductor-terminal-interactive"),
    "true",
  );
  assert.equal(
    response.headers.get("x-conductor-terminal-connection-path"),
    "dashboard_proxy",
  );

  const payload = await response.json() as Record<string, unknown>;
  assert.ok(payload["connection"]);
  assert.ok(payload["snapshot"]);
  assert.deepEqual(requests, [
    "/api/sessions/session-1/terminal/bootstrap?lines=4096",
  ]);
});
