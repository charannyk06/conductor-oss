import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenClawDispatcherAdapter,
  classifyDispatcherFeedEntry,
  dispatcherEntriesFromEvent,
} from "./adapter.js";
import { ConductorDispatcherClient } from "./client.js";
import type { DispatcherBinding, DispatcherFeedDelta, DispatcherFeedEntry } from "./types.js";

function makeBinding(overrides: Partial<DispatcherBinding> = {}): DispatcherBinding {
  return {
    id: "binding-1",
    projectId: "proj-a",
    provider: "openclaw",
    threadId: "discord-thread-42",
    sessionId: "openclaw-session-9",
    channelId: "discord-channel-7",
    bridgeId: null,
    dispatcherThreadId: "dispatcher-1",
    title: "OpenClaw thread",
    metadata: {},
    createdAt: "2026-03-29T00:00:00Z",
    updatedAt: "2026-03-29T00:00:00Z",
    dispatcherThread: { id: "dispatcher-1" },
    dispatcherEndpoints: {
      dispatcher: "/api/projects/proj-a/dispatcher?threadId=dispatcher-1",
      feed: "/api/projects/proj-a/dispatcher/feed?threadId=dispatcher-1",
      stream: "/api/projects/proj-a/dispatcher/feed/stream?threadId=dispatcher-1",
      send: "/api/projects/proj-a/dispatcher/send?threadId=dispatcher-1",
      interrupt: "/api/projects/proj-a/dispatcher/interrupt?threadId=dispatcher-1",
      tasks: "/api/projects/proj-a/dispatcher/tasks?threadId=dispatcher-1",
    },
    ...overrides,
  };
}

test("ensureBinding reuses an existing dispatcher-scoped binding", async () => {
  const calls: string[] = [];
  const client = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const adapter = new OpenClawDispatcherAdapter(client);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ binding: makeBinding() }), { status: 200 });
  };
  try {
    const binding = await adapter.ensureBinding("proj-a", { threadId: "discord-thread-42" });
    assert.equal(binding.id, "binding-1");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /dispatcher\/bindings\?provider=openclaw&threadId=discord-thread-42/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("ensureBinding creates a dispatcher binding when none exists", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const client = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const adapter = new OpenClawDispatcherAdapter(client);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: String(init?.body ?? ""),
    });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ binding: null }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        binding: makeBinding({ title: "New OpenClaw thread" }),
      }),
      { status: 201 },
    );
  };
  try {
    const binding = await adapter.ensureBinding(
      "proj-a",
      {
        threadId: "discord-thread-42",
        sessionId: "openclaw-session-9",
        channelId: "discord-channel-7",
      },
      {
        implementationAgent: "codex",
        title: "New OpenClaw thread",
      },
    );
    assert.equal(binding.title, "New OpenClaw thread");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].body, /"createDispatcher":true/);
    assert.match(calls[1].body, /"implementationAgent":"codex"/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("ensureBinding refreshes an existing binding when the external session changes", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const client = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const adapter = new OpenClawDispatcherAdapter(client);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: String(init?.body ?? ""),
    });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          binding: makeBinding({ sessionId: "openclaw-session-old" }),
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        binding: makeBinding({ sessionId: "openclaw-session-new" }),
      }),
      { status: 201 },
    );
  };
  try {
    const binding = await adapter.ensureBinding("proj-a", {
      threadId: "discord-thread-42",
      sessionId: "openclaw-session-new",
    });
    assert.equal(binding.sessionId, "openclaw-session-new");
    assert.equal(calls.length, 2);
    assert.match(calls[1].body, /"sessionId":"openclaw-session-new"/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("send scopes the request to the bound dispatcher thread", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const client = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const adapter = new OpenClawDispatcherAdapter(client);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: String(init?.body ?? ""),
    });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          binding: makeBinding({ bridgeId: "bridge-9" }),
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, threadId: "dispatcher-1" }), { status: 200 });
  };
  try {
    const result = await adapter.send(
      "proj-a",
      { threadId: "discord-thread-42" },
      { message: "Queue the next task" },
    );
    assert.equal(result.response.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /dispatcher\/send\?bridgeId=bridge-9&threadId=dispatcher-1/);
    assert.match(calls[1].body, /"message":"Queue the next task"/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("streamFeed normalizes the first SSE snapshot through the adapter", async () => {
  const client = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const adapter = new OpenClawDispatcherAdapter(client);
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ binding: makeBinding() }), { status: 200 });
    }
    return new Response(
      'data: {"entries":[],"totalEntries":0,"windowLimit":120,"truncated":false,"sessionStatus":null,"approvalState":null,"parserState":null,"runtimeStatus":null,"source":"conversation-only","error":null,"integration":null}\n\n',
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };
  try {
    const iter = adapter.streamFeed("proj-a", { threadId: "discord-thread-42" });
    const first = await iter.next();
    assert.equal(first.done, false);
    const replace = first.value as Extract<DispatcherFeedDelta, { type: "replace" }>;
    assert.equal(replace.type, "replace");
    assert.deepEqual(replace.payload.entries, []);
  } finally {
    globalThis.fetch = orig;
  }
});

test("classifyDispatcherFeedEntry maps lifecycle and heartbeat events", () => {
  const lifecycleEntry: DispatcherFeedEntry = {
    id: "e1",
    kind: "status",
    label: "Status",
    text: "Task created",
    createdAt: null,
    attachments: [],
    source: "runtime",
    streaming: false,
    metadata: { eventType: "dispatcher_task_created" },
  };
  const heartbeatEntry: DispatcherFeedEntry = {
    id: "e2",
    kind: "status",
    label: "Heartbeat",
    text: "Still working",
    createdAt: null,
    attachments: [],
    source: "acp_heartbeat",
    streaming: false,
    metadata: {},
  };
  assert.equal(classifyDispatcherFeedEntry(lifecycleEntry), "task_created");
  assert.equal(classifyDispatcherFeedEntry(heartbeatEntry), "heartbeat");
});

test("dispatcherEntriesFromEvent extracts entries from patch events", () => {
  const entry: DispatcherFeedEntry = {
    id: "assistant-1",
    kind: "assistant",
    label: "Assistant",
    text: "Working on it",
    createdAt: null,
    attachments: [],
    source: "runtime",
    streaming: true,
    metadata: {},
  };
  const event: DispatcherFeedDelta = {
    type: "patch",
    entryId: "assistant-1",
    entry,
    textDelta: " on it",
    totalEntries: 1,
    windowLimit: 120,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "runtime-output",
    error: null,
    integration: null,
  };
  assert.deepEqual(dispatcherEntriesFromEvent(event), [entry]);
});
