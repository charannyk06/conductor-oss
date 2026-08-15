import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BOARD_CONTENT_CLASS_NAME,
  BOARD_HEADER_CLASS_NAME,
  BOARD_KANBAN_COLUMN_BODY_CLASS_NAME,
  BOARD_KANBAN_COLUMN_CLASS_NAME,
  BOARD_KANBAN_RAIL_CLASS_NAME,
  BOARD_KANBAN_RAIL_TOUCH_STYLE,
  BOARD_KANBAN_SHELL_CLASS_NAME,
  BOARD_SCROLL_SURFACE_CLASS_NAME,
} from "./boardMobileLayout";

test("mobile board surface is the sole vertical momentum scroller", () => {
  assert.match(BOARD_SCROLL_SURFACE_CLASS_NAME, /overflow-y-auto/);
  assert.match(BOARD_SCROLL_SURFACE_CLASS_NAME, /overflow-x-hidden/);
  assert.match(BOARD_SCROLL_SURFACE_CLASS_NAME, /overscroll-y-contain/);
  assert.match(BOARD_SCROLL_SURFACE_CLASS_NAME, /-webkit-overflow-scrolling:touch/);
  assert.match(BOARD_SCROLL_SURFACE_CLASS_NAME, /xl:overflow-hidden/);
  assert.doesNotMatch(BOARD_SCROLL_SURFACE_CLASS_NAME, /sm:overflow-hidden/);

  assert.match(BOARD_HEADER_CLASS_NAME, /shrink-0/);
  assert.match(BOARD_CONTENT_CLASS_NAME, /flex-none/);
  assert.match(BOARD_CONTENT_CLASS_NAME, /overflow-visible/);
  assert.match(BOARD_CONTENT_CLASS_NAME, /xl:flex-1/);
  assert.match(BOARD_CONTENT_CLASS_NAME, /xl:overflow-y-auto/);
  assert.doesNotMatch(BOARD_CONTENT_CLASS_NAME, /sm:overflow-y-auto/);
});

test("mobile Kanban rail permits native horizontal and vertical gestures", () => {
  assert.match(BOARD_KANBAN_RAIL_CLASS_NAME, /overflow-x-auto/);
  assert.match(BOARD_KANBAN_RAIL_CLASS_NAME, /overflow-y-auto/);
  assert.equal(BOARD_KANBAN_RAIL_TOUCH_STYLE.touchAction, "pan-x pan-y");
  assert.equal(BOARD_KANBAN_RAIL_TOUCH_STYLE.overscrollBehaviorX, "contain");
  assert.equal(BOARD_KANBAN_RAIL_TOUCH_STYLE.overscrollBehaviorY, "auto");
  assert.equal(BOARD_KANBAN_RAIL_TOUCH_STYLE.WebkitOverflowScrolling, "touch");
  assert.match(BOARD_KANBAN_RAIL_CLASS_NAME, /snap-proximity/);
  assert.match(BOARD_KANBAN_RAIL_CLASS_NAME, /scroll-px-0\.5/);
  assert.match(BOARD_KANBAN_COLUMN_CLASS_NAME, /snap-start/);
  assert.match(BOARD_KANBAN_SHELL_CLASS_NAME, /xl:h-full/);
});

test("mobile columns use natural height while desktop columns own task scrolling", () => {
  assert.match(BOARD_KANBAN_COLUMN_CLASS_NAME, /h-auto/);
  assert.doesNotMatch(BOARD_KANBAN_COLUMN_CLASS_NAME, /max-h-/);
  assert.match(BOARD_KANBAN_COLUMN_CLASS_NAME, /xl:h-full/);
  assert.match(BOARD_KANBAN_COLUMN_BODY_CLASS_NAME, /flex-none/);
  assert.match(BOARD_KANBAN_COLUMN_BODY_CLASS_NAME, /overflow-visible/);
  assert.match(BOARD_KANBAN_COLUMN_BODY_CLASS_NAME, /xl:flex-1/);
  assert.match(BOARD_KANBAN_COLUMN_BODY_CLASS_NAME, /xl:overflow-y-auto/);
  assert.doesNotMatch(BOARD_KANBAN_COLUMN_BODY_CLASS_NAME, /sm:overflow-y-auto/);
});

test("WorkspaceKanban consumes the mobile layout contracts without legacy nested pan-y scrollers", () => {
  const source = readFileSync(new URL("./WorkspaceKanban.tsx", import.meta.url), "utf8");

  for (const contract of [
    "BOARD_SCROLL_SURFACE_CLASS_NAME",
    "BOARD_HEADER_CLASS_NAME",
    "BOARD_CONTENT_CLASS_NAME",
    "BOARD_KANBAN_SHELL_CLASS_NAME",
    "BOARD_KANBAN_RAIL_CLASS_NAME",
    "BOARD_KANBAN_RAIL_TOUCH_STYLE",
    "BOARD_KANBAN_COLUMN_CLASS_NAME",
    "BOARD_KANBAN_COLUMN_BODY_CLASS_NAME",
  ]) {
    assert.match(source, new RegExp(contract));
  }

  assert.doesNotMatch(source, /flex-1 overflow-y-auto overscroll-contain touch-pan-y sm:touch-auto/);
  assert.doesNotMatch(source, /max-h-\[min\(560px,65dvh\)\]/);
});

test("mobile Kanban controls keep search and the primary action on one touch-friendly row", () => {
  const source = readFileSync(new URL("./WorkspaceKanban.tsx", import.meta.url), "utf8");

  assert.match(source, /flex w-full min-w-0 flex-nowrap items-center gap-2/);
  assert.match(source, /h-11 w-auto shrink-0 items-center justify-center gap-1/);
  assert.doesNotMatch(source, /h-11 w-full items-center justify-center gap-1/);
});

test("mobile list controls expose a full-width 44px primary row", () => {
  const source = readFileSync(new URL("./WorkspaceKanban.tsx", import.meta.url), "utf8");

  assert.match(source, /flex w-full min-w-0 items-center gap-2 xl:w-auto/);
  assert.match(source, /h-11 w-11 shrink-0 items-center justify-center gap-1/);
  assert.match(source, /relative min-w-0 flex-1 xl:w-80 xl:flex-none/);
  assert.match(source, /h-11 w-full rounded-\[3px\].*xl:h-\[31px\]/);
});

test("board card and empty-state actions stay touch-sized through the single-pane breakpoint", () => {
  const source = readFileSync(new URL("./WorkspaceKanban.tsx", import.meta.url), "utf8");

  assert.match(source, /h-11 w-11 items-center justify-center rounded-\[3px\].*xl:h-6 xl:w-6/);
  assert.match(source, /min-h-11 max-w-full items-center gap-1.*xl:min-h-0/);
  assert.match(source, /mt-4 inline-flex h-11 items-center gap-1.*xl:h-\[31px\]/);
  assert.match(source, /ml-auto inline-flex h-11 w-11 items-center justify-center.*xl:h-7 xl:w-7/);
  assert.doesNotMatch(source, /sm:h-6 sm:w-6/);
});
