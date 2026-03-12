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

const MOBILE_TERMINAL_INPUT_MAX_WIDTH_PX = 1024;
const COMPACT_TERMINAL_CHROME_MAX_EDGE_PX = 700;
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
