import assert from "node:assert/strict";
import test from "node:test";
import {
  captureScrollContainerState,
  captureTerminalViewport,
  restoreScrollContainerState,
  restoreTerminalViewport,
} from "./terminalViewport";

test("terminalViewport captures and restores a non-following terminal viewport", () => {
  const calls: number[] = [];
  const term = {
    buffer: {
      active: {
        baseY: 120,
        viewportY: 90,
      },
    },
    scrollLines(amount: number) {
      calls.push(amount);
      this.buffer.active.viewportY += amount;
    },
    scrollToBottom() {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    },
  };

  const viewport = captureTerminalViewport(term);
  assert.equal(viewport.followOutput, false);
  assert.equal(viewport.scrollGap, 30);

  term.buffer.active.baseY = 150;
  restoreTerminalViewport(term, viewport);

  assert.deepEqual(calls, [30]);
  assert.equal(term.buffer.active.viewportY, 120);
});

test("terminalViewport restores following terminals to the bottom", () => {
  let scrolledToBottom = 0;
  const term = {
    buffer: {
      active: {
        baseY: 44,
        viewportY: 43,
      },
    },
    scrollLines() {
      throw new Error("scrollLines should not run for following terminals");
    },
    scrollToBottom() {
      scrolledToBottom += 1;
      this.buffer.active.viewportY = this.buffer.active.baseY;
    },
  };

  const viewport = captureTerminalViewport(term);
  assert.equal(viewport.followOutput, true);

  term.buffer.active.baseY = 80;
  restoreTerminalViewport(term, viewport);

  assert.equal(scrolledToBottom, 1);
  assert.equal(term.buffer.active.viewportY, 80);
});

test("terminalViewport captures and restores remote console scroll state", () => {
  const container = {
    clientHeight: 200,
    scrollHeight: 1400,
    scrollTop: 900,
  };

  const state = captureScrollContainerState(container);
  assert.equal(state.followOutput, false);
  assert.equal(state.scrollGap, 300);
  assert.equal(state.showScrollToBottom, true);

  container.scrollHeight = 1600;
  restoreScrollContainerState(container, state);

  assert.equal(container.scrollTop, 1100);
});
