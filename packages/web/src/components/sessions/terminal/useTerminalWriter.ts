/**
 * Hook for terminal write batching. Owns the write queue, flush scheduling,
 * and batch assembly.
 *
 * Scroll model ported from Superset-sh: xterm handles scroll position
 * natively during writes.  If user is at bottom, xterm auto-scrolls.
 * If user scrolled up, xterm preserves their position.  No manual
 * viewport capture/restore needed.
 */

import { useCallback, useRef } from "react";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { buildTerminalWriteBatch, type TerminalWriteChunk } from "../sessionTerminalUtils";
import { TERMINAL_WRITE_BATCH_MAX_DELAY_MS } from "./terminalConstants";

export interface UseTerminalWriterReturn {
  terminalWriteQueueRef: React.MutableRefObject<TerminalWriteChunk[]>;
  terminalWriteInFlightRef: React.MutableRefObject<boolean>;
  terminalWriteRestoreFocusRef: React.MutableRefObject<boolean>;
  terminalWriteDecoderRef: React.MutableRefObject<TextDecoder | null>;
  queueTerminalWrite: (chunk: TerminalWriteChunk, restoreFocus?: boolean) => void;
  flushTerminalWrites: () => void;
  scheduleTerminalFlush: () => void;
  clearScheduledTerminalFlush: () => void;
}

export function useTerminalWriter(
  sessionId: string,
  termRef: React.MutableRefObject<XTerminal | null>,
  snapshotAppliedRef: React.MutableRefObject<string | null>,
  updateScrollState: () => void,
  restorePreferredFocus: () => void,
): UseTerminalWriterReturn {
  const terminalWriteQueueRef = useRef<TerminalWriteChunk[]>([]);
  const terminalWriteInFlightRef = useRef(false);
  const terminalWriteRestoreFocusRef = useRef(false);
  const terminalWriteFrameRef = useRef<number | null>(null);
  const terminalWriteTimerRef = useRef<number | null>(null);
  const terminalWriteDecoderRef = useRef<TextDecoder | null>(
    typeof TextDecoder === "undefined" ? null : new TextDecoder(),
  );

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
    if (terminalWriteInFlightRef.current) return;

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
        snapshotAppliedRef.current = sessionId;
        term.reset();
      }
      updateScrollState();
      if (shouldRestoreFocus) restorePreferredFocus();
      return;
    }

    terminalWriteInFlightRef.current = true;
    if (batch.replace) {
      snapshotAppliedRef.current = sessionId;
      term.reset();
      terminalWriteDecoderRef.current = typeof TextDecoder === "undefined" ? null : new TextDecoder();
    }

    // Write the assembled batch as Uint8Array — xterm.js handles binary
    // natively.  Both snapshot and stream chunks are concatenated by
    // buildTerminalWriteBatch so they land in a single term.write() call,
    // preventing races between reset() and incremental stream data.
    const writePayload = batch.payload;

    // Superset pattern: let xterm handle scroll position natively.
    // - If user is at bottom → xterm auto-scrolls on new content.
    // - If user scrolled up → xterm preserves their position.
    // No manual viewport capture/restore needed.
    term.write(writePayload, () => {
      terminalWriteInFlightRef.current = false;
      if (termRef.current !== term) return;
      updateScrollState();
      if (shouldRestoreFocus) restorePreferredFocus();
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
  }, [clearScheduledTerminalFlush, restorePreferredFocus, sessionId, snapshotAppliedRef, termRef, updateScrollState]);

  const scheduleTerminalFlush = useCallback(() => {
    if (terminalWriteInFlightRef.current || terminalWriteQueueRef.current.length === 0) return;

    if (typeof window === "undefined") {
      flushTerminalWrites();
      return;
    }

    if (terminalWriteFrameRef.current !== null || terminalWriteTimerRef.current !== null) return;

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

  return {
    terminalWriteQueueRef,
    terminalWriteInFlightRef,
    terminalWriteRestoreFocusRef,
    terminalWriteDecoderRef,
    queueTerminalWrite,
    flushTerminalWrites,
    scheduleTerminalFlush,
    clearScheduledTerminalFlush,
  };
}
