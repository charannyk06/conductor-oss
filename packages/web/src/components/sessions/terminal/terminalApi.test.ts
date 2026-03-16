import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCachedTerminalConnection,
  readCachedTerminalConnection,
  storeCachedTerminalConnection,
} from "./terminalCache";
import {
  fetchFastBootstrap,
  fetchTerminalSnapshot,
  postSessionTerminalKeys,
  postTerminalResize,
} from "./terminalApi";
import type { TerminalConnectionInfo } from "./terminalTypes";

const originalFetch = global.fetch;

function makeConnection(
  sessionId: string,
  overrides?: Partial<TerminalConnectionInfo>,
): TerminalConnectionInfo {
  return {
    connectionPath: "direct",
    stream: {
      transport: "websocket",
      wsUrl: `wss://terminal.example/${sessionId}/stream`,
      pollIntervalMs: 700,
      fallbackUrl: `/api/sessions/${sessionId}/terminal/stream`,
      ...overrides?.stream,
    },
    control: {
      transport: "websocket",
      wsUrl: `wss://terminal.example/${sessionId}/control`,
      interactive: true,
      requiresToken: true,
      tokenExpiresInSeconds: 60,
      fallbackReason: null,
      sendPath: `/api/sessions/${sessionId}/send`,
      keysPath: `/api/sessions/${sessionId}/keys`,
      resizePath: `/api/sessions/${sessionId}/terminal/resize`,
      ...overrides?.control,
    },
    ...overrides,
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
  clearCachedTerminalConnection("session-1");
  clearCachedTerminalConnection("session-2");
  clearCachedTerminalConnection("session-3");
});

test("fetchFastBootstrap resolves connection and runtime through the fast-bootstrap route", async () => {
  const requests: string[] = [];

  global.fetch = (async (input: string | Request | URL) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    requests.push(requestUrl);

    return new Response(JSON.stringify({
      connection: {
        connectionPath: "direct",
        stream: {
          transport: "websocket",
          wsUrl: "wss://localhost:4749/session-1/stream",
          pollIntervalMs: 700,
          fallbackUrl: "/api/sessions/session-1/terminal/stream",
        },
        control: {
          transport: "websocket",
          wsUrl: "wss://localhost:4749/session-1/control",
          interactive: true,
          requiresToken: true,
          tokenExpiresInSeconds: 60,
          fallbackReason: null,
          sendPath: "/api/sessions/session-1/send",
          keysPath: "/api/sessions/session-1/keys",
          resizePath: "/api/sessions/session-1/terminal/resize",
        },
      },
      runtime: {
        authority: "daemon",
        status: "ready",
        daemonConnected: true,
        hostPid: 4321,
        childPid: 8765,
        startedAt: "2026-03-15T10:00:00Z",
        updatedAt: "2026-03-15T10:00:02Z",
        error: null,
        notice: null,
        recoveryAction: null,
      },
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-conductor-terminal-connection-path": "direct",
      },
    });
  }) as typeof fetch;

  const bootstrap = await fetchFastBootstrap("session-1");

  assert.equal(bootstrap.connection.connectionPath, "direct");
  assert.equal(bootstrap.connection.stream.wsUrl, "wss://localhost:4749/session-1/stream");
  assert.equal(bootstrap.runtime?.authority, "daemon");
  assert.equal(bootstrap.runtime?.status, "ready");
  assert.equal(bootstrap.runtime?.hostPid, 4321);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/api/sessions/session-1/terminal/fast-bootstrap");
  assert.deepEqual(readCachedTerminalConnection("session-1"), bootstrap.connection);
});

test("postSessionTerminalKeys uses the cached control endpoint negotiated by the connection route", async () => {
  let requestUrl = "";
  let requestBody = "";

  storeCachedTerminalConnection(
    "session-2",
    makeConnection("session-2", {
      control: {
        transport: "http",
        wsUrl: null,
        interactive: true,
        requiresToken: false,
        tokenExpiresInSeconds: null,
        fallbackReason: "dashboard proxy",
        sendPath: "/api/custom/send",
        keysPath: "/api/custom/keys",
        resizePath: "/api/custom/resize",
      },
    }),
  );

  global.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
    requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    requestBody = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await postSessionTerminalKeys("session-2", { keys: "ls -la" });

  assert.equal(requestUrl, "/api/custom/keys");
  assert.equal(requestBody, JSON.stringify({ keys: "ls -la" }));
});

test("postTerminalResize uses the cached control resize endpoint negotiated by the connection route", async () => {
  let requestUrl = "";
  let requestBody = "";

  storeCachedTerminalConnection(
    "session-3",
    makeConnection("session-3", {
      control: {
        transport: "http",
        wsUrl: null,
        interactive: true,
        requiresToken: false,
        tokenExpiresInSeconds: null,
        fallbackReason: "dashboard proxy",
        sendPath: "/api/custom/send",
        keysPath: "/api/custom/keys",
        resizePath: "/api/custom/resize",
      },
    }),
  );

  global.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
    requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    requestBody = typeof init?.body === "string" ? init.body : "";
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  await postTerminalResize("session-3", 140.2, 41.8);

  assert.equal(requestUrl, "/api/custom/resize");
  assert.equal(requestBody, JSON.stringify({ cols: 140, rows: 42 }));
});

test("fetchTerminalSnapshot appends the live flag when requesting a live bootstrap snapshot", async () => {
  let requestUrl = "";

  global.fetch = (async (input: string | Request | URL) => {
    requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    return new Response(JSON.stringify({
      snapshot: "prompt> ",
      transcript: "prompt>",
      source: "terminal_state",
      live: true,
      restored: true,
      sequence: 7,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const snapshot = await fetchTerminalSnapshot("session-1", 2048, { live: true });

  assert.match(requestUrl, /\/api\/sessions\/session-1\/terminal\/snapshot\?lines=2048&live=1$/);
  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.live, true);
  assert.equal(snapshot.snapshot, "prompt>");
});

test("fetchTerminalSnapshot preserves alternate-screen ANSI snapshots instead of flattening them to transcript text", async () => {
  global.fetch = (async () => new Response(JSON.stringify({
    snapshot: "\u001b[Hfull-screen tui",
    transcript: "flattened transcript that should not be rendered",
    source: "terminal_state",
    live: false,
    restored: true,
    sequence: 9,
    modes: {
      alternateScreen: true,
      applicationKeypad: false,
      applicationCursor: false,
      hideCursor: false,
      bracketedPaste: false,
      mouseProtocolMode: "None",
      mouseProtocolEncoding: "Default",
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  const snapshot = await fetchTerminalSnapshot("session-1", 512);

  assert.equal(snapshot.sequence, 9);
  assert.equal(snapshot.snapshot, "\u001b[Hfull-screen tui");
  assert.equal(snapshot.transcript, "flattened transcript that should not be rendered");
});

test("fetchTerminalSnapshot supports raw snapshotAnsi payloads from non-terminal-state sources", async () => {
  global.fetch = (async () => new Response(JSON.stringify({
    snapshotAnsi: "prompt> ",
    source: "session_output",
    live: false,
    restored: true,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  const snapshot = await fetchTerminalSnapshot("session-1", 120);

  assert.equal(snapshot.snapshot, "prompt> ");
  assert.equal(snapshot.transcript, "");
});

test("postSessionTerminalKeys reports queueFull status when terminal input backpressure is triggered", async () => {
  let requestUrl = "";
  let requestBody = "";

  global.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
    requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    requestBody = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({
      ok: true,
      accepted: false,
      queueFull: true,
      sessionId: "session-1",
      error: "Terminal input queue is full",
    }), {
      status: 202,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  const result = await postSessionTerminalKeys("session-1", { keys: "ls" });

  assert.equal(requestUrl, "/api/sessions/session-1/keys");
  assert.equal(requestBody, JSON.stringify({ keys: "ls" }));
  assert.equal(result.accepted, false);
  assert.equal(result.queueFull, true);
});
