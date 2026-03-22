import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMobileTerminalViewportMetrics,
  detectCompactTerminalChrome,
  detectMobileTerminalInputRail,
  getSessionTerminalViewportOptions,
  resolveSessionTerminalViewportOptions,
  sanitizeRemoteTerminalSnapshot,
  TERMINAL_FONT_FAMILY,
} from "./sessionTerminalUtils";

test("detectMobileTerminalInputRail only enables compact touch layouts on narrow viewports", () => {
  assert.equal(detectMobileTerminalInputRail(390, true, 1), true);
  assert.equal(detectMobileTerminalInputRail(390, false, 1), true);
  assert.equal(detectMobileTerminalInputRail(1280, true, 5), false);
  assert.equal(detectMobileTerminalInputRail(700, false, 0), false);
});

test("detectCompactTerminalChrome activates immersive mode below lg breakpoint (1024px)", () => {
  // Phone-sized viewports
  assert.equal(detectCompactTerminalChrome(390, 844, true, 1), true);
  assert.equal(detectCompactTerminalChrome(390, 844, false, 0), true);
  // Tablet-sized viewports (still below 1024px)
  assert.equal(detectCompactTerminalChrome(768, 1024, true, 5), true);
  assert.equal(detectCompactTerminalChrome(834, 1194, true, 5), true);
  assert.equal(detectCompactTerminalChrome(640, 960, false, 0), true);
  // Desktop-sized viewports (>= 1024px)
  assert.equal(detectCompactTerminalChrome(1024, 768, false, 0), false);
  assert.equal(detectCompactTerminalChrome(1440, 900, false, 0), false);
  // Landscape phone (width > 1024 doesn't happen on phones, but edge case)
  assert.equal(detectCompactTerminalChrome(844, 390, false, 1), true);
});

test("sanitizeRemoteTerminalSnapshot strips ANSI control sequences and normalizes newlines", () => {
  const raw = "\u001b[31merror\u001b[0m\r\nnext\rline\u0000";
  assert.equal(sanitizeRemoteTerminalSnapshot(raw), "error\nnext\nline");
});

test("getSessionTerminalViewportOptions keeps compact fonts for phones and larger fonts for desktop", () => {
  assert.deepEqual(getSessionTerminalViewportOptions(390), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 10,
    lineHeight: 1.1,
  });
  assert.deepEqual(getSessionTerminalViewportOptions(520), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 11,
    lineHeight: 1.15,
  });
  assert.deepEqual(getSessionTerminalViewportOptions(640), {
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    fontSize: 12,
    lineHeight: 1.2,
  });
  assert.deepEqual(getSessionTerminalViewportOptions(768), {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 1.2,
  });
  assert.deepEqual(getSessionTerminalViewportOptions(1280), {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.2,
  });
});

test("resolveSessionTerminalViewportOptions falls back to a stable desktop width when host sizing is unavailable", () => {
  assert.deepEqual(resolveSessionTerminalViewportOptions(undefined), {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.2,
  });
  assert.deepEqual(resolveSessionTerminalViewportOptions(0), {
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
