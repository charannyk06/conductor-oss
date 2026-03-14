/**
 * Hook for terminal write batching, snapshot rendering, and snapshot
 * fetch/restore/cache invalidation.
 */

import { useCallback, useRef } from "react";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { captureTerminalViewport, type TerminalViewportState } from "../terminalViewport";
import {
  buildTerminalSnapshotPayload,
  buildTerminalWriteBatch,
  type TerminalWriteChunk,
  type TerminalModeState,
} from "../sessionTerminalUtils";
import { TERMINAL_WRITE_BATCH_MAX_DELAY_MS } from "./terminalConstants";
import { buildReadableSnapshotPayload } from "./terminalHelpers";

export interface UseTerminalSnapshotReturn {
  terminalWriteQueueRef: React.MutableRefObject<TerminalWriteChunk[]>;
  terminalWriteInFlightRef: React.MutableRefObject<boolean>;
  terminalWriteRestoreFocusRef: React.MutableRefObject<boolean>;
  terminalWriteDecoderRef: React.MutableRefObject<TextDecoder | null>;
  snapshotAppliedRef: React.MutableRefObject<string | null>;
  snapshotAnsiRef: React.MutableRefObject<string>;
  snapshotTranscriptRef: React.MutableRefObject<string>;
  snapshotModesRef: React.MutableRefObject<TerminalModeState | undefined>;
  liveOutputStartedRef: React.MutableRefObject<boolean>;
  lastTerminalSequenceRef: React.MutableRefObject<number | null>;
  queueTerminalWrite: (chunk: TerminalWriteChunk, restoreFocus?: boolean) => void;
  requestSnapshotRender: () => boolean;
  clearScheduledTerminalFlush: () => void;
  scheduleTerminalFlush: () => void;
  flushTerminalWrites: () => void;
}

export function useTerminalSnapshot(
  sessionId: string,
  termRef: React.MutableRefObject<XTerminal | null>,
  applyViewportRestore: (term: XTerminal, fallbackViewport: TerminalViewportState) => void,
  updateScrollState: () => void,
  restorePreferredFocus: () => void,
): UseTerminalSnapshotReturn {
  const terminalWriteQueueRef = useRef<TerminalWriteChunk[]>([]);
  const terminalWriteInFlightRef = useRef(false);
  const terminalWriteRestoreFocusRef = useRef(false);
  const terminalWriteFrameRef = useRef<number | null>(null);
  const terminalWriteTimerRef = useRef<number | null>(null);
  const terminalWriteDecoderRef = useRef<TextDecoder | null>(
    typeof TextDecoder === "undefined" ? null : new TextDecoder(),
  );

  const snapshotAppliedRef = useRef<string | null>(null);
  const snapshotAnsiRef = useRef("");
  const snapshotTranscriptRef = useRef("");
  const snapshotModesRef = useRef<TerminalModeState | undefined>(undefined);
  const liveOutputStartedRef = useRef(false);
  const lastTerminalSequenceRef = useRef<number | null>(null);

  const clearScheduledTerminalFlush = useCallback(() => {
    if (terminalWriteTimerRef.current !== null) {
      window.clearTimeout(terminalWriteTimerRef.current);
      terminalWriteTimerRef.current = null;
    }
    if (terminalWriteFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalWriteFrameRef.current);
      terminalWriteFrameRef.current = null;
    }
  }, []);

  const flushTerminalWrites = useCallback(() => {
    clearScheduledTerminalFlush();
    if (terminalWriteInFlightRef.current) {
      return;
    }

    const term = termRef.current;
    if (!term) {
      terminalWriteQueueRef.current = [];
      terminalWriteRestoreFocusRef.current = false;
      return;
    }

    const batch = buildTerminalWriteBatch(terminalWriteQueueRef.current);
    terminalWriteQueueRef.current = [];
    const shouldRestoreFocus = terminalWriteRestoreFocusRef.current;
    terminalWriteRestoreFocusRef.current = false;

    if (!batch.payload) {
      if (batch.replace) {
        const viewport = captureTerminalViewport(term);
        snapshotAppliedRef.current = sessionId;
        term.reset();
        applyViewportRestore(term, viewport);
      }
      updateScrollState();
      if (shouldRestoreFocus) {
        restorePreferredFocus();
      }
      return;
    }

    const viewport = captureTerminalViewport(term);
    terminalWriteInFlightRef.current = true;
    if (batch.replace) {
      snapshotAppliedRef.current = sessionId;
      term.reset();
      terminalWriteDecoderRef.current = typeof TextDecoder === "undefined" ? null : new TextDecoder();
    }

    const decodedPayload = terminalWriteDecoderRef.current
      ? terminalWriteDecoderRef.current.decode(batch.payload, { stream: true })
      : String.fromCharCode(...batch.payload);

    term.write(decodedPayload, () => {
      terminalWriteInFlightRef.current = false;
      if (termRef.current !== term) {
        return;
      }
      applyViewportRestore(term, viewport);
      updateScrollState();
      if (shouldRestoreFocus) {
        restorePreferredFocus();
      }
      if (terminalWriteQueueRef.current.length > 0) {
        if (typeof window === "undefined") {
          flushTerminalWrites();
          return;
        }
        terminalWriteTimerRef.current = window.setTimeout(() => {
          flushTerminalWrites();
        }, 0);
      }
    });
  }, [applyViewportRestore, clearScheduledTerminalFlush, restorePreferredFocus, sessionId, termRef, updateScrollState]);

  const scheduleTerminalFlush = useCallback(() => {
    if (terminalWriteInFlightRef.current || terminalWriteQueueRef.current.length === 0) {
      return;
    }

    if (typeof window === "undefined") {
      flushTerminalWrites();
      return;
    }

    if (terminalWriteFrameRef.current !== null || terminalWriteTimerRef.current !== null) {
      return;
    }

    // Align flushes to the next animation frame (~16ms cadence) so batched
    // writes land once per paint instead of thrashing the renderer.
    terminalWriteFrameRef.current = window.requestAnimationFrame(() => {
      terminalWriteFrameRef.current = null;
      flushTerminalWrites();
    });
    // Fallback timer ensures writes still land if rAF is throttled (e.g.
    // background tabs on some browsers).
    terminalWriteTimerRef.current = window.setTimeout(() => {
      terminalWriteTimerRef.current = null;
      if (terminalWriteFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalWriteFrameRef.current);
        terminalWriteFrameRef.current = null;
      }
      flushTerminalWrites();
    }, TERMINAL_WRITE_BATCH_MAX_DELAY_MS);
  }, [flushTerminalWrites]);

  const queueTerminalWrite = useCallback((chunk: TerminalWriteChunk, restoreFocus = false) => {
    terminalWriteQueueRef.current.push(chunk);
    terminalWriteRestoreFocusRef.current ||= restoreFocus;
    scheduleTerminalFlush();
  }, [scheduleTerminalFlush]);

  const requestSnapshotRender = useCallback(() => {
    const term = termRef.current;
    const currentSnapshot = snapshotAnsiRef.current;
    if (!term || currentSnapshot.length === 0) {
      return false;
    }

    snapshotAppliedRef.current = sessionId;
    const payload = liveOutputStartedRef.current
      ? buildTerminalSnapshotPayload(currentSnapshot, snapshotModesRef.current)
      : buildReadableSnapshotPayload(currentSnapshot, snapshotTranscriptRef.current);
    queueTerminalWrite({
      kind: "snapshot",
      payload,
    });
    return true;
  }, [queueTerminalWrite, sessionId, termRef]);

  return {
    terminalWriteQueueRef,
    terminalWriteInFlightRef,
    terminalWriteRestoreFocusRef,
    terminalWriteDecoderRef,
    snapshotAppliedRef,
    snapshotAnsiRef,
    snapshotTranscriptRef,
    snapshotModesRef,
    liveOutputStartedRef,
    lastTerminalSequenceRef,
    queueTerminalWrite,
    requestSnapshotRender,
    clearScheduledTerminalFlush,
    scheduleTerminalFlush,
    flushTerminalWrites,
  };
}
