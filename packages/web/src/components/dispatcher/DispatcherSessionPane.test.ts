import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_FEED_PAYLOAD, applyFeedDelta } from "./dispatcherFeedState.js";

function makeEntry(id: string, text: string, streaming = false) {
  return {
    id,
    kind: "assistant" as const,
    label: "assistant",
    text,
    createdAt: "2026-04-10T00:00:00.000Z",
    attachments: [],
    source: "test",
    streaming,
    metadata: {},
  };
}

test("applyFeedDelta dedupes append entries by id", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("entry-1", "hello", true)],
  };

  const next = applyFeedDelta(current, {
    type: "append",
    entries: [makeEntry("entry-1", "hello world", false), makeEntry("entry-2", "second", false)],
    totalEntries: 2,
    windowLimit: 200,
    truncated: false,
    sessionStatus: "running",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "stream",
    error: null,
    integration: null,
  });

  assert.equal(next.entries.length, 2);
  assert.equal(next.entries[0]?.id, "entry-1");
  assert.equal(next.entries[0]?.text, "hello world");
  assert.equal(next.entries[1]?.id, "entry-2");
});

test("applyFeedDelta patch appends textDelta onto the existing entry text", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("entry-1", "hello", true)],
  };

  const delta = {
    type: "patch" as const,
    entryId: "entry-1",
    entry: makeEntry("entry-1", "hello world", true),
    textDelta: " world",
    totalEntries: 1,
    windowLimit: 200,
    truncated: false,
    sessionStatus: "running",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "stream",
    error: null,
    integration: null,
  };

  const next = applyFeedDelta(current, delta);

  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0]?.text, "hello world");

  const replayed = applyFeedDelta(next, delta);
  assert.equal(replayed.entries.length, 1);
  assert.equal(replayed.entries[0]?.text, "hello world");
});

test("applyFeedDelta keeps dispatcher runtime errors in sync with feed updates", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    error: "old runtime error",
  };

  const next = applyFeedDelta(current, {
    type: "append",
    entries: [makeEntry("entry-1", "retrying", false)],
    totalEntries: 1,
    windowLimit: 200,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "stream",
    error: null,
    integration: null,
  });

  assert.equal(next.error, null);
});
