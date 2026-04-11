import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_MOMENTUM_SCROLL_CLASS_NAME,
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
