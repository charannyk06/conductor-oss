/**
 * Hook for ResizeObserver, fit addon, debounce, resize API calls,
 * renderer recovery, and scroll-to-bottom state.
 *
 * Scroll model ported from Superset-sh: simple `wasAtBottom` check before
 * fit(), then `scrollToBottom()` if needed.  No complex viewport
 * capture/restore state machine.
 */

import { useCallback, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { captureTerminalViewport } from "../terminalViewport";
import { RENDERER_RECOVERY_THROTTLE_MS } from "./terminalConstants";
import type { PreferredFocusTarget } from "./terminalTypes";

export interface UseTerminalResizeReturn {
  pendingResizeSyncRef: React.MutableRefObject<boolean>;
  lastSyncedTerminalSizeRef: React.MutableRefObject<string | null>;
  lastObservedContainerSizeRef: React.MutableRefObject<string | null>;
  lastViewportOptionKeyRef: React.MutableRefObject<string | null>;
  preferredFocusTargetRef: React.MutableRefObject<PreferredFocusTarget>;
  restoreFocusOnRecoveryRef: React.MutableRefObject<boolean>;
  showScrollToBottom: boolean;
  setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  syncTerminalDimensions: (forceSync: boolean) => void;
  scheduleRendererRecovery: (forceResize: boolean) => void;
  clearScheduledRecovery: () => void;
  clearVisibilityRecoveryTimers: () => void;
  updateScrollState: () => void;
  rememberFocusedSurface: () => PreferredFocusTarget;
  restorePreferredFocus: () => void;
}

export function useTerminalResize(
  _sessionId: string,
  termRef: React.MutableRefObject<XTerminal | null>,
  fitRef: React.MutableRefObject<XFitAddon | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  resumeTextareaRef: React.RefObject<HTMLTextAreaElement | null>,
  sendResize: (cols: number, rows: number) => Promise<boolean>,
  setTransportError: React.Dispatch<React.SetStateAction<string | null>>,
  _initialViewport: unknown,
): UseTerminalResizeReturn {
  const pendingResizeSyncRef = useRef(true);
  const lastSyncedTerminalSizeRef = useRef<string | null>(null);
  const lastObservedContainerSizeRef = useRef<string | null>(null);
  const lastViewportOptionKeyRef = useRef<string | null>(null);
  const preferredFocusTargetRef = useRef<PreferredFocusTarget>("none");
  const restoreFocusOnRecoveryRef = useRef(false);

  const recoveryFrameRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryLastRunRef = useRef(0);
  const recoveryPendingResizeRef = useRef(false);
  const visibilityRecoveryTimersRef = useRef<number[]>([]);
  const scrollStateFrameRef = useRef<number | null>(null);

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Mirror of the React state, used to skip no-op setState calls.  React does
  // bail out for same-value primitives, but the bail-out still enters the
  // reconciler — with rapid scroll events (60fps+) even that overhead adds up.
  const scrollToBottomValueRef = useRef(false);

  const detectFocusedSurface = useCallback((): PreferredFocusTarget => {
    if (typeof document === "undefined") {
      return preferredFocusTargetRef.current;
    }

    const activeElement = document.activeElement;
    if (!activeElement) {
      return "none";
    }

    if (resumeTextareaRef.current && activeElement === resumeTextareaRef.current) {
      return "resume";
    }
    if (containerRef.current && containerRef.current.contains(activeElement)) {
      return "terminal";
    }

    return "none";
  }, [containerRef, resumeTextareaRef]);

  const rememberFocusedSurface = useCallback(() => {
    const nextTarget = detectFocusedSurface();
    if (nextTarget === "none") {
      restoreFocusOnRecoveryRef.current = false;
      return nextTarget;
    }

    preferredFocusTargetRef.current = nextTarget;
    restoreFocusOnRecoveryRef.current = true;
    return nextTarget;
  }, [detectFocusedSurface]);

  const restorePreferredFocus = useCallback(() => {
    if (
      typeof document === "undefined"
      || document.hidden
      || !restoreFocusOnRecoveryRef.current
    ) {
      return;
    }

    const target = preferredFocusTargetRef.current;
    if (target === "resume") {
      resumeTextareaRef.current?.focus();
      return;
    }

    if (target === "terminal") {
      try {
        termRef.current?.focus();
      } catch {
        // The xterm textarea can disappear during teardown or reconnect.
      }
    }
  }, [resumeTextareaRef, termRef]);

  const updateScrollState = useCallback(() => {
    if (typeof window === "undefined") return;
    // Throttle to one React state update per animation frame.  Without this,
    // every xterm scroll event triggers setShowScrollToBottom → React re-render,
    // which at 60fps+ causes visible flickering during streaming and user scroll.
    if (scrollStateFrameRef.current !== null) return;
    scrollStateFrameRef.current = window.requestAnimationFrame(() => {
      scrollStateFrameRef.current = null;
      const term = termRef.current;
      const nextValue = term ? !captureTerminalViewport(term).followOutput : false;
      // Only poke React when the value actually changes.  Even though React
      // bails out for same-value primitives, skipping the setState call
      // entirely avoids entering the reconciler on every scroll frame.
      if (nextValue !== scrollToBottomValueRef.current) {
        scrollToBottomValueRef.current = nextValue;
        setShowScrollToBottom(nextValue);
      }
    });
  }, [termRef]);

  const syncTerminalDimensions = useCallback((forceSync: boolean) => {
    const term = termRef.current;
    if (!term) {
      return;
    }

    const cols = Math.max(1, term.cols);
    const rows = Math.max(1, term.rows);
    const sizeKey = `${cols}x${rows}`;
    const previousKey = lastSyncedTerminalSizeRef.current;
    if (!forceSync && !pendingResizeSyncRef.current && previousKey === sizeKey) {
      return;
    }

    void sendResize(cols, rows)
      .then((sent) => {
        if (!sent) {
          pendingResizeSyncRef.current = true;
          return;
        }
        pendingResizeSyncRef.current = false;
        lastSyncedTerminalSizeRef.current = sizeKey;
      })
      .catch((error: unknown) => {
        pendingResizeSyncRef.current = true;
        if (lastSyncedTerminalSizeRef.current === sizeKey) {
          lastSyncedTerminalSizeRef.current = previousKey;
        }
        setTransportError(error instanceof Error ? error.message : "Failed to resize terminal");
      });
  }, [sendResize, setTransportError, termRef]);

  const runRendererRecovery = useCallback((forceResize: boolean) => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) {
      return;
    }

    const style = window.getComputedStyle(container);
    if (style.display === "none" || style.visibility === "hidden") {
      return;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return;
    }

    // Superset pattern: simple wasAtBottom check before fit.
    const buffer = term.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const previousCols = term.cols;
    const previousRows = term.rows;

    try {
      fit.fit();
    } catch {
      return;
    }

    if (forceResize || term.cols !== previousCols || term.rows !== previousRows || pendingResizeSyncRef.current) {
      syncTerminalDimensions(forceResize || pendingResizeSyncRef.current);
    }

    // Superset pattern: if user was at bottom, stay at bottom after resize.
    // If user scrolled up, xterm preserves their position naturally.
    if (wasAtBottom) {
      window.requestAnimationFrame(() => {
        try { term.scrollToBottom(); } catch { /* disposed */ }
      });
    }

    updateScrollState();
    restorePreferredFocus();
  }, [containerRef, fitRef, restorePreferredFocus, syncTerminalDimensions, termRef, updateScrollState]);

  const clearScheduledRecovery = useCallback(() => {
    if (recoveryFrameRef.current !== null) {
      window.cancelAnimationFrame(recoveryFrameRef.current);
      recoveryFrameRef.current = null;
    }
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (scrollStateFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollStateFrameRef.current);
      scrollStateFrameRef.current = null;
    }
    recoveryPendingResizeRef.current = false;
  }, []);

  const clearVisibilityRecoveryTimers = useCallback(() => {
    for (const timer of visibilityRecoveryTimersRef.current) {
      window.clearTimeout(timer);
    }
    visibilityRecoveryTimersRef.current = [];
  }, []);

  const scheduleRendererRecovery = useCallback((forceResize: boolean) => {
    recoveryPendingResizeRef.current ||= forceResize;
    if (recoveryFrameRef.current !== null) {
      return;
    }

    recoveryFrameRef.current = window.requestAnimationFrame(() => {
      recoveryFrameRef.current = null;

      const now = Date.now();
      if (now - recoveryLastRunRef.current < RENDERER_RECOVERY_THROTTLE_MS) {
        const remaining = RENDERER_RECOVERY_THROTTLE_MS - (now - recoveryLastRunRef.current);
        if (recoveryTimerRef.current !== null) {
          window.clearTimeout(recoveryTimerRef.current);
        }
        recoveryTimerRef.current = window.setTimeout(() => {
          recoveryTimerRef.current = null;
          scheduleRendererRecovery(recoveryPendingResizeRef.current);
        }, remaining + 1);
        return;
      }

      recoveryLastRunRef.current = now;
      const shouldForceResize = recoveryPendingResizeRef.current;
      recoveryPendingResizeRef.current = false;
      runRendererRecovery(shouldForceResize);
    });
  }, [runRendererRecovery]);

  return {
    pendingResizeSyncRef,
    lastSyncedTerminalSizeRef,
    lastObservedContainerSizeRef,
    lastViewportOptionKeyRef,
    preferredFocusTargetRef,
    restoreFocusOnRecoveryRef,
    showScrollToBottom,
    setShowScrollToBottom,
    syncTerminalDimensions,
    scheduleRendererRecovery,
    clearScheduledRecovery,
    clearVisibilityRecoveryTimers,
    updateScrollState,
    rememberFocusedSurface,
    restorePreferredFocus,
  };
}
