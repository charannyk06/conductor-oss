/**
 * Hook for terminal HTTP control operations: batching keys, resize,
 * and special key presses through the HTTP API.
 */

import { useCallback, useRef } from "react";
import type { TerminalHttpControlOperation } from "../sessionTerminalUtils";
import { coalesceTerminalHttpControlOperations, stripBrowserTerminalResponses } from "../sessionTerminalUtils";
import { postSessionTerminalKeys, postTerminalResize } from "./terminalApi";
import { TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS } from "./terminalConstants";
import type { PendingTerminalHttpControlOperation } from "./terminalTypes";

export interface UseTerminalInputReturn {
  enqueueTerminalHttpControlOperation: (
    operation: TerminalHttpControlOperation,
    flushNow?: boolean,
  ) => Promise<void>;
  sendResize: (cols: number, rows: number) => Promise<boolean>;
  sendTerminalKeys: (data: string) => Promise<void>;
  sendTerminalSpecial: (special: string) => Promise<void>;
  clearScheduledTerminalHttpControlFlush: () => void;
  /** Mutable ref to the pending queue — parent reads during cleanup. */
  terminalHttpControlQueueRef: React.MutableRefObject<PendingTerminalHttpControlOperation[]>;
  /** Mutable ref to in-flight flag — parent reads during cleanup. */
  terminalHttpControlInFlightRef: React.MutableRefObject<boolean>;
  /** Set to false to block key/special sending. Parent syncs this. */
  interactiveTerminalRef: React.MutableRefObject<boolean>;
}

export function useTerminalInput(sessionId: string): UseTerminalInputReturn {
  const terminalHttpControlQueueRef = useRef<PendingTerminalHttpControlOperation[]>([]);
  const terminalHttpControlInFlightRef = useRef(false);
  const terminalHttpControlFrameRef = useRef<number | null>(null);
  const terminalHttpControlTimerRef = useRef<number | null>(null);
  const interactiveTerminalRef = useRef(true);

  const clearScheduledTerminalHttpControlFlush = useCallback(() => {
    if (terminalHttpControlFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalHttpControlFrameRef.current);
      terminalHttpControlFrameRef.current = null;
    }
    if (terminalHttpControlTimerRef.current !== null) {
      window.clearTimeout(terminalHttpControlTimerRef.current);
      terminalHttpControlTimerRef.current = null;
    }
  }, []);

  const flushTerminalHttpControlOperations = useCallback(async () => {
    clearScheduledTerminalHttpControlFlush();
    if (terminalHttpControlInFlightRef.current) {
      return;
    }

    const pendingOperations = terminalHttpControlQueueRef.current.splice(0);
    if (pendingOperations.length === 0) {
      return;
    }

    terminalHttpControlInFlightRef.current = true;
    try {
      const operations = coalesceTerminalHttpControlOperations(pendingOperations.map((operation) => {
        if (operation.kind === "keys") {
          return { kind: "keys", keys: operation.keys } satisfies TerminalHttpControlOperation;
        }
        if (operation.kind === "resize") {
          return {
            kind: "resize",
            cols: operation.cols,
            rows: operation.rows,
          } satisfies TerminalHttpControlOperation;
        }
        return { kind: "special", special: operation.special } satisfies TerminalHttpControlOperation;
      }));

      for (const operation of operations) {
        if (operation.kind === "keys") {
          await postSessionTerminalKeys(sessionId, { keys: operation.keys });
          continue;
        }
        if (operation.kind === "resize") {
          await postTerminalResize(sessionId, operation.cols, operation.rows);
          continue;
        }
        await postSessionTerminalKeys(sessionId, { special: operation.special });
      }

      for (const operation of pendingOperations) {
        operation.resolve();
      }
    } catch (error) {
      for (const operation of pendingOperations) {
        operation.reject(error);
      }
    } finally {
      terminalHttpControlInFlightRef.current = false;
      if (terminalHttpControlQueueRef.current.length > 0) {
        if (typeof window === "undefined") {
          void flushTerminalHttpControlOperations();
          return;
        }
        terminalHttpControlFrameRef.current = window.requestAnimationFrame(() => {
          void flushTerminalHttpControlOperations();
        });
        terminalHttpControlTimerRef.current = window.setTimeout(() => {
          void flushTerminalHttpControlOperations();
        }, TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS);
      }
    }
  }, [clearScheduledTerminalHttpControlFlush, sessionId]);

  const scheduleTerminalHttpControlFlush = useCallback(() => {
    if (terminalHttpControlInFlightRef.current || terminalHttpControlQueueRef.current.length === 0) {
      return;
    }

    if (typeof window === "undefined") {
      void flushTerminalHttpControlOperations();
      return;
    }

    if (terminalHttpControlFrameRef.current !== null || terminalHttpControlTimerRef.current !== null) {
      return;
    }

    terminalHttpControlFrameRef.current = window.requestAnimationFrame(() => {
      void flushTerminalHttpControlOperations();
    });
    terminalHttpControlTimerRef.current = window.setTimeout(() => {
      void flushTerminalHttpControlOperations();
    }, TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS);
  }, [flushTerminalHttpControlOperations]);

  const enqueueTerminalHttpControlOperation = useCallback((
    operation: TerminalHttpControlOperation,
    flushNow = false,
  ): Promise<void> => new Promise<void>((resolve, reject) => {
    terminalHttpControlQueueRef.current.push({
      ...operation,
      resolve,
      reject,
    });

    if (flushNow) {
      void flushTerminalHttpControlOperations();
      return;
    }

    scheduleTerminalHttpControlFlush();
  }), [flushTerminalHttpControlOperations, scheduleTerminalHttpControlFlush]);

  const sendResize = useCallback(async (cols: number, rows: number): Promise<boolean> => {
    await enqueueTerminalHttpControlOperation({
      kind: "resize",
      cols,
      rows,
    });
    return true;
  }, [enqueueTerminalHttpControlOperation]);

  const sendTerminalKeys = useCallback(async (data: string) => {
    if (!interactiveTerminalRef.current) {
      throw new Error("Operator access is required for live terminal input");
    }
    const keys = stripBrowserTerminalResponses(data);
    if (keys.length === 0) {
      return;
    }

    await enqueueTerminalHttpControlOperation({ kind: "keys", keys });
  }, [enqueueTerminalHttpControlOperation]);

  const sendTerminalSpecial = useCallback(async (special: string) => {
    if (!interactiveTerminalRef.current) {
      throw new Error("Operator access is required for live terminal input");
    }

    await enqueueTerminalHttpControlOperation({ kind: "special", special }, true);
  }, [enqueueTerminalHttpControlOperation]);

  return {
    enqueueTerminalHttpControlOperation,
    sendResize,
    sendTerminalKeys,
    sendTerminalSpecial,
    clearScheduledTerminalHttpControlFlush,
    terminalHttpControlQueueRef,
    terminalHttpControlInFlightRef,
    interactiveTerminalRef,
  };
}
