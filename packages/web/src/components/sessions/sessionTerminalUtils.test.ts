import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_FAMILY } from "@/components/terminal/xtermTheme";
import {
  buildTerminalWriteBatch,
  buildTerminalSocketUrl,
  detectMobileTerminalInputRail,
  getSessionTerminalViewportOptions,
  normalizeTerminalSnapshot,
  parseTerminalBinaryFrame,
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

test("detectMobileTerminalInputRail only enables compact touch layouts on narrow viewports", () => {
  assert.equal(detectMobileTerminalInputRail(390, true, 1), true);
  assert.equal(detectMobileTerminalInputRail(390, false, 1), true);
  assert.equal(detectMobileTerminalInputRail(1280, true, 5), false);
  assert.equal(detectMobileTerminalInputRail(700, false, 0), false);
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

test("parseTerminalBinaryFrame decodes restore frames without websocket-side ambiguity", () => {
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
    payload,
  });
});

test("parseTerminalBinaryFrame decodes stream frames", () => {
  const payload = new TextEncoder().encode("line\r\n");
  const frame = new Uint8Array(14 + payload.length);
  frame.set([0x43, 0x54, 0x50, 0x32, 1, 2], 0);
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
  assert.deepEqual(getSessionTerminalViewportOptions(390), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 11,
    lineHeight: 1,
  });
  assert.deepEqual(getSessionTerminalViewportOptions(520), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 13,
    lineHeight: 1.08,
  });
  assert.deepEqual(getSessionTerminalViewportOptions(1280), {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 17,
    lineHeight: 1.06,
  });
});
