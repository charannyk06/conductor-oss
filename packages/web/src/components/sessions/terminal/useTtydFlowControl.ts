/**
 * ttyd flow control hook.
 *
 * Tracks pending (unprocessed) bytes from the PTY output stream and sends
 * PAUSE/RESUME signals to the server when the high/low water marks are
 * crossed. This prevents the browser from being overwhelmed by fast output
 * (e.g. `yes`, `find /`, `cat /dev/urandom`).
 */
import { useCallback, useRef } from "react";
import {
  TTYD_CLIENT_PAUSE,
  TTYD_CLIENT_RESUME,
  TTYD_FLOW_HIGH_WATER,
  TTYD_FLOW_LOW_WATER,
} from "./terminalConstants";

export interface UseTtydFlowControlOptions {
  /** Send a binary message to the WebSocket. */
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
}

export interface UseTtydFlowControlReturn {
  /** Call when bytes are received from the server (adds to pending count). */
  trackReceived: (byteCount: number) => void;
  /** Call when bytes have been written to xterm (subtracts from pending count). */
  trackConsumed: (byteCount: number) => void;
  /** Reset flow control state (e.g. on reconnect). */
  resetFlowControl: () => void;
}

export function useTtydFlowControl({
  sendBinary,
}: UseTtydFlowControlOptions): UseTtydFlowControlReturn {
  const pendingBytesRef = useRef(0);
  const pausedRef = useRef(false);
  const sendBinaryRef = useRef(sendBinary);
  sendBinaryRef.current = sendBinary;

  const trackReceived = useCallback((byteCount: number) => {
    pendingBytesRef.current += byteCount;

    if (!pausedRef.current && pendingBytesRef.current > TTYD_FLOW_HIGH_WATER) {
      pausedRef.current = true;
      sendBinaryRef.current(new Uint8Array([TTYD_CLIENT_PAUSE]));
    }
  }, []);

  const trackConsumed = useCallback((byteCount: number) => {
    pendingBytesRef.current = Math.max(0, pendingBytesRef.current - byteCount);

    if (pausedRef.current && pendingBytesRef.current < TTYD_FLOW_LOW_WATER) {
      pausedRef.current = false;
      sendBinaryRef.current(new Uint8Array([TTYD_CLIENT_RESUME]));
    }
  }, []);

  const resetFlowControl = useCallback(() => {
    pendingBytesRef.current = 0;
    pausedRef.current = false;
  }, []);

  return { trackReceived, trackConsumed, resetFlowControl };
}
