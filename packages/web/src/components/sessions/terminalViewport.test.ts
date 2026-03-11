import { describe, expect, test } from "bun:test";
import {
  captureScrollContainerState,
  captureTerminalViewport,
  restoreScrollContainerState,
  restoreTerminalViewport,
} from "./terminalViewport";

describe("terminalViewport", () => {
  test("captures and restores a non-following terminal viewport", () => {
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
    expect(viewport.followOutput).toBe(false);
    expect(viewport.scrollGap).toBe(30);

    term.buffer.active.baseY = 150;
    restoreTerminalViewport(term, viewport);

    expect(calls).toEqual([30]);
    expect(term.buffer.active.viewportY).toBe(120);
  });

  test("restores following terminals to the bottom", () => {
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
    expect(viewport.followOutput).toBe(true);

    term.buffer.active.baseY = 80;
    restoreTerminalViewport(term, viewport);

    expect(scrolledToBottom).toBe(1);
    expect(term.buffer.active.viewportY).toBe(80);
  });

  test("captures and restores remote console scroll state", () => {
    const container = {
      clientHeight: 200,
      scrollHeight: 1400,
      scrollTop: 900,
    };

    const state = captureScrollContainerState(container);
    expect(state.followOutput).toBe(false);
    expect(state.scrollGap).toBe(300);
    expect(state.showScrollToBottom).toBe(true);

    container.scrollHeight = 1600;
    restoreScrollContainerState(container, state);

    expect(container.scrollTop).toBe(1100);
  });
});
