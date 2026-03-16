import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_FAMILY } from "@/components/terminal/xtermTheme";
import {
  buildTerminalSnapshotPayload,
  buildTerminalWriteBatch,
  buildTerminalSocketUrl,
  calculateMobileTerminalViewportMetrics,
  coalesceTerminalHttpControlOperations,
  decodeTerminalBase64Payload,
  detectCompactTerminalChrome,
  detectMobileTerminalInputRail,
  getSessionTerminalViewportOptions,
  normalizeTerminalSnapshot,
  parseTerminalBinaryFrame,
  prependTerminalModes,
  sanitizeRemoteTerminalSnapshot,
  stripBrowserTerminalResponses,
} from "./sessionTerminalUtils";

test("buildTerminalSocketUrl clamps terminal dimensions to positive values", () => {
  const url = buildTerminalSocketUrl("wss://example.com/api/sessions/session-1/terminal/ws", 0, -12);
  assert.equal(
    url,
    "wss://example.com/api/sessions/session-1/terminal/ws?cols=1&rows=1",
  );
});

test("buildTerminalSocketUrl includes the last rendered terminal sequence when provided", () => {
  const url = buildTerminalSocketUrl(
    "wss://example.com/api/sessions/session-1/terminal/ws",
    120,
    32,
    42,
  );
  assert.equal(
    url,
    "wss://example.com/api/sessions/session-1/terminal/ws?cols=120&rows=32&sequence=42",
  );
});

test("buildTerminalSocketUrl resolves relative dashboard-proxied endpoints", () => {
  const url = buildTerminalSocketUrl("/api/sessions/session-1/terminal/stream", 120, 32, 42);
  assert.equal(
    url,
    "http://localhost/api/sessions/session-1/terminal/stream?cols=120&rows=32&sequence=42",
  );
});

test("decodeTerminalBase64Payload decodes terminal stream payload bytes", () => {
  const bytes = decodeTerminalBase64Payload("aGVsbG8=");
  assert.deepEqual(Array.from(bytes), [104, 101, 108, 108, 111]);
});

test("buildTerminalWriteBatch coalesces stream chunks without forcing a reset", () => {
  const batch = buildTerminalWriteBatch([
    { kind: "stream", payload: new Uint8Array([0x61, 0x62]) },
    { kind: "stream", payload: new Uint8Array([0x63]) },
  ]);

  assert.equal(batch.replace, false);
  assert.deepEqual(Array.from(batch.payload ?? []), [0x61, 0x62, 0x63]);
});

test("buildTerminalWriteBatch drops stale pre-snapshot output and keeps trailing live bytes", () => {
  const batch = buildTerminalWriteBatch([
    { kind: "stream", payload: new Uint8Array([0x61, 0x62]) },
    { kind: "snapshot", payload: new Uint8Array([0x73, 0x6e, 0x61, 0x70]) },
    { kind: "stream", payload: new Uint8Array([0x21]) },
  ]);

  assert.equal(batch.replace, true);
  assert.deepEqual(Array.from(batch.payload ?? []), [0x73, 0x6e, 0x61, 0x70, 0x21]);
});

test("buildTerminalWriteBatch keeps only the latest snapshot batch when multiple restores arrive", () => {
  const batch = buildTerminalWriteBatch([
    { kind: "snapshot", payload: new Uint8Array([0x6f, 0x6c, 0x64]) },
    { kind: "stream", payload: new Uint8Array([0x2e]) },
    { kind: "snapshot", payload: new Uint8Array([0x6e, 0x65, 0x77]) },
  ]);

  assert.equal(batch.replace, true);
  assert.deepEqual(Array.from(batch.payload ?? []), [0x6e, 0x65, 0x77]);
});

test("coalesceTerminalHttpControlOperations merges adjacent keypresses and drops stale resize updates", () => {
  assert.deepEqual(coalesceTerminalHttpControlOperations([
    { kind: "keys", keys: "hel" },
    { kind: "keys", keys: "lo" },
    { kind: "resize", cols: 120, rows: 32 },
    { kind: "resize", cols: 132, rows: 40 },
    { kind: "keys", keys: "!" },
  ]), [
    { kind: "keys", keys: "hello" },
    { kind: "resize", cols: 132, rows: 40 },
    { kind: "keys", keys: "!" },
  ]);
});

test("coalesceTerminalHttpControlOperations preserves ordering across special key boundaries", () => {
  assert.deepEqual(coalesceTerminalHttpControlOperations([
    { kind: "keys", keys: "git status" },
    { kind: "special", special: "Enter" },
    { kind: "keys", keys: "clear" },
    { kind: "special", special: "C-c" },
  ]), [
    { kind: "keys", keys: "git status" },
    { kind: "special", special: "Enter" },
    { kind: "keys", keys: "clear" },
    { kind: "special", special: "C-c" },
  ]);
});

test("detectMobileTerminalInputRail only enables compact touch layouts on narrow viewports", () => {
  assert.equal(detectMobileTerminalInputRail(390, true, 1), true);
  assert.equal(detectMobileTerminalInputRail(390, false, 1), true);
  assert.equal(detectMobileTerminalInputRail(1280, true, 5), false);
  assert.equal(detectMobileTerminalInputRail(700, false, 0), false);
});

test("detectCompactTerminalChrome keeps immersive session chrome for phone-sized touch viewports only", () => {
  assert.equal(detectCompactTerminalChrome(390, 844, true, 1), true);
  assert.equal(detectCompactTerminalChrome(844, 390, false, 1), true);
  assert.equal(detectCompactTerminalChrome(834, 1194, true, 5), false);
  assert.equal(detectCompactTerminalChrome(640, 960, false, 0), false);
});

test("stripBrowserTerminalResponses removes browser-generated device status chatter", () => {
  const raw = "\u001b[Ihello\u001b[12;34R\u001b[?1;2cworld\u001b]11;rgb:0000/0000/0000\u0007";
  assert.equal(stripBrowserTerminalResponses(raw), "helloworld");
});

test("sanitizeRemoteTerminalSnapshot strips ANSI control sequences and normalizes newlines", () => {
  const raw = "\u001b[31merror\u001b[0m\r\nnext\rline\u0000";
  assert.equal(sanitizeRemoteTerminalSnapshot(raw), "error\nnext\nline");
});

test("normalizeTerminalSnapshot converts LF-only snapshots to CRLF for xterm replay", () => {
  assert.equal(normalizeTerminalSnapshot("one\ntwo"), "one\r\ntwo");
  assert.equal(normalizeTerminalSnapshot("one\r\ntwo"), "one\r\ntwo");
});

test("buildTerminalSnapshotPayload prefixes mobile/web restore modes before the snapshot bytes", () => {
  const payload = buildTerminalSnapshotPayload("prompt> ", {
    alternateScreen: true,
    applicationKeypad: true,
    applicationCursor: true,
    hideCursor: true,
    bracketedPaste: true,
    mouseProtocolMode: "AnyMotion",
    mouseProtocolEncoding: "Sgr",
  });
  const text = new TextDecoder().decode(payload);

  assert.match(text, /\u001b\[\?1049h/);
  assert.match(text, /\u001b\[\?2004h/);
  assert.match(text, /\u001b\[\?1003h/);
  assert.match(text, /\u001b\[\?1006h/);
  assert.ok(text.endsWith("prompt> "));
});

test("prependTerminalModes keeps stream payload untouched when no modes are available", () => {
  const payload = new TextEncoder().encode("plain");
  assert.deepEqual(prependTerminalModes(payload), payload);
});

test("parseTerminalBinaryFrame decodes restore frames with explicit mode metadata", () => {
  const payload = new TextEncoder().encode("prompt> ");
  const frame = new Uint8Array(24 + payload.length);
  frame.set([0x43, 0x54, 0x50, 0x32, 2, 1], 0);
  const view = new DataView(frame.buffer);
  view.setBigUint64(6, 42n, false);
  view.setUint8(14, 1);
  view.setUint8(15, 2);
  view.setUint16(16, 120, false);
  view.setUint16(18, 32, false);
  view.setUint8(20, 0b0001_1101);
  view.setUint8(21, 4);
  view.setUint8(22, 2);
  frame.set(payload, 24);

  const parsed = parseTerminalBinaryFrame(frame.buffer);
  assert.deepEqual(parsed, {
    kind: "restore",
    sequence: 42,
    snapshotVersion: 1,
    reason: "lagged",
    cols: 120,
    rows: 32,
    modes: {
      alternateScreen: true,
      applicationKeypad: false,
      applicationCursor: true,
      hideCursor: true,
      bracketedPaste: true,
      mouseProtocolMode: "AnyMotion",
      mouseProtocolEncoding: "Sgr",
    },
    payload,
  });
});

test("parseTerminalBinaryFrame still accepts legacy restore frames", () => {
  const payload = new TextEncoder().encode("prompt> ");
  const frame = new Uint8Array(20 + payload.length);
  frame.set([0x43, 0x54, 0x50, 0x32, 1, 1], 0);
  const view = new DataView(frame.buffer);
  view.setBigUint64(6, 42n, false);
  view.setUint8(14, 1);
  view.setUint8(15, 2);
  view.setUint16(16, 120, false);
  view.setUint16(18, 32, false);
  frame.set(payload, 20);

  const parsed = parseTerminalBinaryFrame(frame.buffer);
  assert.deepEqual(parsed, {
    kind: "restore",
    sequence: 42,
    snapshotVersion: 1,
    reason: "lagged",
    cols: 120,
    rows: 32,
    modes: undefined,
    payload,
  });
});

test("parseTerminalBinaryFrame decodes stream frames", () => {
  const payload = new TextEncoder().encode("line\r\n");
  const frame = new Uint8Array(14 + payload.length);
  frame.set([0x43, 0x54, 0x50, 0x32, 2, 2], 0);
  const view = new DataView(frame.buffer);
  view.setBigUint64(6, 7n, false);
  frame.set(payload, 14);

  const parsed = parseTerminalBinaryFrame(frame.buffer);
  assert.deepEqual(parsed, {
    kind: "stream",
    sequence: 7,
    payload,
  });
});

test("getSessionTerminalViewportOptions keeps compact fonts for phones and larger fonts for desktop", () => {
  // Small phones (< 480px) — larger lineHeight for fewer rows
  assert.deepEqual(getSessionTerminalViewportOptions(390), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 14,
    lineHeight: 1.4,
  });
  // Larger phones / tablet-portrait (480-640px)
  assert.deepEqual(getSessionTerminalViewportOptions(520), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 14,
    lineHeight: 1.3,
  });
  // Desktop (>= 640px)
  assert.deepEqual(getSessionTerminalViewportOptions(1280), {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.2,
  });
});

test("calculateMobileTerminalViewportMetrics returns keyboard inset and visible terminal height", () => {
  assert.deepEqual(calculateMobileTerminalViewportMetrics(844, 512, 0, 96), {
    usableHeight: 416,
    keyboardInset: 332,
    keyboardVisible: true,
  });
  assert.deepEqual(calculateMobileTerminalViewportMetrics(844, 844, 0, 96), {
    usableHeight: 748,
    keyboardInset: 0,
    keyboardVisible: false,
  });
});
