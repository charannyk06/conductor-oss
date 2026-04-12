import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APP_SURFACE_SCROLL_CLASS_NAME,
  MOBILE_MOMENTUM_SCROLL_CLASS_NAME,
  SESSION_PREVIEW_SCROLL_SHELL_CLASS_NAME,
  SESSION_SCROLL_AREA_VIEWPORT_CLASS_NAME,
  getSessionDetailRootClassName,
} from "./sessionMobileScroll";

test("non-immersive session detail keeps tab panes as the only mobile scroll containers", () => {
  const className = getSessionDetailRootClassName(false);

  assert.match(className, /overflow-hidden/);
  assert.doesNotMatch(className, /overflow-y-auto/);
});

test("immersive session detail keeps overflow clipped while applying the terminal backdrop", () => {
  const className = getSessionDetailRootClassName(true);

  assert.match(className, /overflow-hidden/);
  assert.match(className, /bg-\[#060404\]/);
});

test("mobile momentum scroll helper opts into touch-friendly vertical scrolling", () => {
  assert.match(MOBILE_MOMENTUM_SCROLL_CLASS_NAME, /overscroll-contain/);
  assert.match(MOBILE_MOMENTUM_SCROLL_CLASS_NAME, /touch-pan-y/);
  assert.match(MOBILE_MOMENTUM_SCROLL_CLASS_NAME, /-webkit-overflow-scrolling:touch/);
});

test("app surface scroll helper keeps scrolling enabled across desktop and mobile", () => {
  assert.match(APP_SURFACE_SCROLL_CLASS_NAME, /overflow-y-auto/);
  assert.match(APP_SURFACE_SCROLL_CLASS_NAME, /overscroll-contain/);
  assert.doesNotMatch(APP_SURFACE_SCROLL_CLASS_NAME, /lg:overflow-hidden/);
});

test("preview shell stays passive so the screenshot surface keeps mobile scroll ownership", () => {
  assert.match(SESSION_PREVIEW_SCROLL_SHELL_CLASS_NAME, /overflow-hidden/);
  assert.doesNotMatch(SESSION_PREVIEW_SCROLL_SHELL_CLASS_NAME, /overflow-auto/);
});

test("preview inspector scroll areas reuse the mobile momentum viewport helper", () => {
  assert.equal(SESSION_SCROLL_AREA_VIEWPORT_CLASS_NAME, MOBILE_MOMENTUM_SCROLL_CLASS_NAME);
});

test("overview screen restores app surface scroll ownership", () => {
  const source = readFileSync(new URL("./SessionOverview.tsx", import.meta.url), "utf8");

  assert.match(source, /APP_SURFACE_SCROLL_CLASS_NAME/);
  assert.match(source, /className=\{`[^`]*\$\{APP_SURFACE_SCROLL_CLASS_NAME\}[^`]*`\}/);
  assert.match(source, /flex h-full/);
  assert.match(source, /min-h-0/);
  assert.match(source, /flex-col/);
});

test("review diff screen restores app surface scroll ownership", () => {
  const source = readFileSync(new URL("./SessionDiff.tsx", import.meta.url), "utf8");

  assert.match(source, /APP_SURFACE_SCROLL_CLASS_NAME/);
  assert.match(source, /className=\{`[^`]*\$\{APP_SURFACE_SCROLL_CLASS_NAME\}[^`]*`\}/);
  assert.match(source, /min-h-0/);
  assert.match(source, /flex-1/);
});

test("preview screen restores app surface scroll ownership", () => {
  const source = readFileSync(new URL("./SessionPreview.tsx", import.meta.url), "utf8");

  assert.match(source, /APP_SURFACE_SCROLL_CLASS_NAME/);
  assert.match(source, /className=\{`[^`]*\$\{APP_SURFACE_SCROLL_CLASS_NAME\}[^`]*`\}/);
  assert.match(source, /relative flex/);
  assert.match(source, /min-w-0/);
  assert.match(source, /lg:grid/);
});
