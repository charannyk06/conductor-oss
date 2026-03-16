import type { ITerminalOptions } from "@xterm/xterm";
import { getTerminalTheme } from "@/components/terminal/xtermTheme";
import { LIVE_TERMINAL_SCROLLBACK } from "./terminalConstants";
import { getSessionTerminalViewportOptions } from "../sessionTerminalUtils";

/**
 * Builds xterm.js terminal options. Centralises every creation-time setting so
 * that both the init effect and any future terminal factories share the same
 * defaults.
 */
export function buildTerminalOptions(options: {
  windowWidth: number;
  isLight: boolean;
  isMobile: boolean;
  isLive: boolean;
  scrollback?: number;
}): ITerminalOptions {
  const viewportOptions = getSessionTerminalViewportOptions(options.windowWidth);
  return {
    allowProposedApi: true,
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    disableStdin: !options.isLive,
    drawBoldTextInBrightColors: true,
    fontFamily: viewportOptions.fontFamily,
    fontSize: viewportOptions.fontSize,
    fontWeight: "400",
    fontWeightBold: "700",
    fastScrollSensitivity: 4,
    lineHeight: viewportOptions.lineHeight,
    macOptionIsMeta: false,
    scrollSensitivity: 1.1,
    scrollback: options.scrollback ?? LIVE_TERMINAL_SCROLLBACK,
    theme: getTerminalTheme(options.isLight),
  };
}
