import { TERMINAL_FONT_FAMILY } from "@/components/terminal/xtermTheme";

export type SessionTerminalViewportOptions = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

const MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX = 1024;
const TERMINAL_FRAME_MAGIC = [0x43, 0x54, 0x50, 0x32] as const;
const TERMINAL_FRAME_PROTOCOL_VERSION = 1;
const TERMINAL_FRAME_KIND_RESTORE = 1;
const TERMINAL_FRAME_KIND_STREAM = 2;
const TERMINAL_STREAM_FRAME_HEADER_BYTES = 14;
const TERMINAL_RESTORE_FRAME_HEADER_BYTES = 20;
const BROWSER_TERMINAL_RESPONSE_PATTERNS = [
  /\x1b\[(?:I|O)/g,
  /\x1b\[\d+;\d+R/g,
  /\x1b\[(?:[?>])[\d;]*c/g,
  /\x1b\](?:10|11|12|4;\d+);[\s\S]*?(?:\x07|\x1b\\)/g,
];
const ANSI_ESCAPE_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\))/g;

export type TerminalBinaryFrame =
  | {
      kind: "restore";
      sequence: number;
      snapshotVersion: number;
      reason: "attach" | "lagged" | "unknown";
      cols: number;
      rows: number;
      payload: Uint8Array;
    }
  | {
      kind: "stream";
      sequence: number;
      payload: Uint8Array;
    };

function decodeTerminalRestoreReason(code: number): "attach" | "lagged" | "unknown" {
  if (code === 1) {
    return "attach";
  }
  if (code === 2) {
    return "lagged";
  }
  return "unknown";
}

export function buildTerminalSocketUrl(baseUrl: string, cols: number, rows: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("cols", String(Math.max(1, cols)));
  url.searchParams.set("rows", String(Math.max(1, rows)));
  return url.toString();
}

export function parseTerminalBinaryFrame(buffer: ArrayBuffer): TerminalBinaryFrame {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < TERMINAL_STREAM_FRAME_HEADER_BYTES) {
    throw new Error("Terminal frame was shorter than the stream header");
  }

  for (let index = 0; index < TERMINAL_FRAME_MAGIC.length; index += 1) {
    if (bytes[index] !== TERMINAL_FRAME_MAGIC[index]) {
      throw new Error("Terminal frame magic did not match the frame protocol");
    }
  }

  const view = new DataView(buffer);
  const version = view.getUint8(4);
  if (version !== TERMINAL_FRAME_PROTOCOL_VERSION) {
    throw new Error(`Unsupported terminal frame protocol version: ${version}`);
  }

  const kind = view.getUint8(5);
  const sequence = Number(view.getBigUint64(6, false));
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Terminal frame sequence exceeded the safe integer range");
  }

  if (kind === TERMINAL_FRAME_KIND_RESTORE) {
    if (bytes.byteLength < TERMINAL_RESTORE_FRAME_HEADER_BYTES) {
      throw new Error("Terminal restore frame was shorter than the restore header");
    }

    return {
      kind: "restore",
      sequence,
      snapshotVersion: view.getUint8(14),
      reason: decodeTerminalRestoreReason(view.getUint8(15)),
      cols: view.getUint16(16, false),
      rows: view.getUint16(18, false),
      payload: bytes.slice(TERMINAL_RESTORE_FRAME_HEADER_BYTES),
    };
  }

  if (kind === TERMINAL_FRAME_KIND_STREAM) {
    return {
      kind: "stream",
      sequence,
      payload: bytes.slice(TERMINAL_STREAM_FRAME_HEADER_BYTES),
    };
  }

  throw new Error(`Unsupported terminal frame kind: ${kind}`);
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
