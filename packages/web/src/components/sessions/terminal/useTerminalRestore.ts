/**
 * Hook that handles snapshot restore and sequence tracking for the terminal.
 *
 * Supports two binary protocols:
 *   - Raw binary (ttyd-style): 1-byte type prefix (0x00=stream, 0x01=restore)
 *     followed by raw PTY/ANSI bytes. Used by the primary WebSocket transport.
 *   - CTP2 (legacy): Multi-byte header with magic, version, kind, sequence.
 *     Used by the SSE fallback transport (base64-encoded in JSON events).
 */
import { useCallback, useRef } from "react";
import {
  parseTerminalBinaryFrame,
  decodeTerminalBase64Payload,
  prependTerminalModes,
  sanitizeRemoteTerminalSnapshot,
  type TerminalModeState,
  type TerminalWriteChunk,
} from "../sessionTerminalUtils";
import { decodeTerminalPayloadToString } from "./terminalHelpers";
import { clearCachedTerminalSnapshot } from "./terminalCache";
import type { TerminalServerEvent, TerminalStreamEventMessage } from "./terminalTypes";

/** Raw binary message types (ttyd-style protocol) */
const WS_OUT_STREAM = 0x00;
const WS_OUT_RESTORE = 0x01;

/** CTP2 protocol magic bytes */
const CTP2_MAGIC = [0x43, 0x54, 0x50, 0x32] as const; // "CTP2"

export interface UseTerminalRestoreOptions {
  sessionId: string;
  termRef: React.MutableRefObject<import("@xterm/xterm").Terminal | null>;
  onWrite: (chunk: TerminalWriteChunk, restoreFocus?: boolean) => void;
  onSequenceUpdate: (sequence: number) => void;
  /** Called for non-stream/restore server events (exit, error, ready, recovery, etc.) */
  onServerEvent?: (event: TerminalServerEvent) => void;
}

export interface UseTerminalRestoreReturn {
  handleBinaryFrame: (data: ArrayBuffer) => void;
  handleTextEvent: (data: string) => void;
  handleServerEvent: (event: TerminalServerEvent) => void;
  /** Reset all internal refs — call on session change to prevent stale state. */
  reset: () => void;
  lastSequenceRef: React.MutableRefObject<number | null>;
  liveOutputStartedRef: React.MutableRefObject<boolean>;
  snapshotAnsiRef: React.MutableRefObject<string>;
  snapshotTranscriptRef: React.MutableRefObject<string>;
  snapshotModesRef: React.MutableRefObject<TerminalModeState | undefined>;
}

/** Detect whether a binary frame uses CTP2 protocol by checking the magic bytes. */
function isCtp2Frame(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 14) return false;
  return (
    bytes[0] === CTP2_MAGIC[0] &&
    bytes[1] === CTP2_MAGIC[1] &&
    bytes[2] === CTP2_MAGIC[2] &&
    bytes[3] === CTP2_MAGIC[3]
  );
}

export function useTerminalRestore({
  sessionId,
  termRef,
  onWrite,
  onSequenceUpdate,
  onServerEvent,
}: UseTerminalRestoreOptions): UseTerminalRestoreReturn {
  const lastSequenceRef = useRef<number | null>(null);
  const liveOutputStartedRef = useRef(false);
  const snapshotAnsiRef = useRef("");
  const snapshotTranscriptRef = useRef("");
  const snapshotModesRef = useRef<TerminalModeState | undefined>(undefined);
  const snapshotAppliedRef = useRef<string | null>(null);
  const onServerEventRef = useRef(onServerEvent);
  onServerEventRef.current = onServerEvent;

  const applyPayloadFrame = useCallback((
    kind: "restore" | "stream",
    payload: Uint8Array,
    sequence?: number,
    modes?: TerminalModeState,
  ) => {
    liveOutputStartedRef.current = true;

    if (kind === "restore") {
      const snapshot = decodeTerminalPayloadToString(payload);
      snapshotAnsiRef.current = snapshot;
      snapshotTranscriptRef.current = sanitizeRemoteTerminalSnapshot(snapshot);
      snapshotModesRef.current = modes;
      clearCachedTerminalSnapshot(sessionId);

      // For raw binary protocol, modes are already prepended by the server.
      // For CTP2 (legacy), modes need to be prepended client-side.
      onWrite({ kind: "snapshot", payload }, true);
      snapshotAppliedRef.current = sessionId;
      if (typeof sequence === "number") {
        lastSequenceRef.current = sequence;
        onSequenceUpdate(sequence);
      }
      return;
    }

    // Stream data — append to terminal.
    onWrite({ kind: "stream", payload }, false);
    if (typeof sequence === "number") {
      lastSequenceRef.current = sequence;
      onSequenceUpdate(sequence);
    }
  }, [sessionId, onWrite, onSequenceUpdate]);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) return;

    // Auto-detect protocol: CTP2 (legacy) vs raw binary (ttyd-style).
    if (isCtp2Frame(bytes)) {
      // Legacy CTP2 protocol — parse the header and extract payload.
      const frame = parseTerminalBinaryFrame(data);
      const finalPayload = frame.kind === "restore" && frame.modes
        ? prependTerminalModes(frame.payload, frame.modes)
        : frame.payload;
      applyPayloadFrame(
        frame.kind,
        finalPayload,
        frame.sequence,
        frame.kind === "restore" ? frame.modes : undefined,
      );
      return;
    }

    // Raw binary protocol: first byte is message type, rest is payload.
    const msgType = bytes[0];
    const payload = bytes.subarray(1);

    if (msgType === WS_OUT_RESTORE) {
      // Restore snapshot — raw ANSI bytes with modes already prepended by server.
      applyPayloadFrame("restore", payload);
    } else {
      // Stream output (0x00) — raw PTY bytes, write directly.
      applyPayloadFrame("stream", payload);
    }
  }, [applyPayloadFrame]);

  const handleServerEvent = useCallback((event: TerminalServerEvent) => {
    onServerEventRef.current?.(event);
  }, []);

  const handleTextEvent = useCallback((data: string) => {
    let parsed: TerminalStreamEventMessage;
    try {
      parsed = JSON.parse(data) as TerminalStreamEventMessage;
    } catch {
      return;
    }
    if (parsed.type === "stream" || parsed.type === "restore") {
      const rawPayload = decodeTerminalBase64Payload(parsed.payload);
      const finalPayload = parsed.type === "restore" && parsed.modes
        ? prependTerminalModes(rawPayload, parsed.modes)
        : rawPayload;
      applyPayloadFrame(
        parsed.type,
        finalPayload,
        parsed.sequence,
        parsed.type === "restore" ? parsed.modes : undefined,
      );
      return;
    }
    handleServerEvent(parsed);
  }, [applyPayloadFrame, handleServerEvent]);

  const reset = useCallback(() => {
    lastSequenceRef.current = null;
    liveOutputStartedRef.current = false;
    snapshotAnsiRef.current = "";
    snapshotTranscriptRef.current = "";
    snapshotModesRef.current = undefined;
    snapshotAppliedRef.current = null;
  }, []);

  return {
    handleBinaryFrame,
    handleTextEvent,
    handleServerEvent,
    reset,
    lastSequenceRef,
    liveOutputStartedRef,
    snapshotAnsiRef,
    snapshotTranscriptRef,
    snapshotModesRef,
  };
}
