/**
 * Hook that handles binary frame parsing for the terminal.
 *
 * ttyd binary protocol: 1-byte type prefix followed by payload bytes.
 *   - 0x30 OUTPUT (raw PTY bytes)
 *   - 0x31 TITLE  (window title, ignored)
 *   - 0x32 PREFS  (terminal preferences JSON, ignored)
 */
import { useCallback, useRef } from "react";
import type {
  TerminalModeState,
} from "../sessionTerminalUtils";
import type { TerminalServerEvent } from "./terminalTypes";

/** ttyd native binary protocol message types (server -> client) */
const TTYD_SERVER_OUTPUT = 0x30;

export interface UseTerminalRestoreOptions {
  sessionId: string;
  termRef: React.MutableRefObject<import("@xterm/xterm").Terminal | null>;
  /** Direct write path for stream data — writes raw bytes to xterm. */
  onStreamData: (payload: Uint8Array) => void;
  /** Called for non-stream server events (exit, error, ready, recovery, etc.) */
  onServerEvent?: (event: TerminalServerEvent) => void;
}

export interface UseTerminalRestoreReturn {
  handleBinaryFrame: (data: ArrayBuffer) => void;
  handleTextEvent: (data: string) => void;
  handleServerEvent: (event: TerminalServerEvent) => void;
  /** No-op — kept for backward compatibility with the writer callback bridge. */
  markStreamReady: () => void;
  /** Reset all internal refs — call on session change to prevent stale state. */
  reset: () => void;
  lastSequenceRef: React.MutableRefObject<number | null>;
  liveOutputStartedRef: React.MutableRefObject<boolean>;
  snapshotAnsiRef: React.MutableRefObject<string>;
  snapshotTranscriptRef: React.MutableRefObject<string>;
  snapshotModesRef: React.MutableRefObject<TerminalModeState | undefined>;
}

export function useTerminalRestore({
  sessionId,
  termRef,
  onStreamData,
  onServerEvent,
}: UseTerminalRestoreOptions): UseTerminalRestoreReturn {
  const lastSequenceRef = useRef<number | null>(null);
  const liveOutputStartedRef = useRef(false);
  const snapshotAnsiRef = useRef("");
  const snapshotTranscriptRef = useRef("");
  const snapshotModesRef = useRef<TerminalModeState | undefined>(undefined);
  const onServerEventRef = useRef(onServerEvent);
  onServerEventRef.current = onServerEvent;

  // Stable ref for onStreamData to avoid dep array churn.
  const onStreamDataRef = useRef(onStreamData);
  onStreamDataRef.current = onStreamData;

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength < 2) return;

    const msgType = bytes[0];
    const payload = bytes.subarray(1);

    if (msgType === TTYD_SERVER_OUTPUT) {
      // ttyd OUTPUT frame — raw PTY bytes, write directly to xterm.
      liveOutputStartedRef.current = true;
      onStreamDataRef.current(payload);
    }
    // 0x31 TITLE, 0x32 PREFS — ignored
  }, []);

  const handleServerEvent = useCallback((event: TerminalServerEvent) => {
    onServerEventRef.current?.(event);
  }, []);

  /** Text events are unused for ttyd (binary-only), kept as no-op for socket compatibility. */
  const handleTextEvent = useCallback((_data: string) => {
    // ttyd only sends binary frames — no text events expected.
  }, []);

  /** No-op — ttyd has no restore/gate mechanism. Kept for writer callback bridge. */
  const markStreamReady = useCallback(() => {}, []);

  const reset = useCallback(() => {
    lastSequenceRef.current = null;
    liveOutputStartedRef.current = false;
    snapshotAnsiRef.current = "";
    snapshotTranscriptRef.current = "";
    snapshotModesRef.current = undefined;
  }, []);

  return {
    handleBinaryFrame,
    handleTextEvent,
    handleServerEvent,
    markStreamReady,
    reset,
    lastSequenceRef,
    liveOutputStartedRef,
    snapshotAnsiRef,
    snapshotTranscriptRef,
    snapshotModesRef,
  };
}
