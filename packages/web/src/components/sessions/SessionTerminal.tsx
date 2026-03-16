"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { captureTerminalViewport, type TerminalViewportState } from "./terminalViewport";
import {
  buildTerminalSnapshotPayload,
  getSessionTerminalViewportOptions,
  stripBrowserTerminalResponses,
  type TerminalModeState,
} from "./sessionTerminalUtils";

import {
  LIVE_TERMINAL_STATUSES,
  READ_ONLY_TERMINAL_SNAPSHOT_LINES,
  DETACH_DELAY_MS,
  SHELL_CRASH_DETECTION_WINDOW_MS,
} from "./terminal/terminalConstants";
import type {
  TerminalRuntimeInfo,
  TerminalSnapshot,
} from "./terminal/terminalTypes";
import {
  readCachedTerminalSnapshot,
  storeCachedTerminalSnapshot,
  clearCachedTerminalSnapshot,
  readCachedTerminalUiState,
  storeCachedTerminalUiState,
  clearCachedTerminalConnection,
} from "./terminal/terminalCache";
import {
  fetchFastBootstrap,
  fetchTerminalSnapshot,
  postSessionTerminalKeys,
  postTerminalResize,
} from "./terminal/terminalApi";
import {
  buildReadableSnapshotPayload,
  terminalHasRenderedContent,
  shouldShowTerminalAccessoryBar,
} from "./terminal/terminalHelpers";
import { useTerminalSearch } from "./terminal/useTerminalSearch";
import { useTerminalResize } from "./terminal/useTerminalResize";
import { useTerminalSocket, type TerminalConnectionState } from "./terminal/useTerminalSocket";
import { useTerminalRestore } from "./terminal/useTerminalRestore";
import { useTerminalLifecycle } from "./terminal/useTerminalLifecycle";
import { useTerminalWriter } from "./terminal/useTerminalWriter";

// ---------------------------------------------------------------------------

/** Minimum interval between automatic reconnect attempts (ms). */
const RECONNECT_DEBOUNCE_MS = 2_000;

interface SessionTerminalProps {
  sessionId: string;
  sessionState: string;
  active: boolean;
}

export function SessionTerminal({
  sessionId,
  sessionState,
  active,
}: SessionTerminalProps) {
  // --- Refs ---
  const surfaceRef = useRef<HTMLDivElement>(null);
  const nullTextareaRef = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef(active);
  const previousLiveTerminalRef = useRef(false);
  const expectsLiveTerminalRef = useRef(false);
  const interactiveTerminalRef = useRef(true);
  const firstConnectionAtRef = useRef<number | null>(null);

  // Snapshot state refs (formerly in useTerminalSnapshot)
  const snapshotAppliedRef = useRef<string | null>(null);
  const snapshotAnsiRef = useRef("");
  const snapshotTranscriptRef = useRef("");
  const snapshotModesRef = useRef<TerminalModeState | undefined>(undefined);
  const liveOutputStartedRef = useRef(false);
  const lastTerminalSequenceRef = useRef<number | null>(null);

  // W-14: Stable ref for sendTerminalKeys so onData can reference it before
  // the useCallback definition.
  const sendTerminalKeysRef = useRef<(data: string) => Promise<void>>(async () => {});

  const initialUiState = readCachedTerminalUiState(sessionId);

  // --- State ---
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [sseUrl, setSseUrl] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>("idle");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [interactiveTerminal, setInteractiveTerminal] = useState(true);
  const [transportNotice, setTransportNotice] = useState<string | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<TerminalRuntimeInfo | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [shellCrashed, setShellCrashed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(() => initialUiState?.searchOpen ?? false);
  const [searchQuery, setSearchQuery] = useState(() => initialUiState?.searchQuery ?? "");
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const [sessionStatusOverride, setSessionStatusOverride] = useState<string | null>(null);

  // W-12: Reactive isMobile state driven by matchMedia listener.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? shouldShowTerminalAccessoryBar() : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(pointer: coarse)");
    const update = () => setIsMobile(shouldShowTerminalAccessoryBar());
    // Listen for pointer capability changes (e.g. docking a tablet).
    mql.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    // Sync once in case the value drifted since initial render.
    update();
    return () => {
      mql.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // --- Derived state ---
  const normalizedSessionStatus = React.useMemo(() => {
    const candidate = typeof sessionStatusOverride === "string" && sessionStatusOverride.trim().length > 0
      ? sessionStatusOverride
      : sessionState;
    return candidate.trim().toLowerCase();
  }, [sessionState, sessionStatusOverride]);
  activeRef.current = active;
  interactiveTerminalRef.current = interactiveTerminal;

  const expectsLiveTerminal = LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus);
  const wantsTerminalSurface = active && pageVisible;
  const [debouncedShouldAttach, setDebouncedShouldAttach] = useState(wantsTerminalSurface);
  useEffect(() => {
    if (wantsTerminalSurface) {
      setDebouncedShouldAttach(true);
      return;
    }
    const timer = window.setTimeout(() => setDebouncedShouldAttach(false), DETACH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [wantsTerminalSurface]);
  const shouldAttachTerminalSurface = debouncedShouldAttach;
  const shouldStreamLiveTerminal = expectsLiveTerminal && shouldAttachTerminalSurface;
  const canRenderTerminal = shouldAttachTerminalSurface;
  const hasResolvedTerminalTransport = (typeof wsUrl === "string" && wsUrl.length > 0)
    || (typeof sseUrl === "string" && sseUrl.length > 0);
  expectsLiveTerminalRef.current = expectsLiveTerminal;

  // --- Callback refs for cross-hook wiring (defined before hooks, updated after) ---
  const handleLifecycleInitRef = useRef<(term: XTerminal, fit: XFitAddon, container: HTMLDivElement) => void>(() => {});
  const handleLifecycleCleanupRef = useRef<(term: XTerminal) => void>(() => {});
  const cachedViewportRef = useRef<TerminalViewportState | null>(null);
  const updateScrollStateRef = useRef<() => void>(() => {});
  const restorePreferredFocusRef = useRef<() => void>(() => {});
  const scheduleRendererRecoveryRef = useRef<(force: boolean) => void>(() => {});
  const requestSnapshotRenderRef = useRef<() => boolean>(() => false);

  // --- useTerminalLifecycle (owns termRef, fitRef, containerRef, ready) ---
  const { termRef, fitRef, containerRef, ready: terminalReady } = useTerminalLifecycle({
    sessionId,
    shouldAttach: shouldAttachTerminalSurface,
    onData: (data) => {
      // W-14: Use the ref instead of the forward-declared function.
      void sendTerminalKeysRef.current(data).catch((err: unknown) => {
        setTransportError(err instanceof Error ? err.message : "Failed to send terminal input");
      });
    },
    onScroll: () => updateScrollStateRef.current(),
    onResizeObserved: (term, entry) => {
      if (!activeRef.current) return;
      const { width, height } = entry.contentRect;
      const sizeKey = `${Math.round(width)}x${Math.round(height)}`;
      if (lastObservedContainerSizeRef.current === sizeKey) return;
      lastObservedContainerSizeRef.current = sizeKey;
      const nextOpts = getSessionTerminalViewportOptions(window.innerWidth);
      const nextKey = `${nextOpts.fontFamily}:${nextOpts.fontSize}:${nextOpts.lineHeight}`;
      if (lastViewportOptionKeyRef.current !== nextKey) {
        lastViewportOptionKeyRef.current = nextKey;
        try {
          if (term.options.fontFamily !== nextOpts.fontFamily) term.options.fontFamily = nextOpts.fontFamily;
          if (term.options.fontSize !== nextOpts.fontSize) term.options.fontSize = nextOpts.fontSize;
          if (term.options.lineHeight !== nextOpts.lineHeight) term.options.lineHeight = nextOpts.lineHeight;
        } catch { return; }
      }
      scheduleRendererRecoveryRef.current(true);
    },
    onFileLinkOpen: async (path, line, column) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/open-file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            line: typeof line === "number" ? line : undefined,
            column: typeof column === "number" ? column : undefined,
          }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          setTransportError(data?.error ?? `Failed to open file: ${response.status}`);
        }
      } catch (err) {
        setTransportError(err instanceof Error ? err.message : "Failed to open file link");
      }
    },
    onInit: (term, _fit, container) => handleLifecycleInitRef.current(term, _fit, container),
    onCleanup: (term) => handleLifecycleCleanupRef.current(term),
  });

  // --- useTerminalWriter (ref-bridged resize callbacks) ---
  const {
    terminalWriteQueueRef,
    terminalWriteInFlightRef,
    terminalWriteRestoreFocusRef,
    terminalWriteDecoderRef,
    queueTerminalWrite,
    clearScheduledTerminalFlush,
  } = useTerminalWriter(
    sessionId,
    termRef,
    snapshotAppliedRef,
    () => updateScrollStateRef.current(),
    () => restorePreferredFocusRef.current(),
  );

  // --- useTerminalRestore (snapshot restore + sequence tracking) ---
  // syncRestoreRefsRef is declared before the hook so the onSequenceUpdate
  // callback can capture the ref (a stable object).  Its `.current` is
  // assigned immediately after the hook returns.
  const syncRestoreRefsRef = useRef(() => {});
  const restoreResult = useTerminalRestore({
    sessionId,
    termRef,
    onWrite: queueTerminalWrite,
    onSequenceUpdate: (seq) => {
      lastTerminalSequenceRef.current = seq;
      syncRestoreRefsRef.current();
    },
    onServerEvent: (event) => {
      // Handle server events for SSE transport (WS handles them inline).
      if (event.type === "control" && event.event === "exit") {
        const exitCode = typeof event.exitCode === "number" ? event.exitCode : 0;
        if (
          firstConnectionAtRef.current
          && Date.now() - firstConnectionAtRef.current < SHELL_CRASH_DETECTION_WINDOW_MS
          && exitCode !== 0
        ) {
          setShellCrashed(true);
        }
      } else if (event.type === "control" && event.event === "input_queue_full") {
        const action = typeof event.action === "string" && event.action.length > 0
          ? ` (${event.action})`
          : "";
        setTransportNotice(
          `Terminal input queue is full${action}. Input is still being retried when possible.`,
        );
      } else if (event.type === "control" && event.event === "ready") {
        scheduleRendererRecoveryRef.current(true);
      } else if (event.type === "error") {
        setTransportError(typeof event.error === "string" ? event.error : "Unknown terminal error");
      }
    },
  });
  const { handleBinaryFrame, handleTextEvent, reset: resetRestore } = restoreResult;

  // Keep live-stream snapshot refs in sync with the component-level copies.
  syncRestoreRefsRef.current = () => {
    snapshotAnsiRef.current = restoreResult.snapshotAnsiRef.current;
    snapshotTranscriptRef.current = restoreResult.snapshotTranscriptRef.current;
    snapshotModesRef.current = restoreResult.snapshotModesRef.current;
    liveOutputStartedRef.current = restoreResult.liveOutputStartedRef.current;
  };

  // --- useTerminalSocket (unified WS lifecycle) ---
  const {
    close: socketClose,
    sendBinary: socketSendBinary,
    socketRef,
  } = useTerminalSocket({
    sessionId,
    wsUrl,
    sseUrl,
    enabled: shouldStreamLiveTerminal && terminalReady,
    cols: termRef.current?.cols ?? 80,
    rows: termRef.current?.rows ?? 24,
    lastSequence: lastTerminalSequenceRef.current,
    onData: (data) => {
      if (data instanceof ArrayBuffer) {
        handleBinaryFrame(data);
      } else {
        handleTextEvent(data);
      }
    },
    onReady: (isReconnect) => {
      if (!firstConnectionAtRef.current) {
        firstConnectionAtRef.current = Date.now();
      }
      setTransportError(null);
      if (isReconnect) {
        scheduleRendererRecoveryRef.current(true);
      }
      // Auto-focus the terminal when the connection becomes ready
      // so the user can immediately start typing.
      try { termRef.current?.focus(); } catch { /* noop */ }
    },
    onExit: (exitCode) => {
      if (
        firstConnectionAtRef.current
        && Date.now() - firstConnectionAtRef.current < SHELL_CRASH_DETECTION_WINDOW_MS
        && exitCode !== 0
      ) {
        setShellCrashed(true);
      }
    },
    onError: (msg) => {
      setTransportError(msg);
    },
    onControlNotice: (message) => {
      setTransportNotice(message);
    },
    onStateChange: (state) => {
      setConnectionState(state);
    },
  });

  // --- Binary frame builders (ttyd-style protocol) ---
  const buildBinaryInputFrame = useCallback((data: string): Uint8Array => {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(data);
    const frame = new Uint8Array(1 + encoded.length);
    frame[0] = 0x00; // WS_MSG_INPUT
    frame.set(encoded, 1);
    return frame;
  }, []);

  const buildBinaryResizeFrame = useCallback((cols: number, rows: number): Uint8Array => {
    const encoder = new TextEncoder();
    const json = encoder.encode(JSON.stringify({ cols, rows }));
    const frame = new Uint8Array(1 + json.length);
    frame[0] = 0x01; // WS_MSG_RESIZE
    frame.set(json, 1);
    return frame;
  }, []);

  // --- Zero-delay input functions ---
  const sendTerminalKeys = useCallback(async (data: string) => {
    if (!interactiveTerminalRef.current) {
      throw new Error("Operator access is required for live terminal input");
    }
    const keys = stripBrowserTerminalResponses(data);
    if (keys.length === 0) return;

    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      socketSendBinary(buildBinaryInputFrame(keys));
      return;
    }
    const result = await postSessionTerminalKeys(sessionId, { keys });
    if (!result.accepted) {
      setTransportNotice("Terminal input queue is full. Input is still being retried when possible.");
    }
  }, [sessionId, socketRef, socketSendBinary, buildBinaryInputFrame]);

  // W-14: Keep the ref in sync with the latest useCallback identity.
  sendTerminalKeysRef.current = sendTerminalKeys;

  const sendTerminalSpecial = useCallback((special: string) => {
    if (!interactiveTerminalRef.current) return;
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      // Special keys still go through the legacy JSON path since resolve_terminal_keys
      // on the Rust side does the mapping (Enter → \r, C-c → \x03, etc.)
      ws.send(JSON.stringify({ type: "keys", special }));
      return;
    }
    postSessionTerminalKeys(sessionId, { special })
      .then((result) => {
        if (!result.accepted) {
          setTransportNotice("Terminal input queue is full. Input is still being retried when possible.");
        }
      })
      .catch(() => {
        // Best-effort delivery — network errors are transient and the
        // user can retry by pressing the key again.
      });
  }, [sessionId, socketRef]);

  const sendResize = useCallback(async (cols: number, rows: number): Promise<boolean> => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      socketSendBinary(buildBinaryResizeFrame(cols, rows));
      return true;
    }
    await postTerminalResize(sessionId, cols, rows);
    return true;
  }, [sessionId, socketRef, socketSendBinary, buildBinaryResizeFrame]);

  // --- useTerminalResize ---
  const {
    pendingResizeSyncRef,
    lastSyncedTerminalSizeRef,
    lastObservedContainerSizeRef,
    lastViewportOptionKeyRef,
    preferredFocusTargetRef,
    restoreFocusOnRecoveryRef,
    showScrollToBottom,
    setShowScrollToBottom: _setShowScrollToBottom,
    scheduleRendererRecovery,
    clearScheduledRecovery,
    clearVisibilityRecoveryTimers,
    updateScrollState,
    rememberFocusedSurface,
    restorePreferredFocus,
  } = useTerminalResize(
    sessionId,
    termRef,
    fitRef,
    containerRef,
    nullTextareaRef,
    sendResize,
    setTransportError,
    initialUiState?.viewport ?? null,
  );

  // --- requestSnapshotRender (inline, replaces useTerminalSnapshot's version) ---
  const requestSnapshotRender = useCallback(() => {
    const term = termRef.current;
    const currentSnapshot = snapshotAnsiRef.current;
    if (!term || currentSnapshot.length === 0) return false;
    snapshotAppliedRef.current = sessionId;
    const payload = liveOutputStartedRef.current
      ? buildTerminalSnapshotPayload(currentSnapshot, snapshotModesRef.current)
      : buildReadableSnapshotPayload(currentSnapshot, snapshotTranscriptRef.current);
    queueTerminalWrite({ kind: "snapshot", payload });
    return true;
  }, [queueTerminalWrite, sessionId, termRef]);

  // W-19: Move all callback-ref assignments to the commit phase so they are
  // concurrent-mode safe. useLayoutEffect fires synchronously after the DOM
  // mutations but before the browser paints, which is the correct timing for
  // ref assignments that other effects depend on.
  useLayoutEffect(() => {
    updateScrollStateRef.current = updateScrollState;
    restorePreferredFocusRef.current = restorePreferredFocus;
    scheduleRendererRecoveryRef.current = scheduleRendererRecovery;
    requestSnapshotRenderRef.current = requestSnapshotRender;
  });

  // --- useTerminalSearch ---
  const { searchRef, runSearch } = useTerminalSearch({
    searchOpen,
    searchQuery,
    termRef,
  });

  // W-19: Move lifecycle callback ref assignments to the commit phase.
  useLayoutEffect(() => {
    handleLifecycleInitRef.current = (term, _fit, container) => {
      lastSyncedTerminalSizeRef.current = null;
      pendingResizeSyncRef.current = true;
      lastObservedContainerSizeRef.current = `${Math.round(container.clientWidth)}x${Math.round(container.clientHeight)}`;
      lastViewportOptionKeyRef.current = `${term.options.fontFamily}:${term.options.fontSize}:${term.options.lineHeight}`;
      term.options.disableStdin = !expectsLiveTerminalRef.current || !interactiveTerminalRef.current;
      updateScrollState();
      // Focus immediately so the terminal is ready for input without requiring
      // a click.  Wrapped in rAF to ensure the DOM element is painted first.
      window.requestAnimationFrame(() => {
        try { term.focus(); } catch { /* terminal may have been disposed */ }
        // On the very first live attach, wait for the backend restore frame.
        // Replaying a cached snapshot here races that restore and can duplicate
        // full-screen agent UIs. When reconnecting with a known sequence,
        // render the cached snapshot immediately so the surface is not blank.
        if (!expectsLiveTerminalRef.current || lastTerminalSequenceRef.current !== null) {
          requestSnapshotRenderRef.current();
        }
      });
    };
    handleLifecycleCleanupRef.current = (term) => {
      cachedViewportRef.current = captureTerminalViewport(term);
      clearScheduledTerminalFlush();
      searchRef.current = null;
      snapshotAppliedRef.current = null;
      liveOutputStartedRef.current = false;
      lastSyncedTerminalSizeRef.current = null;
      lastObservedContainerSizeRef.current = null;
      lastViewportOptionKeyRef.current = null;
      terminalWriteQueueRef.current = [];
      terminalWriteInFlightRef.current = false;
      terminalWriteRestoreFocusRef.current = false;
      terminalWriteDecoderRef.current = typeof TextDecoder === "undefined" ? null : new TextDecoder();
      pendingResizeSyncRef.current = true;
    };
  });

  // --- Scroll interaction ---
  const scrollToBottom = useCallback(() => {
    const term = termRef.current;
    if (term) {
      term.scrollToBottom();
      updateScrollState();
    }
  }, [termRef, updateScrollState]);

  const focusTerminal = useCallback(() => {
    try {
      termRef.current?.focus();
    } catch {
      // xterm textarea may not exist during teardown
    }
  }, [termRef]);

  const handleTerminalPointerDown = useCallback(() => {
    preferredFocusTargetRef.current = "terminal";
    restoreFocusOnRecoveryRef.current = true;
    // NOTE: Do NOT call scheduleRendererRecovery here — fit.fit() during a
    // pointer-down steals focus from the xterm hidden textarea, breaking input
    // on both desktop (cursor disappears) and mobile (virtual keyboard won't
    // activate).  The ResizeObserver already triggers recovery on layout change.
  }, [preferredFocusTargetRef, restoreFocusOnRecoveryRef]);

  // --- Snapshot helpers ---
  const applyFetchedSnapshot = useCallback((snapshot: TerminalSnapshot) => {
    snapshotAppliedRef.current = null;
    lastTerminalSequenceRef.current = snapshot.sequence;
    snapshotAnsiRef.current = snapshot.snapshot;
    snapshotTranscriptRef.current = snapshot.transcript;
    snapshotModesRef.current = snapshot.modes;
    storeCachedTerminalSnapshot(sessionId, snapshot);
    setSnapshotReady(true);
    if (typeof window !== "undefined" && termRef.current) {
      window.requestAnimationFrame(() => requestSnapshotRender());
    }
    if (snapshot.live) {
      setConnectionState("live");
    } else {
      setConnectionState("idle");
    }
    setTransportError(null);
  }, [requestSnapshotRender, sessionId, termRef]);

  // Ref-based stable callback pattern (replaces experimental useEffectEvent).
  // The ref always holds the latest closure without causing effect re-runs.
  const persistCachedUiStateRef = useRef<() => void>(() => {});
  persistCachedUiStateRef.current = () => {
    const term = termRef.current;
    const viewport = term && (snapshotAppliedRef.current === sessionId || terminalHasRenderedContent(term))
      ? captureTerminalViewport(term)
      : cachedViewportRef.current;
    cachedViewportRef.current = viewport;
    storeCachedTerminalUiState(sessionId, {
      searchOpen,
      searchQuery,
      viewport,
    });
  };
  const persistCachedUiState = useCallback(() => persistCachedUiStateRef.current(), []);

  // --- Reconnect helper ---
  const lastReconnectAtRef = useRef(0);
  const requestTerminalReconnect = useCallback(() => {
    clearCachedTerminalConnection(sessionId);
    setReconnectToken((v) => v + 1);
  }, [sessionId]);

  // W-10: Debounced version of requestTerminalReconnect for automatic
  // (non-user-initiated) reconnect attempts.  Manual reconnect buttons
  // continue to use requestTerminalReconnect directly.
  const requestTerminalReconnectDebounced = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < RECONNECT_DEBOUNCE_MS) return;
    lastReconnectAtRef.current = now;
    requestTerminalReconnect();
  }, [requestTerminalReconnect]);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Persist UI state on change
  useEffect(() => { persistCachedUiState(); }, [persistCachedUiState, searchOpen, searchQuery]);
  useEffect(() => () => { persistCachedUiState(); }, [persistCachedUiState]);

  // Track live terminal transitions
  useEffect(() => {
    const wasLive = previousLiveTerminalRef.current;
    previousLiveTerminalRef.current = expectsLiveTerminal;
    if (wasLive && !expectsLiveTerminal) {
      snapshotAppliedRef.current = null;
      liveOutputStartedRef.current = false;
      resetRestore();
      // Session completed/failed — close live connection and reset to idle
      // so the "connection lost" overlay doesn't show for finished sessions.
      socketClose();
      setConnectionState("idle");
      setTransportError(null);
    }
  }, [expectsLiveTerminal, resetRestore, socketClose]);

  // Reset state when sessionId changes
  useEffect(() => {
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const cachedUiState = readCachedTerminalUiState(sessionId);

    snapshotAppliedRef.current = null;
    lastTerminalSequenceRef.current = cachedSnapshot?.sequence ?? null;
    liveOutputStartedRef.current = false;
    resetRestore();
    lastSyncedTerminalSizeRef.current = null;
    pendingResizeSyncRef.current = true;
    preferredFocusTargetRef.current = "none";
    restoreFocusOnRecoveryRef.current = false;
    lastObservedContainerSizeRef.current = null;
    lastViewportOptionKeyRef.current = null;
    cachedViewportRef.current = cachedUiState?.viewport ?? null;
    firstConnectionAtRef.current = null;
    lastReconnectAtRef.current = 0;
    clearScheduledRecovery();
    clearScheduledTerminalFlush();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;

    socketClose();
    setWsUrl(null);
    setSseUrl(null);
    setConnectionState("idle");
    setTransportError(null);
    setInteractiveTerminal(true);
    setTransportNotice(null);
    setRuntimeInfo(null);
    setShellCrashed(false);
    setSearchOpen(cachedUiState?.searchOpen ?? false);
    setSearchQuery(cachedUiState?.searchQuery ?? "");
    _setShowScrollToBottom(false);
    setSnapshotReady(cachedSnapshot !== null);
    setSessionStatusOverride(null);
    termRef.current?.reset();
    updateScrollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => { setSessionStatusOverride(null); }, [sessionState]);

  // disableStdin sync
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !expectsLiveTerminal || !interactiveTerminal;
  }, [expectsLiveTerminal, interactiveTerminal, termRef]);

  // Snapshot fetch effect (non-live terminals)
  useEffect(() => {
    let mounted = true;
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const hasCachedSnapshot = cachedSnapshot !== null;
    setSnapshotReady(hasCachedSnapshot);

    if (!active) return () => { mounted = false; };

    if (expectsLiveTerminal) {
      if (!shouldStreamLiveTerminal) return () => { mounted = false; };
      liveOutputStartedRef.current = false;
      lastTerminalSequenceRef.current = null;
      snapshotAppliedRef.current = null;
      snapshotAnsiRef.current = "";
      snapshotTranscriptRef.current = "";
      snapshotModesRef.current = undefined;
      setSnapshotReady(true);
      return () => { mounted = false; };
    }

    void (async () => {
      try {
        const snapshot = await fetchTerminalSnapshot(sessionId, READ_ONLY_TERMINAL_SNAPSHOT_LINES);
        if (!mounted) return;
        applyFetchedSnapshot(snapshot);
      } catch {
        if (!mounted) return;
      } finally {
        if (mounted) setSnapshotReady(true);
      }
    })();

    return () => { mounted = false; };
  }, [active, applyFetchedSnapshot, expectsLiveTerminal, sessionId, shouldStreamLiveTerminal]);

  // Connection bootstrap effect (live terminals -- uses fast bootstrap, no snapshot)
  useEffect(() => {
    if (!expectsLiveTerminal || !shouldStreamLiveTerminal) {
      setWsUrl(null);
      setSseUrl(null);
      setRuntimeInfo(null);
      setConnectionState("idle");
      return;
    }

    let mounted = true;
    void (async () => {
      try {
        setConnectionState("connecting");
        liveOutputStartedRef.current = false;
        lastTerminalSequenceRef.current = null;
        snapshotAppliedRef.current = null;
        snapshotAnsiRef.current = "";
        snapshotTranscriptRef.current = "";
        snapshotModesRef.current = undefined;
        setSnapshotReady(true);
        setWsUrl(null);
        setSseUrl(null);

        const bootstrap = await fetchFastBootstrap(sessionId);
        if (!mounted) return;

        setRuntimeInfo(bootstrap.runtime);
        setInteractiveTerminal(bootstrap.connection.control.interactive);
        setTransportNotice(bootstrap.connection.control.fallbackReason ?? bootstrap.runtime?.notice ?? null);
        setTransportError(null);

        setWsUrl(bootstrap.connection.stream.wsUrl);
        setSseUrl(bootstrap.connection.stream.fallbackUrl ?? null);
      } catch (err) {
        if (!mounted) return;
        setConnectionState("closed");
        setTransportError(err instanceof Error ? err.message : "Failed to resolve terminal connection");
        setTransportNotice(null);
        setRuntimeInfo(null);
        setSnapshotReady(true);
      }
    })();

    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectsLiveTerminal, reconnectToken, sessionId, shouldStreamLiveTerminal]);

  // Active pane recovery effect
  // W-11: Track inner timer handles in refs so they are always cleaned up,
  // even if the rAF callback fires between effect re-runs.
  const recoveryRafRef = useRef<number | null>(null);
  const recoveryFallbackTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    // W-10: Use debounced reconnect to prevent spamming bootstrap requests
    // when the server is persistently unavailable.
    // Do not trigger a reconnect before the initial bootstrap has resolved a
    // transport URL, otherwise we race the first attach and duplicate the
    // initial restore for full-screen agent UIs.
    if (
      expectsLiveTerminal
      && hasResolvedTerminalTransport
      && (connectionState === "closed" || connectionState === "idle")
    ) {
      requestTerminalReconnectDebounced();
    }
    clearVisibilityRecoveryTimers();
    // Single rAF-aligned recovery with one delayed fallback.  The previous
    // triple-shot (0ms, 48ms, 140ms) was firing redundant fit+refresh cycles
    // that caused visible flickering during connection state transitions.
    if (recoveryRafRef.current !== null) window.cancelAnimationFrame(recoveryRafRef.current);
    if (recoveryFallbackTimerRef.current !== null) window.clearTimeout(recoveryFallbackTimerRef.current);
    recoveryRafRef.current = window.requestAnimationFrame(() => {
      recoveryRafRef.current = null;
      scheduleRendererRecovery(true);
    });
    recoveryFallbackTimerRef.current = window.setTimeout(() => {
      recoveryFallbackTimerRef.current = null;
      scheduleRendererRecovery(true);
    }, 150);
    return () => {
      if (recoveryRafRef.current !== null) {
        window.cancelAnimationFrame(recoveryRafRef.current);
        recoveryRafRef.current = null;
      }
      if (recoveryFallbackTimerRef.current !== null) {
        window.clearTimeout(recoveryFallbackTimerRef.current);
        recoveryFallbackTimerRef.current = null;
      }
      clearVisibilityRecoveryTimers();
    };
  }, [
    active,
    clearVisibilityRecoveryTimers,
    connectionState,
    expectsLiveTerminal,
    hasResolvedTerminalTransport,
    requestTerminalReconnectDebounced,
    scheduleRendererRecovery,
  ]);

  // Snapshot render effect
  useEffect(() => {
    if (!terminalReady || !snapshotReady || !canRenderTerminal) return;
    const term = termRef.current;
    if (!term) return;

    const hasRenderedContent = terminalHasRenderedContent(term);
    if (snapshotAppliedRef.current === sessionId && hasRenderedContent) {
      updateScrollState();
      return;
    }
    if (expectsLiveTerminal && liveOutputStartedRef.current) {
      // Live stream already started — the restore frame from useTerminalRestore
      // has queued (or will queue) the snapshot write. Don't duplicate it.
      // Previously this also checked hasRenderedContent, but that's false while
      // the write is still in-flight, causing a redundant snapshot+clear cycle
      // that garbles the terminal during streaming.
      snapshotAppliedRef.current = sessionId;
      updateScrollState();
      return;
    }
    snapshotAppliedRef.current = sessionId;
    const currentAnsi = snapshotAnsiRef.current;
    if (currentAnsi.length > 0) {
      queueTerminalWrite({
        kind: "snapshot",
        payload: liveOutputStartedRef.current
          ? buildTerminalSnapshotPayload(currentAnsi, snapshotModesRef.current)
          : buildReadableSnapshotPayload(currentAnsi, snapshotTranscriptRef.current),
      });
      return;
    }
    updateScrollState();
  }, [
    expectsLiveTerminal, sessionId,
    snapshotReady, terminalReady, queueTerminalWrite, updateScrollState, canRenderTerminal, termRef,
  ]);

  // Visibility/focus effect
  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(!document.hidden);
      if (document.hidden) { rememberFocusedSurface(); return; }
      if (
        expectsLiveTerminal
        && hasResolvedTerminalTransport
        && (connectionState === "closed" || connectionState === "idle")
      ) {
        requestTerminalReconnectDebounced();
      }
      scheduleRendererRecovery(false);
    };
    const handleWindowFocus = () => {
      setPageVisible(!document.hidden);
      if (
        !document.hidden
        && expectsLiveTerminal
        && hasResolvedTerminalTransport
        && (connectionState === "closed" || connectionState === "idle")
      ) {
        requestTerminalReconnectDebounced();
      }
      scheduleRendererRecovery(false);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [
    connectionState,
    expectsLiveTerminal,
    hasResolvedTerminalTransport,
    rememberFocusedSurface,
    requestTerminalReconnectDebounced,
    scheduleRendererRecovery,
  ]);

  useEffect(() => {
    const handleFocusIn = () => rememberFocusedSurface();
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [rememberFocusedSurface]);

  // Cleanup when not streaming
  useEffect(() => {
    if (shouldStreamLiveTerminal) return;
    clearScheduledTerminalFlush();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    socketClose();
    if (expectsLiveTerminal) {
      clearCachedTerminalSnapshot(sessionId);
      snapshotAppliedRef.current = null;
      snapshotAnsiRef.current = "";
      snapshotTranscriptRef.current = "";
      snapshotModesRef.current = undefined;
      lastTerminalSequenceRef.current = null;
      liveOutputStartedRef.current = false;
      setSnapshotReady(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldStreamLiveTerminal, sessionId, expectsLiveTerminal]);

  // Global cleanup
  useEffect(() => () => {
    clearScheduledRecovery();
    clearScheduledTerminalFlush();
    clearVisibilityRecoveryTimers();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    socketClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Auto-focus the search input after React renders it.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    restorePreferredFocus();
  }, [restorePreferredFocus]);

  // Keyboard shortcut: Ctrl+F / Cmd+F toggles search
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        if (searchOpen) {
          closeSearch();
        } else {
          openSearch();
        }
      }
    };
    surface.addEventListener("keydown", handler, true);
    return () => surface.removeEventListener("keydown", handler, true);
  }, [searchOpen, closeSearch, openSearch]);

  // Connection lost overlay
  const connectionLostOverlay =
    connectionState !== "live"
    && connectionState !== "idle"
    && connectionState !== "connecting"
    && terminalReady
    && termRef.current
    && terminalHasRenderedContent(termRef.current)
      ? (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-3 rounded-[16px] border border-white/10 bg-[#141010]/95 px-6 py-5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
              <AlertCircle className="h-5 w-5 text-[#c9c0b7]" />
              <p className="text-center text-[13px] text-[#c9c0b7]">
                Terminal connection lost. Scrollback is read-only.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 rounded-full border border-white/10 bg-white/6 px-4 text-[12px] text-[#efe8e1] hover:bg-white/10"
                onClick={requestTerminalReconnect}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Reconnect
              </Button>
            </div>
          </div>
        )
      : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      className="group/terminal relative flex h-full min-h-0 flex-1 flex-col overflow-clip bg-[#060404] outline-none"
    >
      {searchOpen ? (
        <div className="absolute right-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur sm:right-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)]">
          <Search className="h-3.5 w-3.5 text-[#8e847d]" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "prev" : "next");
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="h-6 w-24 min-w-0 bg-transparent px-2 text-[11px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] sm:w-28 sm:text-[12px]"
          />
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 sm:h-6 sm:w-6 text-[#c9c0b7]" onClick={() => runSearch("prev")} aria-label="Find previous">
            <span className="text-[11px]">&#x2191;</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 sm:h-6 sm:w-6 text-[#c9c0b7]" onClick={() => runSearch("next")} aria-label="Find next">
            <span className="text-[11px]">&#x2193;</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 sm:h-6 sm:w-6 text-[#c9c0b7]" onClick={closeSearch} aria-label="Close search">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1.5 opacity-0 transition-opacity duration-200 group-hover/terminal:opacity-100 focus-within:opacity-100 sm:right-3 sm:top-3 sm:gap-2">
          {connectionState !== "live" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={`pointer-events-auto h-10 w-10 sm:h-7 sm:w-7 rounded-full border backdrop-blur-sm ${
                transportError
                  ? "border-[#ff8f7a]/25 bg-[#2a1616]/92 text-[#ff8f7a] hover:bg-[#351b1b]"
                  : "border-white/10 bg-[#141010]/92 text-[#c9c0b7] hover:bg-[#201818]"
              }`}
              onClick={requestTerminalReconnect}
              aria-label="Reconnect"
            >
              {connectionState === "connecting"
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : transportError
                  ? <AlertCircle className="h-3.5 w-3.5" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
        </div>
      )}

      {/* Terminal container - fills everything */}
      <div className="absolute inset-0">
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
          onClick={focusTerminal}
          onPointerDown={handleTerminalPointerDown}
        />
      </div>

      {/* Scroll to bottom */}
      {showScrollToBottom ? (
        <div
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ bottom: "72px" }}
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="pointer-events-auto h-9 rounded-full border border-white/10 bg-[#141010]/92 px-3 text-[#efe8e1] shadow-[0_14px_28px_rgba(0,0,0,0.38)] backdrop-blur-sm hover:bg-[#201818]"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <ChevronDown className="h-4 w-4" />
            <span className="ml-1 text-[11px] uppercase tracking-[0.16em]">Jump to latest</span>
          </Button>
        </div>
      ) : null}

      {/* Shell crash overlay */}
      {shellCrashed ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-[16px] border border-[#ff8f7a]/20 bg-[#1d1111]/95 px-6 py-5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <AlertCircle className="h-6 w-6 text-[#ff8f7a]" />
            <p className="text-center text-[13px] text-[#efe8e1]">
              The agent shell exited unexpectedly shortly after starting.
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-full border border-[#ff8f7a]/20 bg-[#ff8f7a]/10 px-4 text-[12px] text-[#ff8f7a] hover:bg-[#ff8f7a]/20"
              onClick={() => {
                setShellCrashed(false);
                firstConnectionAtRef.current = null;
                requestTerminalReconnect();
              }}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      ) : connectionLostOverlay}

      {/* MobileKeyBar for touch devices */}
      {isMobile ? (
        <MobileKeyBar
          onSpecialKey={sendTerminalSpecial}
          enabled={expectsLiveTerminal && connectionState === "live"}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileKeyBar -- compact strip for touch devices
// ---------------------------------------------------------------------------

function MobileKeyBar({ onSpecialKey, enabled }: { onSpecialKey: (special: string) => void; enabled: boolean }) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) { setVisible(false); return; }
    setVisible(true);
    const reset = () => {
      setVisible(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setVisible(false), 3000);
    };
    reset();
    window.addEventListener("touchstart", reset, { passive: true });
    return () => {
      window.removeEventListener("touchstart", reset);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [enabled]);

  if (!visible) return null;

  const keys = [
    { label: "Ctrl+C", special: "C-c" },
    { label: "Ctrl+D", special: "C-d" },
    { label: "Enter", special: "Enter" },
    { label: "Esc", special: "Escape" },
  ] as const;

  return (
    <div className="flex h-9 items-center justify-center gap-2 bg-[#0b0808]/96 px-3">
      {keys.map(({ label, special }) => (
        <button
          key={special}
          type="button"
          className="rounded-md border border-white/12 bg-white/6 px-2.5 py-1 text-[11px] text-[#d7cec7] transition active:bg-white/12"
          onClick={() => onSpecialKey(special)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
