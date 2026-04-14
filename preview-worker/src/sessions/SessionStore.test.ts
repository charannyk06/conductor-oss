import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "./SessionStore.js";
import type { PreviewSession } from "../lib/types.js";

function buildSession(id: string, apiKey: string, clientSessionId: string | null): PreviewSession {
  return {
    id,
    apiKey,
    clientSessionId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    browser: {} as PreviewSession["browser"],
    page: {} as PreviewSession["page"],
    tunnelUrl: null,
    tunnelProcess: null,
    tunnelLocalOrigin: null,
    bridgePreview: null,
    status: "active",
    activeFrameId: null,
    selectedElement: null,
    consoleLogs: [],
    networkLogs: [],
    lastError: null,
    frameIds: new WeakMap(),
    frameSequence: 0,
    requestStarts: new WeakMap(),
    requestInterceptionEnabled: false,
    lastRequestedUrl: null,
  };
}

test("findByApiKeyAndClientSessionId returns the matching session only for the same API key", () => {
  const store = new SessionStore(60_000);
  const target = buildSession("preview-1", "key-a", "session-1");
  const otherKey = buildSession("preview-2", "key-b", "session-1");
  store.set(target);
  store.set(otherKey);

  assert.equal(store.findByApiKeyAndClientSessionId("key-a", "session-1")?.id, "preview-1");
  assert.equal(store.findByApiKeyAndClientSessionId("key-b", "session-1")?.id, "preview-2");
  assert.equal(store.findByApiKeyAndClientSessionId("key-a", "missing"), undefined);
});

test("listByApiKey returns all sessions for the same API key, including legacy sessions without a clientSessionId", () => {
  const store = new SessionStore(60_000);
  const reused = buildSession("preview-1", "key-a", "session-1");
  const legacy = buildSession("preview-legacy", "key-a", null);
  const otherKey = buildSession("preview-2", "key-b", "session-1");
  store.set(reused);
  store.set(legacy);
  store.set(otherKey);

  assert.deepEqual(
    store.listByApiKey("key-a").map((session) => session.id).sort(),
    ["preview-1", "preview-legacy"],
  );
  assert.equal(store.countByApiKey("key-a"), 2);
});
