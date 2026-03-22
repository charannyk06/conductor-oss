export type SessionTerminalViewportOptions = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

export type MobileTerminalViewportMetrics = {
  usableHeight: number;
  keyboardInset: number;
  keyboardVisible: boolean;
};

export type TerminalModeState = {
  alternateScreen: boolean;
  applicationKeypad: boolean;
  applicationCursor: boolean;
  hideCursor: boolean;
  bracketedPaste: boolean;
  mouseProtocolMode: string;
  mouseProtocolEncoding: string;
};

export type TerminalScrollHostLike = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

const MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX = 1024;
/** Must match the Tailwind `lg:` breakpoint (1024px) used in SessionTerminal / SessionDetail. */
const COMPACT_TERMINAL_CHROME_MAX_WIDTH_PX = 1024;
const DEFAULT_TERMINAL_VIEWPORT_WIDTH_PX = 1280;
const ANSI_ESCAPE_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\))/g;

export const TERMINAL_FONT_FAMILY = [
  "MesloLGM Nerd Font",
  "MesloLGM NF",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  "JetBrainsMono Nerd Font",
  "CaskaydiaCove Nerd Font",
  "Menlo",
  "Monaco",
  '"Courier New"',
  "SF Mono",
  "SF Pro",
  "monospace",
].join(", ");

export function sanitizeRemoteTerminalSnapshot(snapshot: string): string {
  return snapshot
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

export function isTerminalScrollHostAtBottom(
  scrollHost: TerminalScrollHostLike | null | undefined,
  tolerance = 0.5,
): boolean {
  if (!scrollHost) {
    return true;
  }

  return scrollHost.scrollHeight - scrollHost.clientHeight - scrollHost.scrollTop <= tolerance;
}

export function getSessionTerminalViewportOptions(width: number): SessionTerminalViewportOptions {
  if (width < 420) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 10,
      lineHeight: 1.1,
    };
  }

  if (width < 560) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 11,
      lineHeight: 1.15,
    };
  }

  if (width < 768) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.2,
    };
  }

  if (width < 1024) {
    return {
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
    };
  }

  return {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.2,
  };
}

export function resolveSessionTerminalViewportOptions(
  width: number | null | undefined,
): SessionTerminalViewportOptions {
  const normalizedWidth =
    typeof width === "number" && Number.isFinite(width) && width > 0
      ? width
      : DEFAULT_TERMINAL_VIEWPORT_WIDTH_PX;
  return getSessionTerminalViewportOptions(normalizedWidth);
}

export function detectMobileTerminalInputRail(
  viewportWidth: number,
  coarsePointer: boolean,
  maxTouchPoints: number,
): boolean {
  return viewportWidth < MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX && (coarsePointer || maxTouchPoints > 0);
}

export function detectCompactTerminalChrome(
  viewportWidth: number,
  _viewportHeight: number,
  _coarsePointer: boolean,
  _maxTouchPoints: number,
): boolean {
  // Use viewport WIDTH to stay aligned with the Tailwind `lg:` breakpoint
  // used in SessionTerminal and SessionDetail for border/rounding/padding.
  return viewportWidth < COMPACT_TERMINAL_CHROME_MAX_WIDTH_PX;
}

export function shouldUseCompactTerminalChrome(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints;
  return detectCompactTerminalChrome(window.innerWidth, window.innerHeight, coarsePointer, maxTouchPoints);
}

export function calculateMobileTerminalViewportMetrics(
  layoutViewportHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
  surfaceTop: number,
): MobileTerminalViewportMetrics {
  const safeLayoutHeight = Number.isFinite(layoutViewportHeight) ? Math.max(0, layoutViewportHeight) : 0;
  const safeVisualHeight = Number.isFinite(visualViewportHeight) ? Math.max(0, visualViewportHeight) : safeLayoutHeight;
  const safeOffsetTop = Number.isFinite(visualViewportOffsetTop) ? Math.max(0, visualViewportOffsetTop) : 0;
  const safeSurfaceTop = Number.isFinite(surfaceTop) ? Math.max(0, surfaceTop) : 0;
  const keyboardInset = Math.max(0, safeLayoutHeight - (safeVisualHeight + safeOffsetTop));
  const topOffset = Math.max(0, safeSurfaceTop - safeOffsetTop);
  const usableHeight = Math.max(0, safeVisualHeight - topOffset);

  return {
    usableHeight: Math.round(usableHeight),
    keyboardInset: Math.round(keyboardInset),
    keyboardVisible: keyboardInset >= 80,
  };
}
