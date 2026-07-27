import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("dispatcher session pane derives context-file requests from apiPaths and cancels stale requests", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /contextFiles\?: string;/);
  assert.match(source, /contextFiles: apiPaths\.contextFiles \?\? "\/api\/context-files"/);
  assert.match(source, /function buildDispatcherContextFilesRequestPath\(path: string, projectId: string\): string/);
  assert.match(source, /url\.searchParams\.set\("projectId", projectId\)/);
  assert.match(source, /const abortController = new AbortController\(\);/);
  assert.match(source, /signal,\s*\n\s*}\s*,?\s*\n\s*\)/);
  assert.match(source, /if \(signal\.aborted \|\| isAbortError\(error\)\) \{\s*return;\s*\}/);
  assert.match(source, /if \(!signal\.aborted\) \{\s*setContextLoading\(false\);\s*\}/);
});

test("dispatcher session pane keeps loadFeed last-request-wins and renders banners from presented payload", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /const loadFeedGenerationRef = useRef\(0\);/);
  assert.match(source, /loadFeedGenerationRef\.current \+= 1;/);
  assert.match(source, /const requestGeneration = loadFeedGenerationRef\.current \+ 1;/);
  assert.match(source, /const isLatestRequest = \(\) => loadFeedGenerationRef\.current === requestGeneration;/);
  assert.match(source, /if \(!isLatestRequest\(\)\) \{\s*return;\s*\}/);
  assert.match(source, /if \(isLatestRequest\(\)\) \{\s*setLoading\(false\);\s*\}/);
  assert.match(source, /presentedPayload\.parserState \|\| presentedPayload\.truncated/);
  assert.match(source, /presentedPayload\.parserState\.command/);
  assert.match(source, /presentedPayload\.windowLimit/);
});

test("dispatcher session pane restores follow-latest on thread changes and new sends", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[feedFollowState, setFeedFollowState\] = useState<DispatcherFeedFollowState>/);
  assert.match(source, /const restoreFeedFollowState = useCallback\(\(\) => \{/);
  assert.match(source, /restoreFeedFollowState\(\);\s*lastFeedScrollTopRef\.current = 0;\s*ignoredFeedScrollEventsRef\.current = 0;\s*recentFeedGestureIntentDeadlineRef\.current = 0;/);
  assert.match(source, /const nextPendingUserEntry = \{/);
  assert.match(source, /restoreFeedFollowState\(\);\s*pendingUserEntryRef\.current = nextPendingUserEntry;/);
});

test("dispatcher session pane distinguishes user scroll intent from programmatic follow-to-bottom work", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /ref=\{feedRef\}\s+role="region"\s+aria-label="Dispatcher conversation"\s+tabIndex=\{0\}/);
  assert.match(source, /ignoredFeedScrollEventsRef\.current \+= 1;/);
  assert.match(source, /const markFeedGestureIntent = useCallback\(\(\) => \{/);
  assert.match(source, /createDispatcherFeedGestureIntentDeadline\(performance\.now\(\)\)/);
  assert.match(source, /reduceDispatcherFeedFollowOnScroll\(current, \{/);
  assert.match(source, /isUserInitiated: false/);
  assert.match(source, /hasDispatcherFeedGestureIntent\(recentFeedGestureIntentDeadlineRef\.current, now\)/);
  assert.match(source, /onWheelCapture=\{markFeedGestureIntent\}/);
  assert.match(source, /onTouchStartCapture=\{markFeedGestureIntent\}/);
  assert.match(source, /onTouchMoveCapture=\{markFeedGestureIntent\}/);
  assert.match(source, /onPointerDownCapture=\{markFeedGestureIntent\}/);
  assert.match(source, /onKeyDownCapture=\{handleFeedKeyDownCapture\}/);
  assert.match(source, /visualViewport\.addEventListener\("resize", handleViewportChange\)/);
  assert.match(source, /visualViewport\.addEventListener\("scroll", handleViewportChange\)/);
  assert.match(source, /onFocus=\{\(\) => \{\s*if \(!feedFollowStateRef\.current\.followLatest\)/);
});

test("dispatcher session pane keeps an accessible live working indicator at the bottom while active", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /Dispatcher is working…/);
});

test("dispatcher session pane dialogs expose sr-only descriptions", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /<Dialog\.Description className="sr-only">\s*Review and adjust the dispatcher runtime and default task handoff preferences for this conversation\.\s*<\/Dialog\.Description>/);
  assert.match(source, /<Dialog\.Description className="sr-only">\s*Search project context files and select workspace attachments to add to the next dispatcher message\.\s*<\/Dialog\.Description>/);
});
