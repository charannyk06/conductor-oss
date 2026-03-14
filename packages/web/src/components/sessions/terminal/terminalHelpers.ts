/**
 * Pure utility functions used by the terminal component that
 * do not depend on React state or hooks.
 */

import type { Terminal as XTerminal } from "@xterm/xterm";
import { detectMobileTerminalInputRail, sanitizeRemoteTerminalSnapshot } from "../sessionTerminalUtils";

export function decodeTerminalPayloadToString(payload: Uint8Array): string {
  if (payload.length === 0) {
    return "";
  }
  if (typeof TextDecoder === "undefined") {
    return String.fromCharCode(...payload);
  }
  return new TextDecoder().decode(payload);
}

export function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

export function extractClipboardFiles(clipboard: DataTransfer): File[] {
  const files = Array.from(clipboard.files ?? []);
  const seen = new Set(files.map((file) => `${file.name}:${file.size}:${file.type}:${file.lastModified}`));

  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(file);
  }

  return files;
}

export function localFileTransferError(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.includes("/temporaryitems/") || normalized.includes("nsird_screencaptureui")) {
    return "macOS exposed only a temporary screenshot path. Paste the screenshot or drop the saved file from Finder so Conductor can upload it cleanly.";
  }

  return "The browser exposed only a local file path for this drop. Use paste or the attach button so Conductor can upload the file instead of injecting raw path text.";
}

export function buildReadableSnapshotPayload(snapshot: string, transcript: string): Uint8Array {
  const normalized = (transcript.trim().length > 0 ? transcript : sanitizeRemoteTerminalSnapshot(snapshot))
    .replace(/\r?\n/g, "\r\n")
    .replace(/\u0000/g, "");
  return new TextEncoder().encode(normalized);
}

export function terminalHasRenderedContent(term: XTerminal): boolean {
  const buffer = term.buffer.active;
  if (buffer.baseY > 0) {
    return true;
  }

  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    if (line.translateToString(true).trim().length > 0) {
      return true;
    }
  }

  return false;
}

export function shouldShowTerminalAccessoryBar(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return detectMobileTerminalInputRail(window.innerWidth, coarsePointer, navigator.maxTouchPoints);
}
