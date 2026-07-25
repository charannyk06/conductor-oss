import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  KEYBOARD_SAFE_VIEWPORT_DIALOG_MAX_HEIGHT_CLASS_NAME,
  KEYBOARD_SAFE_VIEWPORT_FRAME_CLASS_NAME,
  KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VALUE,
  KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR,
  KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME,
  KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME,
  KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME,
  KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR,
  KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR,
  resolveKeyboardSafeViewportHeight,
  resolveKeyboardSafeViewportMetrics,
  resolveStableLayoutViewportHeight,
} from "./keyboardSafeViewport";

test("stable layout height survives keyboard-driven innerHeight shrinkage", () => {
  assert.equal(resolveStableLayoutViewportHeight(844, 320, 320, 320, 150), 844);
  assert.equal(resolveStableLayoutViewportHeight(0, 320, 320, 320, 150), 470);
  assert.equal(resolveStableLayoutViewportHeight(390, 844, 844, 844, 0), 844);
  assert.equal(
    resolveStableLayoutViewportHeight(844, 600, 600, Number.NaN, Number.NaN),
    600,
  );
});

test("keyboard-safe viewport metrics fill through the visual viewport bottom edge", () => {
  assert.deepEqual(resolveKeyboardSafeViewportMetrics(844, 320, 150), {
    visibleHeight: 320,
    offsetTop: 150,
    bottom: 470,
  });
  assert.equal(resolveKeyboardSafeViewportHeight(844, 320, 150), 470);
});

test("keyboard-safe viewport metrics preserve standard sizing when offsetTop is zero", () => {
  assert.deepEqual(resolveKeyboardSafeViewportMetrics(844, 512, 0), {
    visibleHeight: 512,
    offsetTop: 0,
    bottom: 512,
  });
});

test("keyboard-safe viewport metrics clamp visual bottom transitions to the layout viewport", () => {
  assert.deepEqual(resolveKeyboardSafeViewportMetrics(844, 820, 64), {
    visibleHeight: 780,
    offsetTop: 64,
    bottom: 844,
  });
  assert.deepEqual(resolveKeyboardSafeViewportMetrics(320, 320, 150), {
    visibleHeight: 170,
    offsetTop: 150,
    bottom: 320,
  });
});

test("keyboard-safe viewport metrics fall back safely when viewport values are invalid", () => {
  assert.deepEqual(resolveKeyboardSafeViewportMetrics(844, Number.NaN, Number.NaN), {
    visibleHeight: 844,
    offsetTop: 0,
    bottom: 844,
  });
  assert.equal(resolveKeyboardSafeViewportHeight(Number.NaN, 320, 150), 470);
  assert.equal(resolveKeyboardSafeViewportHeight(Number.NaN, Number.NaN, Number.NaN), 0);
});

test("keyboard-safe viewport css helpers expose literal Tailwind-detectable contracts", () => {
  assert.equal(KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR, "--oc-safe-viewport-height");
  assert.equal(KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR, "--oc-visual-viewport-height");
  assert.equal(KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR, "--oc-visual-viewport-offset-top");
  assert.equal(KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VALUE, "var(--oc-safe-viewport-height,100dvh)");
  assert.equal(
    KEYBOARD_SAFE_VIEWPORT_FRAME_CLASS_NAME,
    "h-[var(--oc-visual-viewport-height,100dvh)]",
  );
  assert.equal(
    KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME,
    "inset-x-0 top-[var(--oc-visual-viewport-offset-top,0px)] h-[var(--oc-visual-viewport-height,100dvh)]",
  );
  assert.equal(
    KEYBOARD_SAFE_VIEWPORT_DIALOG_MAX_HEIGHT_CLASS_NAME,
    "sm:max-h-[calc(var(--oc-visual-viewport-height,100dvh)-3rem)]",
  );
  assert.match(KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME, /--oc-visual-viewport-height/);
  assert.equal(
    KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME,
    "top-[calc(var(--oc-visual-viewport-offset-top,0px)+10dvh)] h-[calc(var(--oc-visual-viewport-height,100dvh)-10dvh)]",
  );
});

test("AppShell writes and cleans up every shared keyboard-safe viewport css variable", () => {
  const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(source, /resolveStableLayoutViewportHeight/);
  assert.match(source, /resolveKeyboardSafeViewportMetrics/);
  for (const cssVarName of [
    "KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR",
    "KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR",
    "KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR",
  ]) {
    assert.match(source, new RegExp(`setProperty\\(\\s*${cssVarName}`));
    assert.match(source, new RegExp(`removeProperty\\(${cssVarName}\\)`));
  }
});

test("dashboard dialogs use shared keyboard-safe frames for mobile forms", () => {
  const source = readFileSync(new URL("../../features/dashboard/components/DashboardDialogs.tsx", import.meta.url), "utf8");

  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_FRAME_CLASS_NAME/);
  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_DIALOG_MAX_HEIGHT_CLASS_NAME/);
  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME/);
  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME/);
  assert.doesNotMatch(source, /sm:max-h-\[calc\(100dvh-/);
});

test("workspace kanban dialogs use the shared inset frame", () => {
  const source = readFileSync(new URL("../board/WorkspaceKanban.tsx", import.meta.url), "utf8");

  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME/);
  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME/);
  assert.doesNotMatch(source, /sm:max-h-\[calc\(100dvh-/);
});

test("notes mobile sheets stay between the visual top and bottom edges", () => {
  const source = readFileSync(new URL("../notes/ProjectNotesWorkspace.tsx", import.meta.url), "utf8");

  assert.match(source, /KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME/);
  assert.doesNotMatch(KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME, /bottom-/);
  assert.doesNotMatch(source, /KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VALUE}\*0\.9/);
});
