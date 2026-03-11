import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_FONT_FAMILY } from "@/components/terminal/xtermTheme";
import {
  buildTerminalSocketUrl,
  detectMobileTerminalInputRail,
  getSessionTerminalViewportOptions,
  normalizeTerminalSnapshot,
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
