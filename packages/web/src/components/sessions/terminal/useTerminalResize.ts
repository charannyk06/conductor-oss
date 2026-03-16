/**
 * Hook for ResizeObserver, fit addon, debounce, resize API calls,
 * renderer recovery, and viewport state management.
 */

import { useCallback, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { captureTerminalViewport, restoreTerminalViewport, type TerminalViewportState } from "../terminalViewport";
import { RENDERER_RECOVERY_THROTTLE_MS } from "./terminalConstants";
import type { PreferredFocusTarget } from "./terminalTypes";

export interface UseTerminalResizeReturn {
  pendingResizeSyncRef: React.MutableRefObject<boolean>;
  lastSyncedTerminalSizeRef: React.MutableRefObject<string | null>;
  lastObservedContainerSizeRef: React.MutableRefObject<string | null>;
  lastViewportOptionKeyRef: React.MutableRefObject<string | null>;
  pendingViewportRestoreRef: React.MutableRefObject<TerminalViewportState | null>;
  preferredFocusTargetRef: React.MutableRefObject<PreferredFocusTarget>;
  restoreFocusOnRecoveryRef: React.MutableRefObject<boolean>;
  showScrollToBottom: boolean;
  setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  syncTerminalDimensions: (forceSync: boolean) => void;
  scheduleRendererRecovery: (forceResize: boolean) => void;
  clearScheduledRecovery: () => void;
  clearVisibilityRecoveryTimers: () => void;
  applyViewportRestore: (term: XTerminal, fallbackViewport: TerminalViewportState) => void;
  updateScrollState: () => void;
  rememberTerminalViewport: () => void;
  rememberFocusedSurface: () => PreferredFocusTarget;
  restorePreferredFocus: () => void;
}

function getPreciseTerminalGeometry(
  _term: XTerminal,
  container: HTMLDivElement,
  fit: XFitAddon,
): { cols: number; rows: number } | null {
  const rect = container.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) {
    return null;
  }

  const proposed = fit.proposeDimensions();
  if (!proposed || !proposed.cols || !proposed.rows) {
    return null;
  }

  return {
    cols: Math.max(2, proposed.cols),
    rows: Math.max(1, proposed.rows),
  };
}

export function useTerminalResize(
  sessionId: string,
  termRef: React.MutableRefObject<XTerminal | null>,
  fitRef: React.MutableRefObject<XFitAddon | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  resumeTextareaRef: React.RefObject<HTMLTextAreaElement | null>,
  sendResize: (cols: number, rows: number) => Promise<boolean>,
  setTransportError: React.Dispatch<React.SetStateAction<string | null>>,
  initialViewport: TerminalViewportState | null,
): UseTerminalResizeReturn {
  const pendingResizeSyncRef = useRef(true);
  const lastSyncedTerminalSizeRef = useRef<string | null>(null);
  const lastObservedContainerSizeRef = useRef<string | null>(null);
  const lastViewportOptionKeyRef = useRef<string | null>(null);
  const pendingViewportRestoreRef = useRef<TerminalViewportState | null>(initialViewport);
  const snapshotAppliedRef_local = useRef<string | null>(null);
  const preferredFocusTargetRef = useRef<PreferredFocusTarget>("none");
  const restoreFocusOnRecoveryRef = useRef(false);
  const activeRef_local = useRef(true);

  const recoveryFrameRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryLastRunRef = useRef(0);
  const recoveryPendingResizeRef = useRef(false);
  const visibilityRecoveryTimersRef = useRef<number[]>([]);

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // We expose this so the parent can sync snapshotAppliedRef for viewport logic
  // The parent sets this through the returned pendingViewportRestoreRef

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
      || !activeRef_local.current
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
    const term = termRef.current;
    if (!term) {
      setShowScrollToBottom(false);
      return;
    }
    setShowScrollToBottom(!captureTerminalViewport(term).followOutput);
  }, [termRef]);

  const rememberTerminalViewport = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    if (pendingViewportRestoreRef.current && snapshotAppliedRef_local.current !== sessionId) {
      return;
    }
    pendingViewportRestoreRef.current = captureTerminalViewport(term);
  }, [sessionId, termRef]);

  const applyViewportRestore = useCallback((term: XTerminal, fallbackViewport: TerminalViewportState) => {
    const cachedViewport = pendingViewportRestoreRef.current;
    if (cachedViewport) {
      restoreTerminalViewport(term, cachedViewport);
      pendingViewportRestoreRef.current = captureTerminalViewport(term);
      return;
    }
    restoreTerminalViewport(term, fallbackViewport);
    pendingViewportRestoreRef.current = captureTerminalViewport(term);
  }, []);

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

    const viewport = captureTerminalViewport(term);
    const previousCols = term.cols;
    const previousRows = term.rows;

    try {
      fit.fit();
    } catch {
      return;
    }

    const preciseGeometry = getPreciseTerminalGeometry(term, container, fit);
    if (preciseGeometry && (term.cols !== preciseGeometry.cols || term.rows !== preciseGeometry.rows)) {
      term.resize(preciseGeometry.cols, preciseGeometry.rows);
    }

    if (forceResize) {
      term.refresh(0, Math.max(0, term.rows - 1));
    }

    if (forceResize || term.cols !== previousCols || term.rows !== previousRows || pendingResizeSyncRef.current) {
      syncTerminalDimensions(forceResize || pendingResizeSyncRef.current);
    }

    applyViewportRestore(term, viewport);
    updateScrollState();
    restorePreferredFocus();
  }, [applyViewportRestore, containerRef, fitRef, restorePreferredFocus, syncTerminalDimensions, termRef, updateScrollState]);

  const clearScheduledRecovery = useCallback(() => {
    if (recoveryFrameRef.current !== null) {
      window.cancelAnimationFrame(recoveryFrameRef.current);
      recoveryFrameRef.current = null;
    }
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
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
    pendingViewportRestoreRef,
    preferredFocusTargetRef,
    restoreFocusOnRecoveryRef,
    showScrollToBottom,
    setShowScrollToBottom,
    syncTerminalDimensions,
    scheduleRendererRecovery,
    clearScheduledRecovery,
    clearVisibilityRecoveryTimers,
    applyViewportRestore,
    updateScrollState,
    rememberTerminalViewport,
    rememberFocusedSurface,
    restorePreferredFocus,
  };
}
