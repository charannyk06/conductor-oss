import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

const originalBackendUrl = process.env.CONDUCTOR_BACKEND_URL;
const originalConfigPath = process.env.CO_CONFIG_PATH;
const originalWorkspace = process.env.CONDUCTOR_WORKSPACE;
const originalRequireAuth = process.env.CONDUCTOR_REQUIRE_AUTH;
const originalFetch = global.fetch;

function resetEnv(): void {
  process.env.CONDUCTOR_BACKEND_URL = "http://127.0.0.1:4749";
  process.env.CO_CONFIG_PATH = "/tmp/conductor-session-send-route-test-config-does-not-exist.yaml";
  process.env.CONDUCTOR_WORKSPACE = "";
  process.env.CONDUCTOR_REQUIRE_AUTH = "";
}

test.afterEach(() => {
  resetEnv();
  global.fetch = originalFetch;
});

test.after(() => {
  for (const [name, value] of [
    ["CONDUCTOR_BACKEND_URL", originalBackendUrl],
    ["CO_CONFIG_PATH", originalConfigPath],
    ["CONDUCTOR_WORKSPACE", originalWorkspace],
    ["CONDUCTOR_REQUIRE_AUTH", originalRequireAuth],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = originalFetch;
});

test("POST proxies notes and messages to the selected session", async () => {
  resetEnv();
  let seenUrl = "";
  let seenBody = "";
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    seenBody = init?.body instanceof ArrayBuffer
      ? new TextDecoder().decode(init.body)
      : String(init?.body);
    assert.equal(init?.method, "POST");
    return Response.json({ success: true });
  }) as typeof fetch;

  const response = await POST(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify({ message: "Review this note", attachments: ["notes/brief.md"] }),
    }),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(seenUrl, "http://127.0.0.1:4749/api/sessions/session-1/send");
  assert.deepEqual(JSON.parse(seenBody), {
    message: "Review this note",
    attachments: ["notes/brief.md"],
  });
  assert.equal(response.status, 200);
});

test("POST rejects cross-origin session mutations before backend I/O", async () => {
  resetEnv();
  let called = false;
  global.fetch = (async () => {
    called = true;
    return Response.json({ success: true });
  }) as typeof fetch;

  const response = await POST(
    new NextRequest("http://127.0.0.1:3000/api/sessions/session-1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ message: "unsafe" }),
    }),
    { params: Promise.resolve({ id: "session-1" }) },
  );

  assert.equal(response.status, 403);
  assert.equal(called, false);
});
