export const TERMINAL_FOLLOW_THRESHOLD_LINES = 2;
export const REMOTE_TERMINAL_FOLLOW_THRESHOLD_PX = 24;
export const REMOTE_TERMINAL_SCROLL_BUTTON_THRESHOLD_PX = 8;

export interface TerminalViewportLike {
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  scrollToBottom(): void;
  scrollLines(amount: number): void;
}

export interface TerminalViewportState {
  followOutput: boolean;
  scrollGap: number;
}

export interface ScrollContainerLike {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollContainerState {
  followOutput: boolean;
  scrollGap: number;
  showScrollToBottom: boolean;
}

export function captureTerminalViewport(
  term: TerminalViewportLike,
  followThreshold = TERMINAL_FOLLOW_THRESHOLD_LINES,
): TerminalViewportState {
  const buffer = term.buffer.active;
  const scrollGap = Math.max(0, buffer.baseY - buffer.viewportY);
  return {
    followOutput: scrollGap <= followThreshold,
    scrollGap,
  };
}

export function restoreTerminalViewport(
  term: TerminalViewportLike,
  viewport: TerminalViewportState,
): void {
  if (viewport.followOutput) {
    term.scrollToBottom();
    return;
  }

  const nextBaseY = term.buffer.active.baseY;
  const targetViewportY = Math.max(0, nextBaseY - viewport.scrollGap);
  const delta = targetViewportY - term.buffer.active.viewportY;
  if (delta !== 0) {
    term.scrollLines(delta);
  }
}

export function captureScrollContainerState(
  container: ScrollContainerLike,
  followThreshold = REMOTE_TERMINAL_FOLLOW_THRESHOLD_PX,
): ScrollContainerState {
  const scrollGap = Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
  return {
    followOutput: scrollGap <= followThreshold,
    scrollGap,
    showScrollToBottom: scrollGap > REMOTE_TERMINAL_SCROLL_BUTTON_THRESHOLD_PX,
  };
}

export function restoreScrollContainerState(
  container: ScrollContainerLike,
  state: Pick<ScrollContainerState, "followOutput" | "scrollGap">,
): void {
  if (state.followOutput) {
    container.scrollTop = container.scrollHeight;
    return;
  }

  container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - state.scrollGap);
}
