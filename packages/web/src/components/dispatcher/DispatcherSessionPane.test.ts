import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPTY_FEED_PAYLOAD,
  applyFeedDelta,
  compactFeedPatchNeedsRefresh,
  shouldStartCompactFeedResync,
  updateDispatcherReconnectAttemptAfterConnection,
} from "./dispatcherFeedState.js";

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

function makeToolEntry(id: string, text: string) {
  return {
    id,
    kind: "tool" as const,
    label: "tool",
    text,
    createdAt: "2026-04-10T00:00:00.000Z",
    attachments: [],
    source: "test",
    streaming: false,
    metadata: {
      toolCallId: "call-1",
      toolStatus: "running",
      toolTitle: "Bash",
    },
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
    textOffset: 5,
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
  assert.equal(replayed.entries[0], next.entries[0]);
});

test("applyFeedDelta applies compact token patches without replaying them twice", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("entry-1", "hello", true)],
  };
  const delta = {
    type: "patch" as const,
    entryId: "entry-1",
    entry: null,
    textDelta: " 🌍",
    textOffset: 5,
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
  };

  const next = applyFeedDelta(current, delta);
  assert.equal(next.entries[0]?.text, "hello 🌍");
  const replayed = applyFeedDelta(next, delta);
  assert.equal(replayed.entries[0]?.text, "hello 🌍");
  assert.equal(replayed.entries[0], next.entries[0]);
});

test("applyFeedDelta applies compact token patches by entry id when a tool row follows", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("assistant-1", "hello", true), makeToolEntry("tool-1", "Bash")],
  };
  const delta = {
    type: "patch" as const,
    entryId: "assistant-1",
    entry: null,
    textDelta: " world",
    textOffset: 5,
    totalEntries: 2,
    windowLimit: 200,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "stream",
    error: null,
    integration: null,
  };

  const next = applyFeedDelta(current, delta);
  assert.equal(next.entries[0]?.text, "hello world");
  assert.equal(next.entries[1]?.id, "tool-1");
  assert.equal(next.entries[1]?.text, "Bash");
  assert.equal(next.entries[1], current.entries[1]);
});

test("compact token patches request a snapshot refresh after an offset gap", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("assistant-1", "Hello", true)],
  };
  const nextPatch = {
    type: "patch" as const,
    entryId: "assistant-1",
    entry: null,
    textDelta: " world",
    textOffset: 5,
    totalEntries: 1,
    windowLimit: 120,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "runtime",
    error: null,
    integration: null,
  };

  assert.equal(compactFeedPatchNeedsRefresh(current, nextPatch), false);
  const applied = applyFeedDelta(current, nextPatch);
  assert.equal(compactFeedPatchNeedsRefresh(applied, nextPatch), false);
  assert.equal(
    compactFeedPatchNeedsRefresh(current, { ...nextPatch, textOffset: 7 }),
    true,
  );
  assert.equal(
    compactFeedPatchNeedsRefresh(
      { ...current, entries: [] },
      nextPatch,
    ),
    true,
  );
});

test("compact token patches use UTF-16 offsets so emoji prefixes stay aligned", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("assistant-1", "Hi 👋", true)],
  };
  const delta = {
    type: "patch" as const,
    entryId: "assistant-1",
    entry: null,
    textDelta: " there",
    textOffset: 5,
    totalEntries: 1,
    windowLimit: 120,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "runtime",
    error: null,
    integration: null,
  };

  assert.equal(compactFeedPatchNeedsRefresh(current, delta), false);
  const applied = applyFeedDelta(current, delta);
  assert.equal(applied.entries[0]?.text, "Hi 👋 there");
  assert.equal(
    compactFeedPatchNeedsRefresh(current, { ...delta, textOffset: 4 }),
    true,
  );
});

test("applyFeedDelta ignores compact token patches when the offset mismatches", () => {
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [makeEntry("assistant-1", "hello", true)],
  };
  const delta = {
    type: "patch" as const,
    entryId: "assistant-1",
    entry: null,
    textDelta: " world",
    textOffset: 4,
    totalEntries: 1,
    windowLimit: 120,
    truncated: false,
    sessionStatus: "working",
    approvalState: null,
    parserState: null,
    runtimeStatus: null,
    source: "runtime",
    error: null,
    integration: null,
  };

  const next = applyFeedDelta(current, delta);
  assert.equal(next.entries[0]?.text, "hello");
  assert.equal(compactFeedPatchNeedsRefresh(current, delta), true);
});

test("rapid compact patch mismatches start only one stream resync", () => {
  assert.equal(shouldStartCompactFeedResync(false, true), true);
  assert.equal(shouldStartCompactFeedResync(true, true), false);
  assert.equal(shouldStartCompactFeedResync(false, false), false);

  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");
  assert.match(source, /compactPatchResyncPending = true;[\s\S]*streamAbortRef\.current\?\.abort\(\);[\s\S]*scheduleReconnect\(\);/);
  assert.doesNotMatch(
    source,
    /compactFeedPatchNeedsRefresh[\s\S]{0,400}loadFeed\(/,
  );
});

test("applyFeedDelta replacement preserves unchanged transcript row references", () => {
  const stableEntry = makeEntry("entry-1", "settled answer", false);
  const streamingEntry = makeEntry("entry-2", "working", true);
  const current = {
    ...EMPTY_FEED_PAYLOAD,
    entries: [stableEntry, streamingEntry],
  };

  const next = applyFeedDelta(current, {
    type: "replace",
    payload: {
      ...current,
      entries: [
        { ...stableEntry, attachments: [], metadata: {} },
        makeEntry("entry-2", "working on it", true),
      ],
    },
  });

  assert.equal(next.entries[0], stableEntry);
  assert.notEqual(next.entries[1], streamingEntry);
  assert.equal(next.entries[1]?.text, "working on it");
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
  assert.match(source, /if \(!isLatestRequest\(\) \|\| !streamHasNotAdvanced\(\)\) \{\s*return;\s*\}/);
  assert.match(source, /if \(isLatestRequest\(\)\) \{\s*setLoading\(false\);\s*\}/);
  assert.match(source, /presentedPayload\.parserState \|\| presentedPayload\.truncated/);
  assert.match(source, /presentedPayload\.parserState\.command/);
  assert.match(source, /presentedPayload\.windowLimit/);
});

test("dispatcher stream owns loading state, ignores keepalives, and protects newer stream state from stale GETs", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /const streamRevisionRef = useRef\(0\);/);
  assert.match(source, /const streamRevisionAtRequest = streamRevisionRef\.current;/);
  assert.match(source, /!isLatestRequest\(\) \|\| !streamHasNotAdvanced\(\)/);
  assert.match(source, /streamRevisionRef\.current \+= 1;\s*setLoading\(false\);/);
  assert.match(source, /if \(frame\.event === "ping"\) \{\s*lastStreamEventAtRef\.current = Date\.now\(\);\s*continue;/);
  assert.match(source, /const nextPayload = applyFeedDelta\(payloadRef\.current, delta\);\s*payloadRef\.current = nextPayload;\s*setPayload\(nextPayload\);/);
});

test("dispatcher stream only resets reconnect backoff after a proven healthy connection", () => {
  assert.equal(updateDispatcherReconnectAttemptAfterConnection(3, 0, 5_000), 3);
  assert.equal(updateDispatcherReconnectAttemptAfterConnection(3, 1, 50), 3);
  assert.equal(updateDispatcherReconnectAttemptAfterConnection(3, 1, 1_000), 0);
  assert.equal(updateDispatcherReconnectAttemptAfterConnection(3, 2, 50), 0);

  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");
  const connectStart = source.indexOf("const connect = async () =>");
  const connectEnd = source.indexOf("void connect();", connectStart);
  const connectSource = source.slice(connectStart, connectEnd);

  assert.ok(connectStart >= 0 && connectEnd > connectStart);
  assert.doesNotMatch(connectSource, /reconnectAttempt\s*=\s*0;/);
  assert.match(
    connectSource,
    /reconnectAttempt = updateDispatcherReconnectAttemptAfterConnection\(\s*reconnectAttempt,\s*validFeedFrameCount,\s*Date\.now\(\) - connectedAt,\s*\);/,
  );
});

test("dispatcher sends render optimistically before POST and use one bounded stream fallback", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");
  const sendStart = source.indexOf("const sendMessage = useCallback");
  const sendEnd = source.indexOf("const handleSend = useCallback", sendStart);
  const sendSource = source.slice(sendStart, sendEnd);
  const optimisticIndex = sendSource.indexOf("pendingUserEntryRef.current = nextPendingUserEntry");
  const postIndex = sendSource.indexOf("const response = await fetch");

  assert.ok(sendStart >= 0 && sendEnd > sendStart);
  assert.ok(optimisticIndex >= 0 && optimisticIndex < postIndex);
  assert.match(sendSource, /\|\| sendInFlightRef\.current[\s\S]*sendInFlightRef\.current = true;/);
  assert.match(sendSource, /finally \{\s*sendInFlightRef\.current = false;\s*setSending\(false\);/);
  assert.match(source, /\(\) => pendingUserEntry \|\| sending\s*\? "working"/);
  assert.match(sendSource, /window\.setTimeout\([\s\S]*DISPATCHER_SEND_STREAM_FALLBACK_MS/);
  assert.match(sendSource, /streamRevisionRef\.current !== streamRevisionAtAcknowledgement/);
  assert.match(sendSource, /setPendingUserEntry\(\(current\) => current\?\.id === nextPendingUserEntry\.id \? null : current\)/);
});

test("dispatcher transcript memoizes stable markdown rows and renders compact tool activity", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /const MARKDOWN_COMPONENTS: MarkdownComponents = \{/);
  assert.match(source, /const MarkdownMessage = memo\(function MarkdownMessage/);
  assert.match(source, /const SessionFeedMessage = memo\(function SessionFeedMessage/);
  assert.match(source, /aria-label=\{toolExpanded \? "Hide tool details" : "Show tool details"\}/);
  assert.match(source, /const canExpandTool = toolPresentation\.lines\.length > 0;/);
  assert.match(source, /entry\.kind === "tool" \? "!mt-1\.5" : undefined/);
  assert.doesNotMatch(source, /const toneClassName = toolPresentation\.status/);
  assert.doesNotMatch(source, /Show details \(\$\{toolPresentation\.lines\.length\}\)/);
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
