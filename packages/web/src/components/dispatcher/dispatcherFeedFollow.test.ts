import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDispatcherFeedEntryUpdates,
  collectDispatcherChangedFeedEntryIds,
  createDispatcherFeedGestureIntentDeadline,
  hasDispatcherFeedGestureIntent,
  reduceDispatcherFeedFollowOnScroll,
  resetDispatcherFeedFollowState,
} from "./dispatcherFeedFollow";

function makeEntry(id: string, text: string, streaming = false) {
  return {
    id,
    kind: "assistant" as const,
    label: "assistant",
    text,
    createdAt: "2026-07-27T00:00:00.000Z",
    attachments: [],
    source: "test",
    streaming,
    metadata: {},
  };
}

test("programmatic downward scroll cannot disable follow-latest", () => {
  const next = reduceDispatcherFeedFollowOnScroll(
    resetDispatcherFeedFollowState(),
    {
      nearBottom: false,
      previousScrollTop: 420,
      scrollTop: 640,
      isUserInitiated: false,
    },
  );

  assert.deepEqual(next, resetDispatcherFeedFollowState());
});

test("recent explicit gesture intent enables an upward scroll to disable follow-latest", () => {
  const deadline = createDispatcherFeedGestureIntentDeadline(100);
  assert.equal(hasDispatcherFeedGestureIntent(deadline, 419), true);
  assert.equal(hasDispatcherFeedGestureIntent(deadline, 421), false);

  const next = reduceDispatcherFeedFollowOnScroll(
    resetDispatcherFeedFollowState(),
    {
      nearBottom: false,
      previousScrollTop: 640,
      scrollTop: 420,
      isUserInitiated: true,
    },
  );

  assert.deepEqual(next, {
    followLatest: false,
    showJumpToLatest: true,
    unseenCount: 0,
    unseenEntryIds: [],
  });
});

test("momentum reaching bottom after the gesture deadline restores follow-latest", () => {
  const deadline = createDispatcherFeedGestureIntentDeadline(100);
  assert.equal(hasDispatcherFeedGestureIntent(deadline, 421), false);

  const next = reduceDispatcherFeedFollowOnScroll(
    {
      followLatest: false,
      showJumpToLatest: true,
      unseenCount: 3,
      unseenEntryIds: ["assistant-1", "assistant-2", "assistant-3"],
    },
    {
      nearBottom: true,
      previousScrollTop: 420,
      scrollTop: 980,
      isUserInitiated: false,
    },
  );

  assert.deepEqual(next, resetDispatcherFeedFollowState());
});

test("patch-only updates count each changed row once while follow-latest is disabled", () => {
  const previousEntries = [makeEntry("assistant-1", "hello", true)];
  const patchedEntries = [makeEntry("assistant-1", "hello world", true)];

  const changedEntryIds = collectDispatcherChangedFeedEntryIds(previousEntries, patchedEntries);
  assert.deepEqual(changedEntryIds, ["assistant-1"]);

  const next = applyDispatcherFeedEntryUpdates(
    {
      followLatest: false,
      showJumpToLatest: true,
      unseenCount: 0,
      unseenEntryIds: [],
    },
    changedEntryIds,
  );

  assert.deepEqual(next, {
    followLatest: false,
    showJumpToLatest: true,
    unseenCount: 1,
    unseenEntryIds: ["assistant-1"],
  });
});

test("repeated patches to the same row do not inflate unseen count", () => {
  const next = applyDispatcherFeedEntryUpdates(
    {
      followLatest: false,
      showJumpToLatest: true,
      unseenCount: 1,
      unseenEntryIds: ["assistant-1"],
    },
    ["assistant-1", "assistant-1"],
  );

  assert.deepEqual(next, {
    followLatest: false,
    showJumpToLatest: true,
    unseenCount: 1,
    unseenEntryIds: ["assistant-1"],
  });
});

test("new updates clear unseen tracking when follow-latest is active", () => {
  const next = applyDispatcherFeedEntryUpdates(
    {
      followLatest: true,
      showJumpToLatest: false,
      unseenCount: 2,
      unseenEntryIds: ["assistant-1", "assistant-2"],
    },
    ["assistant-3"],
  );

  assert.deepEqual(next, resetDispatcherFeedFollowState());
});

test("send or thread reset restores follow-latest and clears unseen tracking", () => {
  assert.deepEqual(resetDispatcherFeedFollowState(), {
    followLatest: true,
    showJumpToLatest: false,
    unseenCount: 0,
    unseenEntryIds: [],
  });
});
