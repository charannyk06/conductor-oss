import assert from "node:assert/strict";
import test from "node:test";

import type { SessionFeedEntry } from "./dispatcherFeedState";
import {
  applyOptimisticInterruptRecovery,
  getDispatcherToolPresentation,
  isDispatcherActiveStatus,
  isExplicitThinkingEntry,
  isPendingDispatcherEntryConfirmed,
  mergePendingDispatcherEntry,
  shouldClearLocalSessionStatus,
  shouldReplaceFeedPayloadOnLoadError,
  shouldShowDispatcherWorkingEntry,
} from "./dispatcherPresentation";

function makeEntry(overrides: Partial<SessionFeedEntry>): SessionFeedEntry {
  return {
    id: overrides.id ?? "entry-1",
    kind: overrides.kind ?? "assistant",
    label: overrides.label ?? "assistant",
    text: overrides.text ?? "",
    createdAt: overrides.createdAt ?? "2026-07-25T18:00:00.000Z",
    attachments: overrides.attachments ?? [],
    source: overrides.source ?? "runtime",
    streaming: overrides.streaming ?? false,
    metadata: overrides.metadata ?? {},
  };
}

test("isExplicitThinkingEntry only flags explicit thinking tools", () => {
  assert.equal(
    isExplicitThinkingEntry(makeEntry({
      kind: "tool",
      metadata: { toolKind: "thinking", toolTitle: "Thinking" },
    })),
    true,
  );
  assert.equal(
    isExplicitThinkingEntry(makeEntry({
      kind: "assistant",
      text: "Final answer",
      source: "runtime",
    })),
    false,
  );
});

test("shouldShowDispatcherWorkingEntry fills the dead interval after the latest user turn", () => {
  const entries = [
    makeEntry({ id: "user-1", kind: "user", text: "Ship it", source: "chat" }),
  ];

  assert.equal(shouldShowDispatcherWorkingEntry(entries, "working"), true);
  assert.equal(
    shouldShowDispatcherWorkingEntry(
      [...entries, makeEntry({ id: "assistant-1", kind: "assistant", text: "On it", streaming: true })],
      "working",
    ),
    true,
  );
  assert.equal(
    shouldShowDispatcherWorkingEntry(
      [...entries, makeEntry({
        id: "tool-1",
        kind: "tool",
        text: "Bash",
        metadata: { toolStatus: "completed" },
      })],
      "running",
    ),
    true,
  );
});

test("shouldShowDispatcherWorkingEntry disappears once the session becomes idle or terminal", () => {
  const entries = [
    makeEntry({ id: "user-1", kind: "user", text: "Ship it", source: "chat" }),
    makeEntry({ id: "assistant-1", kind: "assistant", text: "Done", source: "runtime" }),
  ];

  assert.equal(shouldShowDispatcherWorkingEntry(entries, "idle"), false);
  assert.equal(shouldShowDispatcherWorkingEntry(entries, "completed"), false);
  assert.equal(shouldShowDispatcherWorkingEntry(entries, "failed"), false);
  assert.equal(shouldShowDispatcherWorkingEntry([], "working"), false);
  assert.equal(
    shouldShowDispatcherWorkingEntry(
      [makeEntry({ id: "assistant-only", kind: "assistant", text: "No prompt yet" })],
      "working",
    ),
    false,
  );
});

test("mergePendingDispatcherEntry keeps optimistic sends visible until the feed confirms them", () => {
  const pending = {
    id: "pending-1",
    text: "Review attachments",
    attachments: ["docs/spec.md"],
    createdAt: "2026-07-25T18:00:00.000Z",
    feedBaselineTotalEntries: 0,
    feedBaselineLastEntryId: null,
  };

  const merged = mergePendingDispatcherEntry({ entries: [], totalEntries: 0 }, pending);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "pending-1");

  const confirmed = mergePendingDispatcherEntry({
    entries: [
      makeEntry({
        id: "server-1",
        kind: "user",
        text: "Review attachments",
        attachments: [{ path: "docs/spec.md" }],
        source: "chat",
      }),
    ],
    totalEntries: 1,
  }, pending);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]?.id, "server-1");
});

test("isPendingDispatcherEntryConfirmed ignores identical historical continue turns before the send baseline", () => {
  const pending = {
    id: "pending-continue",
    text: "continue",
    attachments: [],
    createdAt: "2026-07-26T10:00:00.000Z",
    feedBaselineTotalEntries: 2,
    feedBaselineLastEntryId: "assistant-1",
  };
  const historicalFeed = {
    entries: [
      makeEntry({ id: "user-1", kind: "user", text: "continue", source: "chat" }),
      makeEntry({ id: "assistant-1", kind: "assistant", text: "Working on it", source: "runtime" }),
    ],
    totalEntries: 2,
  };

  assert.equal(isPendingDispatcherEntryConfirmed(historicalFeed, pending), false);

  const confirmedFeed = {
    entries: [
      ...historicalFeed.entries,
      makeEntry({ id: "user-2", kind: "user", text: "continue", source: "chat" }),
    ],
    totalEntries: 3,
  };

  assert.equal(isPendingDispatcherEntryConfirmed(confirmedFeed, pending), true);
});

test("isPendingDispatcherEntryConfirmed ignores identical historical attachment-only turns before the send baseline", () => {
  const pending = {
    id: "pending-attachment",
    text: "",
    attachments: ["docs/spec.md"],
    createdAt: "2026-07-26T10:05:00.000Z",
    feedBaselineTotalEntries: 2,
    feedBaselineLastEntryId: "assistant-1",
  };
  const historicalFeed = {
    entries: [
      makeEntry({
        id: "user-1",
        kind: "user",
        text: "",
        attachments: [{ path: "docs/spec.md" }],
        source: "chat",
      }),
      makeEntry({ id: "assistant-1", kind: "assistant", text: "Attached", source: "runtime" }),
    ],
    totalEntries: 2,
  };

  assert.equal(isPendingDispatcherEntryConfirmed(historicalFeed, pending), false);
  assert.equal(mergePendingDispatcherEntry(historicalFeed, pending).at(-1)?.id, "pending-attachment");

  const confirmedFeed = {
    entries: [
      ...historicalFeed.entries,
      makeEntry({
        id: "user-2",
        kind: "user",
        text: "",
        attachments: [{ path: "docs/spec.md" }],
        source: "chat",
      }),
    ],
    totalEntries: 3,
  };

  assert.equal(isPendingDispatcherEntryConfirmed(confirmedFeed, pending), true);
});

test("getDispatcherToolPresentation preserves full tool detail lines and status", () => {
  const presentation = getDispatcherToolPresentation(makeEntry({
    kind: "tool",
    text: "Bash",
    metadata: {
      toolTitle: "Bash",
      toolKind: "bash",
      toolStatus: "running",
      toolContent: ["npm test", "packages/web", "exit 0"],
    },
  }));

  assert.deepEqual(presentation, {
    kind: "bash",
    title: "Bash",
    status: "running",
    lines: ["npm test", "packages/web", "exit 0"],
    preview: "npm test",
  });
});

test("getDispatcherToolPresentation falls back from blank tool titles to entry text or a generic label", () => {
  assert.equal(
    getDispatcherToolPresentation(makeEntry({
      kind: "tool",
      text: "  Bash  ",
      metadata: {
        toolTitle: "   ",
      },
    }))?.title,
    "Bash",
  );
  assert.equal(
    getDispatcherToolPresentation(makeEntry({
      kind: "tool",
      text: "   ",
      metadata: {
        toolTitle: "   ",
      },
    }))?.title,
    "Tool call",
  );
});

test("applyOptimisticInterruptRecovery stops streaming entries and marks running tools as interrupted", () => {
  const payload = applyOptimisticInterruptRecovery({
    entries: [
      makeEntry({ id: "user-1", kind: "user", text: "Ship it", source: "chat" }),
      makeEntry({ id: "assistant-1", kind: "assistant", text: "Working", streaming: true }),
      makeEntry({
        id: "tool-1",
        kind: "tool",
        text: "Bash",
        streaming: true,
        metadata: {
          toolTitle: "Bash",
          toolKind: "bash",
          toolStatus: "working",
          toolContent: ["bun test"],
        },
      }),
      makeEntry({ id: "status-1", kind: "status", text: "Still running", streaming: true }),
    ],
    totalEntries: 4,
    windowLimit: 120,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: {
      kind: "command",
      message: "Running tool",
      command: "bun test",
    },
    runtimeStatus: null,
    source: "session",
    error: null,
    integration: null,
  });

  assert.equal(payload.sessionStatus, "killed");
  assert.equal(payload.entries[1]?.streaming, false);
  assert.equal(payload.entries[2]?.streaming, false);
  assert.equal(payload.entries[2]?.metadata.toolStatus, "error");
  assert.equal(payload.entries[3]?.streaming, false);
  assert.equal(payload.parserState, null);
});

test("shouldReplaceFeedPayloadOnLoadError only preserves meaningful feed state when explicitly requested", () => {
  const populatedFeed = {
    entries: [makeEntry({ id: "assistant-1", text: "Recovered conversation" })],
    totalEntries: 1,
    sessionStatus: "killed",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    truncated: false,
    error: null,
  };

  assert.equal(shouldReplaceFeedPayloadOnLoadError(populatedFeed), true);
  assert.equal(
    shouldReplaceFeedPayloadOnLoadError(populatedFeed, { preserveExistingOnError: true }),
    false,
  );
  assert.equal(
    shouldReplaceFeedPayloadOnLoadError({
      entries: [],
      totalEntries: 0,
      sessionStatus: null,
      approvalState: null,
      parserState: null,
      runtimeStatus: null,
      truncated: false,
      error: null,
    }, { preserveExistingOnError: true }),
    true,
  );
  assert.equal(
    shouldReplaceFeedPayloadOnLoadError({
      entries: [],
      totalEntries: 0,
      sessionStatus: null,
      approvalState: null,
      parserState: null,
      runtimeStatus: null,
      truncated: false,
      error: null,
    }, {
      preserveExistingOnError: true,
      pendingEntry: {
        id: "pending-1",
        text: "Keep visible",
        attachments: [],
        createdAt: "2026-07-27T10:00:00.000Z",
        feedBaselineTotalEntries: 0,
        feedBaselineLastEntryId: null,
      },
    }),
    false,
  );
});

test("shouldClearLocalSessionStatus keeps optimistic killed state until the feed becomes non-active", () => {
  assert.equal(shouldClearLocalSessionStatus("killed", "working"), false);
  assert.equal(shouldClearLocalSessionStatus("killed", "killed"), true);
  assert.equal(shouldClearLocalSessionStatus("killed", "errored"), true);
  assert.equal(shouldClearLocalSessionStatus("working", "working"), true);
});

test("optimistic killed presentation survives a stale active feed until a real terminal status arrives", () => {
  const rawPayload = {
    entries: [
      makeEntry({ id: "assistant-1", kind: "assistant", text: "Working", streaming: true }),
      makeEntry({
        id: "tool-1",
        kind: "tool",
        text: "Bash",
        streaming: true,
        metadata: {
          toolTitle: "Bash",
          toolKind: "bash",
          toolStatus: "working",
          toolContent: ["bun test"],
        },
      }),
    ],
    totalEntries: 2,
    windowLimit: 120,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "session" as const,
    error: null,
    integration: null,
  };

  const localSessionStatus = "killed";
  const presentedPayload = localSessionStatus && !isDispatcherActiveStatus(localSessionStatus) && isDispatcherActiveStatus(rawPayload.sessionStatus)
    ? applyOptimisticInterruptRecovery(rawPayload)
    : rawPayload;

  assert.equal(shouldClearLocalSessionStatus(localSessionStatus, rawPayload.sessionStatus), false);
  assert.equal(rawPayload.sessionStatus, "working");
  assert.equal(rawPayload.entries[0]?.streaming, true);
  assert.equal(presentedPayload.sessionStatus, "killed");
  assert.equal(presentedPayload.entries[0]?.streaming, false);
  assert.equal(presentedPayload.entries[1]?.metadata.toolStatus, "error");
  assert.equal(shouldClearLocalSessionStatus(localSessionStatus, "idle"), true);
});
