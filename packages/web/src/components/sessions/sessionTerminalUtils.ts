import { TERMINAL_FONT_FAMILY } from "@/components/terminal/xtermTheme";

export type SessionTerminalViewportOptions = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

const MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX = 1024;
const BROWSER_TERMINAL_RESPONSE_PATTERNS = [
  /\x1b\[(?:I|O)/g,
  /\x1b\[\d+;\d+R/g,
  /\x1b\[(?:[?>])[\d;]*c/g,
  /\x1b\](?:10|11|12|4;\d+);[\s\S]*?(?:\x07|\x1b\\)/g,
];
const ANSI_ESCAPE_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\))/g;

export function buildTerminalSocketUrl(baseUrl: string, cols: number, rows: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("cols", String(Math.max(1, cols)));
  url.searchParams.set("rows", String(Math.max(1, rows)));
  return url.toString();
}

export function normalizeTerminalSnapshot(snapshot: string): string {
  return snapshot.replace(/\r?\n/g, "\r\n");
}

export function stripBrowserTerminalResponses(data: string): string {
  let sanitized = data;
  for (const pattern of BROWSER_TERMINAL_RESPONSE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized;
}

export function sanitizeRemoteTerminalSnapshot(snapshot: string): string {
  return snapshot
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

export function getSessionTerminalViewportOptions(width: number): SessionTerminalViewportOptions {
  if (width < 420) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 11,
      lineHeight: 1,
    };
  }

  if (width < 640) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 13,
      lineHeight: 1.08,
    };
  }

  return {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 17,
    lineHeight: 1.06,
  };
}

export function detectMobileTerminalInputRail(
  viewportWidth: number,
  coarsePointer: boolean,
  maxTouchPoints: number,
): boolean {
  return viewportWidth < MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX && (coarsePointer || maxTouchPoints > 0);
}
