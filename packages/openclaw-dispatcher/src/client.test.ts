import test from "node:test";
import assert from "node:assert/strict";
import { ConductorDispatcherClient } from "./client.js";
import type { DispatcherFeedDelta } from "./types.js";

test("builds feed URL without double slashes", async () => {
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:4748/" });
  assert.equal(c.baseUrl, "http://127.0.0.1:4748");
});

test("createDispatcher POSTs camelCase body", async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: String(init?.body ?? ""),
    });
    return new Response(JSON.stringify({ thread: { id: "t1" } }), { status: 201 });
  };
  try {
    await c.createDispatcher("proj-a", { forceNew: true, dispatcherAgent: "codex" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/dispatcher"));
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].body.includes("forceNew"));
    assert.ok(calls[0].body.includes("dispatcherAgent"));
  } finally {
    globalThis.fetch = orig;
  }
});

test("patchIntegration serializes explicit null for clear", async () => {
  const calls: { url: string; body: string }[] = [];
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ thread: null }), { status: 200 });
  };
  try {
    await c.patchIntegration("proj-a", { openclawThreadId: null });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/dispatcher/integration"));
    assert.equal(calls[0].body, JSON.stringify({ openclawThreadId: null }));
  } finally {
    globalThis.fetch = orig;
  }
});

test("streamFeed requests SSE headers", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
    });
    return new Response(
      "data: {\"type\":\"append\",\"entries\":[],\"totalEntries\":0,\"windowLimit\":120,\"truncated\":false,\"sessionStatus\":null,\"approvalState\":null,\"parserState\":null,\"runtimeStatus\":null,\"source\":null,\"error\":null,\"integration\":null}\n\n",
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  };
  try {
    const iter = c.streamFeed("proj-a");
    await iter.next();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/dispatcher/feed/stream"));
    assert.equal(calls[0].headers.get("accept"), "text/event-stream");
    assert.equal(calls[0].headers.get("cache-control"), "no-cache");
  } finally {
    globalThis.fetch = orig;
  }
});

test("streamFeed yields initial raw feed snapshot as JSON (no type field)", async () => {
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"entries":[],"totalEntries":0,"windowLimit":120,"truncated":false}\n\n',
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  try {
    const iter = c.streamFeed("proj-a");
    const first = await iter.next();
    assert.equal(first.done, false);
    const v = first.value as { entries?: unknown[]; type?: string };
    assert.ok(Array.isArray(v.entries));
    assert.equal(v.type, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test("streamFeed yields patch deltas", async () => {
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      "data: {\"type\":\"patch\",\"entryId\":\"assistant-1\",\"entry\":{\"id\":\"assistant-1\",\"kind\":\"assistant\",\"label\":\"Assistant\",\"text\":\"Working on it\",\"createdAt\":null,\"attachments\":[],\"source\":\"runtime\",\"streaming\":true,\"metadata\":{}},\"textDelta\":\" on it\",\"totalEntries\":2,\"windowLimit\":120,\"truncated\":false,\"sessionStatus\":\"working\",\"approvalState\":null,\"parserState\":null,\"runtimeStatus\":null,\"source\":\"runtime-output\",\"error\":null,\"integration\":null}\n\n",
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  try {
    const iter = c.streamFeed("proj-a");
    const first = await iter.next();
    assert.equal(first.done, false);
    const patch = first.value as Extract<DispatcherFeedDelta, { type: "patch" }>;
    assert.equal(patch.type, "patch");
    assert.equal(patch.entryId, "assistant-1");
    assert.equal(patch.textDelta, " on it");
  } finally {
    globalThis.fetch = orig;
  }
});

test("streamFeedDeltas normalizes the initial raw snapshot into replace", async () => {
  const c = new ConductorDispatcherClient({ baseUrl: "http://127.0.0.1:1" });
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"entries":[],"totalEntries":0,"windowLimit":120,"truncated":false}\n\n',
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  try {
    const iter = c.streamFeedDeltas("proj-a");
    const first = await iter.next();
    assert.equal(first.done, false);
    const replace = first.value as Extract<DispatcherFeedDelta, { type: "replace" }>;
    assert.equal(replace.type, "replace");
    assert.deepEqual(replace.payload.entries, []);
  } finally {
    globalThis.fetch = orig;
  }
});
