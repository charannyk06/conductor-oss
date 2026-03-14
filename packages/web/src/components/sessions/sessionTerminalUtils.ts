import { TERMINAL_FONT_FAMILY } from "@/components/terminal/xtermTheme";

export type SessionTerminalViewportOptions = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
};

export type TerminalWriteChunk = {
  kind: "snapshot" | "stream";
  payload: Uint8Array;
};

export type TerminalWriteBatch = {
  replace: boolean;
  payload: Uint8Array | null;
};

export type TerminalHttpControlOperation =
  | {
      kind: "keys";
      keys: string;
    }
  | {
      kind: "special";
      special: string;
    }
  | {
      kind: "resize";
      cols: number;
      rows: number;
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

const MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX = 1024;
const COMPACT_TERMINAL_CHROME_MAX_EDGE_PX = 700;
const TERMINAL_FRAME_MAGIC = [0x43, 0x54, 0x50, 0x32] as const;
const TERMINAL_FRAME_PROTOCOL_VERSION = 2;
const TERMINAL_FRAME_KIND_RESTORE = 1;
const TERMINAL_FRAME_KIND_STREAM = 2;
const TERMINAL_STREAM_FRAME_HEADER_BYTES = 14;
const TERMINAL_RESTORE_FRAME_HEADER_BYTES_V1 = 20;
const TERMINAL_RESTORE_FRAME_HEADER_BYTES_V2 = 24;
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
      modes?: TerminalModeState;
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

function decodeTerminalMouseProtocolMode(code: number): string {
  if (code === 1) return "Press";
  if (code === 2) return "PressRelease";
  if (code === 3) return "ButtonMotion";
  if (code === 4) return "AnyMotion";
  return "None";
}

function decodeTerminalMouseProtocolEncoding(code: number): string {
  if (code === 1) return "Utf8";
  if (code === 2) return "Sgr";
  if (code === 3) return "Urxvt";
  return "Default";
}

function decodeTerminalModes(flags: number, mouseModeCode: number, mouseEncodingCode: number): TerminalModeState {
  return {
    alternateScreen: (flags & (1 << 0)) !== 0,
    applicationKeypad: (flags & (1 << 1)) !== 0,
    applicationCursor: (flags & (1 << 2)) !== 0,
    hideCursor: (flags & (1 << 3)) !== 0,
    bracketedPaste: (flags & (1 << 4)) !== 0,
    mouseProtocolMode: decodeTerminalMouseProtocolMode(mouseModeCode),
    mouseProtocolEncoding: decodeTerminalMouseProtocolEncoding(mouseEncodingCode),
  };
}

function concatTerminalPayload(prefix: Uint8Array, payload: Uint8Array): Uint8Array {
  if (prefix.byteLength === 0) {
    return payload;
  }

  if (payload.byteLength === 0) {
    return prefix;
  }

  const merged = new Uint8Array(prefix.byteLength + payload.byteLength);
  merged.set(prefix, 0);
  merged.set(payload, prefix.byteLength);
  return merged;
}

export function encodeTerminalModesPrefix(modes?: TerminalModeState | null): Uint8Array {
  if (!modes) {
    return new Uint8Array(0);
  }

  const sequences = [
    modes.alternateScreen ? "\u001b[?1049h" : "\u001b[?1049l",
    modes.applicationCursor ? "\u001b[?1h" : "\u001b[?1l",
    modes.applicationKeypad ? "\u001b=" : "\u001b>",
    modes.hideCursor ? "\u001b[?25l" : "\u001b[?25h",
    modes.bracketedPaste ? "\u001b[?2004h" : "\u001b[?2004l",
    "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1005l\u001b[?1006l\u001b[?1015l",
  ];

  if (modes.mouseProtocolMode === "Press") {
    sequences.push("\u001b[?1000h");
  } else if (modes.mouseProtocolMode === "ButtonMotion") {
    sequences.push("\u001b[?1002h");
  } else if (modes.mouseProtocolMode === "AnyMotion") {
    sequences.push("\u001b[?1003h");
  } else if (modes.mouseProtocolMode === "PressRelease") {
    sequences.push("\u001b[?1000h");
  }

  if (modes.mouseProtocolEncoding === "Utf8") {
    sequences.push("\u001b[?1005h");
  } else if (modes.mouseProtocolEncoding === "Sgr") {
    sequences.push("\u001b[?1006h");
  } else if (modes.mouseProtocolEncoding === "Urxvt") {
    sequences.push("\u001b[?1015h");
  }

  return new TextEncoder().encode(sequences.join(""));
}

export function prependTerminalModes(
  payload: Uint8Array,
  modes?: TerminalModeState | null,
): Uint8Array {
  return concatTerminalPayload(encodeTerminalModesPrefix(modes), payload);
}

export function buildTerminalSnapshotPayload(
  snapshot: string,
  modes?: TerminalModeState | null,
): Uint8Array {
  return prependTerminalModes(new TextEncoder().encode(normalizeTerminalSnapshot(snapshot)), modes);
}

function concatTerminalWritePayloads(chunks: readonly Uint8Array[]): Uint8Array | null {
  if (chunks.length === 0) {
    return null;
  }

  if (chunks.length === 1) {
    return chunks[0] ?? null;
  }

  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

export function buildTerminalWriteBatch(chunks: readonly TerminalWriteChunk[]): TerminalWriteBatch {
  if (chunks.length === 0) {
    return {
      replace: false,
      payload: null,
    };
  }

  let replace = false;
  const payloadChunks: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (chunk.kind === "snapshot") {
      replace = true;
      payloadChunks.length = 0;
    }
    if (chunk.payload.byteLength > 0) {
      payloadChunks.push(chunk.payload);
    }
  }

  return {
    replace,
    payload: concatTerminalWritePayloads(payloadChunks),
  };
}

export function coalesceTerminalHttpControlOperations(
  operations: readonly TerminalHttpControlOperation[],
): TerminalHttpControlOperation[] {
  const coalesced: TerminalHttpControlOperation[] = [];

  for (const operation of operations) {
    if (operation.kind === "keys") {
      if (operation.keys.length === 0) {
        continue;
      }

      const lastOperation = coalesced[coalesced.length - 1];
      if (lastOperation?.kind === "keys") {
        lastOperation.keys += operation.keys;
      } else {
        coalesced.push({
          kind: "keys",
          keys: operation.keys,
        });
      }
      continue;
    }

    if (operation.kind === "resize") {
      const cols = Math.max(1, Math.round(operation.cols));
      const rows = Math.max(1, Math.round(operation.rows));
      const lastOperation = coalesced[coalesced.length - 1];
      if (lastOperation?.kind === "resize") {
        lastOperation.cols = cols;
        lastOperation.rows = rows;
      } else {
        coalesced.push({
          kind: "resize",
          cols,
          rows,
        });
      }
      continue;
    }

    coalesced.push({
      kind: "special",
      special: operation.special,
    });
  }

  return coalesced;
}

export function buildTerminalSocketUrl(
  baseUrl: string,
  cols: number,
  rows: number,
  sequence?: number | null,
): string {
  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(baseUrl, fallbackOrigin);
  url.searchParams.set("cols", String(Math.max(1, cols)));
  url.searchParams.set("rows", String(Math.max(1, rows)));
  if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) {
    url.searchParams.set("sequence", String(sequence));
  }
  return url.toString();
}

export function decodeTerminalBase64Payload(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return new Uint8Array(0);
  }

  if (typeof atob === "function") {
    const decoded = atob(normalized);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(normalized, "base64"));
  }

  throw new Error("A base64 decoder is not available in this environment");
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
  if (version !== 1 && version !== TERMINAL_FRAME_PROTOCOL_VERSION) {
    throw new Error(`Unsupported terminal frame protocol version: ${version}`);
  }

  const kind = view.getUint8(5);
  const sequence = Number(view.getBigUint64(6, false));
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Terminal frame sequence exceeded the safe integer range");
  }

  if (kind === TERMINAL_FRAME_KIND_RESTORE) {
    const headerBytes = version >= 2 ? TERMINAL_RESTORE_FRAME_HEADER_BYTES_V2 : TERMINAL_RESTORE_FRAME_HEADER_BYTES_V1;
    if (bytes.byteLength < headerBytes) {
      throw new Error("Terminal restore frame was shorter than the restore header");
    }

    return {
      kind: "restore",
      sequence,
      snapshotVersion: view.getUint8(14),
      reason: decodeTerminalRestoreReason(view.getUint8(15)),
      cols: view.getUint16(16, false),
      rows: view.getUint16(18, false),
      modes: version >= 2
        ? decodeTerminalModes(view.getUint8(20), view.getUint8(21), view.getUint8(22))
        : undefined,
      payload: bytes.slice(headerBytes),
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
      lineHeight: 1.2,
    };
  }

  if (width < 640) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
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

export function detectMobileTerminalInputRail(
  viewportWidth: number,
  coarsePointer: boolean,
  maxTouchPoints: number,
): boolean {
  return viewportWidth < MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX && (coarsePointer || maxTouchPoints > 0);
}

export function detectCompactTerminalChrome(
  viewportWidth: number,
  viewportHeight: number,
  coarsePointer: boolean,
  maxTouchPoints: number,
): boolean {
  return Math.min(viewportWidth, viewportHeight) <= COMPACT_TERMINAL_CHROME_MAX_EDGE_PX
    && (coarsePointer || maxTouchPoints > 0);
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
