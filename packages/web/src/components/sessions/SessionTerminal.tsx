"use client";

import React, { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getTerminalTheme } from "@/components/terminal/xtermTheme";
import { captureTerminalViewport } from "./terminalViewport";
import {
  buildTerminalSnapshotPayload,
  calculateMobileTerminalViewportMetrics,
  getSessionTerminalViewportOptions,
  type TerminalModeState,
} from "./sessionTerminalUtils";
import type { TerminalInsertRequest } from "./terminalInsert";

// --- Extracted modules ---
import {
  LIVE_TERMINAL_STATUSES,
  LIVE_TERMINAL_SCROLLBACK,
  READ_ONLY_TERMINAL_SNAPSHOT_LINES,
} from "./terminal/terminalConstants";
import type {
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
  fetchTerminalConnection,
  fetchTerminalSnapshot,
} from "./terminal/terminalApi";
import {
  buildReadableSnapshotPayload,
  terminalHasRenderedContent,
  shouldShowTerminalAccessoryBar,
} from "./terminal/terminalHelpers";
import {
  loadTerminalCoreClientModules,
  loadTerminalWebglAddonModule,
  loadTerminalUnicode11AddonModule,
  loadTerminalWebLinksAddonModule,
} from "./terminal/useTerminalAddons";
import { useTerminalSearch } from "./terminal/useTerminalSearch";
import { useTerminalInput } from "./terminal/useTerminalInput";
import { useTerminalResize } from "./terminal/useTerminalResize";
import { useTerminalSnapshot } from "./terminal/useTerminalSnapshot";
import { useTtydConnection } from "./terminal/useTtydConnection";

// ---------------------------------------------------------------------------

interface SessionTerminalProps {
  sessionId: string;
  agentName: string;
  projectId: string;
  sessionModel: string;
  sessionReasoningEffort: string;
  sessionState: string;
  active: boolean;
  pendingInsert: TerminalInsertRequest | null;
  immersiveMobileMode?: boolean;
}

export function SessionTerminal({
  sessionId,
  agentName,
  projectId,
  sessionModel,
  sessionReasoningEffort,
  sessionState,
  active,
  pendingInsert,
  immersiveMobileMode = false,
}: SessionTerminalProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const inputDisposableRef = useRef<IDisposable | null>(null);
  const scrollDisposableRef = useRef<IDisposable | null>(null);
  const resumeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const latestStatusRef = useRef(sessionState);
  const activeRef = useRef(active);
  const pageVisibleRef = useRef(typeof document === "undefined" ? true : !document.hidden);
  const previousLiveTerminalRef = useRef(false);
  const lastAppliedInsertNonceRef = useRef<number>(0);
  const expectsLiveTerminalRef = useRef(false);

  const initialUiState = readCachedTerminalUiState(sessionId);

  const [terminalReady, setTerminalReady] = useState(false);
  const [ptyWsUrl, setPtyWsUrl] = useState<string | null>(null);
  const ptySocketRef = useRef<WebSocket | null>(null);
  const ptyActiveRef = useRef(false);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [interactiveTerminal, setInteractiveTerminal] = useState(true);
  const [searchOpen, setSearchOpen] = useState(() => initialUiState?.searchOpen ?? false);
  const [searchQuery, setSearchQuery] = useState(() => initialUiState?.searchQuery ?? "");
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [snapshotAnsi, setSnapshotAnsi] = useState("");
  const [snapshotTranscript, setSnapshotTranscript] = useState("");
  const [snapshotModes, setSnapshotModes] = useState<TerminalModeState | undefined>(undefined);
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const [sessionStatusOverride, setSessionStatusOverride] = useState<string | null>(null);
  const [mobileViewportHeight, setMobileViewportHeight] = useState<number | null>(null);

  // --- Derived state ---
  const normalizedSessionStatus = useMemo(
    () => {
      const candidate = typeof sessionStatusOverride === "string" && sessionStatusOverride.trim().length > 0
        ? sessionStatusOverride
        : sessionState;
      return candidate.trim().toLowerCase();
    },
    [sessionState, sessionStatusOverride],
  );
  latestStatusRef.current = normalizedSessionStatus;
  activeRef.current = active;

  const expectsLiveTerminal = LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus);
  const shouldAttachTerminalSurface = active && pageVisible;
  const shouldStreamLiveTerminal = expectsLiveTerminal && shouldAttachTerminalSurface;
  const canSendLiveInput = expectsLiveTerminal && interactiveTerminal && connectionState === "live";
  const canRenderTerminal = shouldAttachTerminalSurface;
  expectsLiveTerminalRef.current = expectsLiveTerminal;
  pageVisibleRef.current = pageVisible;

  // --- Extracted hooks ---
  const {
    sendResize,
    sendTerminalKeys,
    clearScheduledTerminalHttpControlFlush,
    terminalHttpControlQueueRef,
    terminalHttpControlInFlightRef,
    interactiveTerminalRef: inputInteractiveRef,
  } = useTerminalInput(sessionId);

  // Keep the input hook's interactivity ref in sync
  inputInteractiveRef.current = interactiveTerminal;

  // TTyD WebSocket connection (for direct PTY I/O via binary protocol)
  // Must be declared before httpSendResize that uses it
  const {
    isConnected: ttydConnected,
    isConnecting: ttydConnecting,
    error: ttydError,
    sendInput: ttydSendInput,
    sendResize: ttydSendResize,
  } = useTtydConnection({
    terminal: termRef.current,
    fitAddon: fitRef.current,
    ptyWsUrl,
    enabled: ptyWsUrl !== null && expectsLiveTerminalRef.current,
    onConnectionReady: () => {
      ptyActiveRef.current = true;
      setConnectionState("live");
      setTransportError(null);
    },
    onConnectionClosed: (code) => {
      ptyActiveRef.current = false;
      if (code !== 1000) {
        setConnectionState("error");
      } else {
        setConnectionState("closed");
      }
    },
    onConnectionError: (error) => {
      ptyActiveRef.current = false;
      setTransportError(error.message);
      setConnectionState("error");
    },
  });

  // When the bidirectional PTY WS is active, resize is handled directly
  // over the WS — skip the HTTP resize to avoid double SIGWINCH.
  const httpSendResize = useCallback(
    async (cols: number, rows: number): Promise<boolean> => {
      if (ttydConnected) {
        ttydSendResize(cols, rows);
        return true;
      }
      if (ptyActiveRef.current) return true;
      return sendResize(cols, rows);
    },
    [ttydConnected, ttydSendResize, sendResize],
  );

  const {
    pendingResizeSyncRef,
    lastSyncedTerminalSizeRef,
    lastObservedContainerSizeRef,
    lastViewportOptionKeyRef,
    pendingViewportRestoreRef,
    preferredFocusTargetRef,
    restoreFocusOnRecoveryRef,
    showScrollToBottom,
    setShowScrollToBottom: _setShowScrollToBottom,
    syncTerminalDimensions,
    scheduleRendererRecovery,
    clearScheduledRecovery,
    clearVisibilityRecoveryTimers,
    applyViewportRestore,
    updateScrollState,
    rememberTerminalViewport,
    rememberFocusedSurface,
    restorePreferredFocus,
  } = useTerminalResize(
    sessionId,
    termRef,
    fitRef,
    containerRef,
    resumeTextareaRef,
    httpSendResize,
    setTransportError,
    initialUiState?.viewport ?? null,
  );

  const {
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
  } = useTerminalSnapshot(
    sessionId,
    termRef,
    applyViewportRestore,
    updateScrollState,
    restorePreferredFocus,
  );

  const { searchRef, runSearch } = useTerminalSearch({
    searchOpen,
    searchQuery,
    termRef,
  });

  // Keep snapshot refs in sync with React state
  snapshotAnsiRef.current = snapshotAnsi;
  snapshotTranscriptRef.current = snapshotTranscript;
  snapshotModesRef.current = snapshotModes;

  const floatingOverlayBottomPx = 12;
  const terminalSurfaceStyle = useMemo<CSSProperties | undefined>(() => {
    if (!immersiveMobileMode || !mobileViewportHeight || mobileViewportHeight <= 0) {
      return undefined;
    }

    return {
      height: `${mobileViewportHeight}px`,
      minHeight: `${mobileViewportHeight}px`,
    };
  }, [immersiveMobileMode, mobileViewportHeight]);

  // --- Stable callback refs for use inside useEffects ---
  const requestSnapshotRenderRef = useRef(requestSnapshotRender);
  const updateScrollStateRef = useRef(updateScrollState);
  const clearScheduledTerminalFlushRef = useRef(clearScheduledTerminalFlush);
  const scheduleRendererRecoveryRef = useRef<(forceResize: boolean) => void>(scheduleRendererRecovery);

  useEffect(() => { requestSnapshotRenderRef.current = requestSnapshotRender; }, [requestSnapshotRender]);
  useEffect(() => { updateScrollStateRef.current = updateScrollState; }, [updateScrollState]);
  useEffect(() => { clearScheduledTerminalFlushRef.current = clearScheduledTerminalFlush; }, [clearScheduledTerminalFlush]);
  useEffect(() => { scheduleRendererRecoveryRef.current = scheduleRendererRecovery; }, [scheduleRendererRecovery]);

  // --- Callbacks ---
  const applyFetchedSnapshot = useCallback((snapshot: TerminalSnapshot) => {
    snapshotAppliedRef.current = null;
    lastTerminalSequenceRef.current = snapshot.sequence;
    snapshotAnsiRef.current = snapshot.snapshot;
    snapshotTranscriptRef.current = snapshot.transcript;
    snapshotModesRef.current = snapshot.modes;
    storeCachedTerminalSnapshot(sessionId, snapshot);
    setSnapshotAnsi(snapshot.snapshot);
    setSnapshotTranscript(snapshot.transcript);
    setSnapshotModes(snapshot.modes);
    setSnapshotReady(true);
    if (typeof window !== "undefined" && termRef.current) {
      window.requestAnimationFrame(() => {
        requestSnapshotRender();
      });
    }
    if (snapshot.live) {
      setConnectionState("live");
      setTransportError(null);
    }
  }, [lastTerminalSequenceRef, requestSnapshotRender, sessionId, snapshotAppliedRef, snapshotAnsiRef, snapshotModesRef, snapshotTranscriptRef]);

  const persistCachedUiState = useEffectEvent(() => {
    const term = termRef.current;
    const viewport = term && (snapshotAppliedRef.current === sessionId || terminalHasRenderedContent(term))
      ? captureTerminalViewport(term)
      : pendingViewportRestoreRef.current;
    pendingViewportRestoreRef.current = viewport;
    storeCachedTerminalUiState(sessionId, {
      message: "",
      searchOpen,
      searchQuery,
      helperPanelOpen: false,
      viewport,
    });
  });

  // --- Effects ---

  useEffect(() => {
    persistCachedUiState();
  }, [persistCachedUiState, searchOpen, searchQuery]);

  useEffect(() => () => {
    persistCachedUiState();
  }, [persistCachedUiState]);

  useEffect(() => {
    const wasLiveTerminal = previousLiveTerminalRef.current;
    previousLiveTerminalRef.current = expectsLiveTerminal;
    if (wasLiveTerminal && !expectsLiveTerminal) {
      snapshotAppliedRef.current = null;
      liveOutputStartedRef.current = false;
    }
  }, [expectsLiveTerminal, liveOutputStartedRef, snapshotAppliedRef]);

  useEffect(() => {
    if (!immersiveMobileMode || typeof window === "undefined" || !window.visualViewport) {
      setMobileViewportHeight(null);
      return;
    }

    const visualViewport = window.visualViewport;
    let frameHandle: number | null = null;
    const syncMobileViewport = () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      frameHandle = window.requestAnimationFrame(() => {
        frameHandle = null;
        const surface = surfaceRef.current;
        if (!surface) {
          return;
        }
        const metrics = calculateMobileTerminalViewportMetrics(
          window.innerHeight,
          visualViewport.height,
          visualViewport.offsetTop,
          surface.getBoundingClientRect().top,
        );
        setMobileViewportHeight((current) => (current === metrics.usableHeight ? current : metrics.usableHeight));
        if (activeRef.current) {
          // false — just re-fit dimensions, no full repaint. Mobile viewport
          // changes (keyboard show/hide, scroll) are frequent during live
          // streaming; forceResize=true would trigger term.refresh() causing
          // visible flicker on every viewport event.
          scheduleRendererRecovery(false);
        }
      });
    };

    syncMobileViewport();
    visualViewport.addEventListener("resize", syncMobileViewport);
    visualViewport.addEventListener("scroll", syncMobileViewport);
    window.addEventListener("resize", syncMobileViewport);

    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      visualViewport.removeEventListener("resize", syncMobileViewport);
      visualViewport.removeEventListener("scroll", syncMobileViewport);
      window.removeEventListener("resize", syncMobileViewport);
    };
  }, [immersiveMobileMode, scheduleRendererRecovery]);

  // Reset state when sessionId changes
  useEffect(() => {
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const cachedUiState = readCachedTerminalUiState(sessionId);
    snapshotAppliedRef.current = null;
    lastTerminalSequenceRef.current = cachedSnapshot?.sequence ?? null;
    liveOutputStartedRef.current = false;
    lastAppliedInsertNonceRef.current = 0;
    lastSyncedTerminalSizeRef.current = null;
    pendingResizeSyncRef.current = true;
    preferredFocusTargetRef.current = "none";
    restoreFocusOnRecoveryRef.current = false;
    clearScheduledRecovery();
    clearScheduledTerminalFlush();
    clearScheduledTerminalHttpControlFlush();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    terminalHttpControlQueueRef.current = [];
    terminalHttpControlInFlightRef.current = false;
    lastObservedContainerSizeRef.current = null;
    lastViewportOptionKeyRef.current = null;
    pendingViewportRestoreRef.current = cachedUiState?.viewport ?? null;
    setConnectionState("connecting");
    setTransportError(null);
    setInteractiveTerminal(true);
    setSearchOpen(cachedUiState?.searchOpen ?? false);
    setSearchQuery(cachedUiState?.searchQuery ?? "");
    _setShowScrollToBottom(false);
    setSnapshotReady(cachedSnapshot !== null);
    setSnapshotAnsi(cachedSnapshot?.snapshot ?? "");
    setSnapshotTranscript(cachedSnapshot?.transcript ?? "");
    setSnapshotModes(cachedSnapshot?.modes);
    setSessionStatusOverride(null);
    setMobileViewportHeight(null);
    termRef.current?.reset();
    updateScrollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    setSessionStatusOverride(null);
  }, [sessionState]);

  // Snapshot fetch effect
  useEffect(() => {
    let mounted = true;
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const hasCachedSnapshot = cachedSnapshot !== null;
    setSnapshotReady(hasCachedSnapshot);

    if (!active) {
      return () => { mounted = false; };
    }

    if (expectsLiveTerminal) {
      if (!shouldStreamLiveTerminal) {
        return () => { mounted = false; };
      }

      liveOutputStartedRef.current = false;
      lastTerminalSequenceRef.current = null;
      snapshotAppliedRef.current = null;
      snapshotAnsiRef.current = "";
      snapshotTranscriptRef.current = "";
      snapshotModesRef.current = undefined;
      setSnapshotAnsi("");
      setSnapshotTranscript("");
      setSnapshotModes(undefined);
      setSnapshotReady(true);

      return () => { mounted = false; };
    }

    if (hasCachedSnapshot) {
      setSnapshotAnsi(cachedSnapshot.snapshot);
      setSnapshotTranscript(cachedSnapshot.transcript);
      setSnapshotModes(cachedSnapshot.modes);
    } else {
      setSnapshotAnsi("");
      setSnapshotTranscript("");
      setSnapshotModes(undefined);
    }
    void (async () => {
      try {
        const snapshot = await fetchTerminalSnapshot(sessionId, READ_ONLY_TERMINAL_SNAPSHOT_LINES);
        if (!mounted) return;
        applyFetchedSnapshot(snapshot);
      } catch {
        if (!mounted) return;
        setSnapshotAnsi("");
        setSnapshotTranscript("");
      } finally {
        if (mounted) {
          setSnapshotReady(true);
        }
      }
    })();

    return () => { mounted = false; };
  }, [active, applyFetchedSnapshot, expectsLiveTerminal, lastTerminalSequenceRef, liveOutputStartedRef, sessionId, shouldStreamLiveTerminal, snapshotAppliedRef, snapshotAnsiRef, snapshotModesRef, snapshotTranscriptRef]);

  // Connection resolution effect — clears stale cached connection to ensure
  // fresh token/URL when a session transitions to live.
  useEffect(() => {
    let mounted = true;

    if (!expectsLiveTerminal || !shouldStreamLiveTerminal) {
      setConnectionState("closed");
      setTransportError(null);
      return () => { mounted = false; };
    }

    // Bust stale cached connection info so we always get a fresh ptyWsUrl/token
    clearCachedTerminalConnection(sessionId);

    void (async () => {
      try {
        const connection = await fetchTerminalConnection(sessionId);
        if (!mounted) return;
        setPtyWsUrl(connection.ptyWsUrl);
        setInteractiveTerminal(connection.control.interactive);
        setTransportError(null);
        setConnectionState("connecting");
      } catch (err) {
        if (!mounted) return;
        setTransportError(err instanceof Error ? err.message : "Failed to resolve terminal connection");
        setConnectionState("error");
      }
    })();

    return () => { mounted = false; };
  }, [expectsLiveTerminal, sessionId, shouldStreamLiveTerminal]);

  // --- Event handlers (useEffectEvent) ---
  const handleTerminalData = useEffectEvent((data: string) => {
    // When ttyd WebSocket is active, send input directly over it
    if (ttydConnected) {
      ttydSendInput(data);
      return;
    }
    // Otherwise skip if ptyActiveRef is set (legacy bidirectional WS)
    if (ptyActiveRef.current) return;
    void sendTerminalKeys(data).catch(() => {
      // Ignore transient disconnects while xterm is still flushing local input.
    });
  });

  const handleTerminalScroll = useEffectEvent(() => {
    rememberTerminalViewport();
    updateScrollState();
  });

  const handleTerminalResizeObserved = useEffectEvent((term: XTerminal, entry: ResizeObserverEntry) => {
    if (!activeRef.current) {
      return;
    }

    const nextViewportOptions = getSessionTerminalViewportOptions(window.innerWidth);
    const viewportKey = `${nextViewportOptions.fontFamily}:${nextViewportOptions.fontSize}:${nextViewportOptions.lineHeight}`;
    const sizeKey = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
    if (lastObservedContainerSizeRef.current === sizeKey && lastViewportOptionKeyRef.current === viewportKey) {
      return;
    }

    lastObservedContainerSizeRef.current = sizeKey;
    lastViewportOptionKeyRef.current = viewportKey;

    // Track whether font metrics actually changed — only font changes need
    // a full repaint (forceResize=true). Pure container size changes just
    // need a re-fit (false), which avoids term.refresh() and the visible
    // flicker it causes during live streaming on mobile.
    let fontChanged = false;
    try {
      if (term.options.fontFamily !== nextViewportOptions.fontFamily) {
        term.options.fontFamily = nextViewportOptions.fontFamily;
        fontChanged = true;
      }
      if (term.options.fontSize !== nextViewportOptions.fontSize) {
        term.options.fontSize = nextViewportOptions.fontSize;
        fontChanged = true;
      }
      if (term.options.lineHeight !== nextViewportOptions.lineHeight) {
        term.options.lineHeight = nextViewportOptions.lineHeight;
        fontChanged = true;
      }
    } catch {
      return;
    }

    scheduleRendererRecovery(fontChanged);
  });

  // --- Terminal init effect ---
  useEffect(() => {
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let mounted = true;

    async function init() {
      if (!shouldAttachTerminalSurface || !containerRef.current || !mounted) return;

      const [xtermMod, fitMod] = await loadTerminalCoreClientModules();

      if (!mounted || !containerRef.current) return;

      const isLight = document.documentElement.classList.contains("light");
      const viewportOptions = getSessionTerminalViewportOptions(window.innerWidth);
      const isMobileViewport = shouldShowTerminalAccessoryBar();
      const terminalOptions: ITerminalOptions & { scrollbar?: { showScrollbar: boolean } } = {
        allowTransparency: false,
        cursorBlink: true,
        cursorStyle: "block",
        cursorInactiveStyle: "outline",
        disableStdin: !expectsLiveTerminalRef.current,
        drawBoldTextInBrightColors: true,
        fontFamily: viewportOptions.fontFamily,
        fontSize: viewportOptions.fontSize,
        fontWeight: "400",
        fontWeightBold: "700",
        fastScrollSensitivity: 4,
        lineHeight: viewportOptions.lineHeight,
        scrollSensitivity: 1.1,
        scrollback: LIVE_TERMINAL_SCROLLBACK,
        theme: getTerminalTheme(isLight),
        scrollbar: {
          showScrollbar: !isMobileViewport,
        },
      };
      term = new xtermMod.Terminal(terminalOptions);
      fit = new fitMod.FitAddon();
      term.loadAddon(fit);

      term.open(containerRef.current);
      fit.fit();

      void loadTerminalWebglAddonModule()
        .then((webglMod) => {
          if (!mounted || termRef.current !== term) return;
          const webglAddon = new webglMod.WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
          });
          term!.loadAddon(webglAddon);
        })
        .catch(() => {});

      void loadTerminalUnicode11AddonModule()
        .then((unicode11Mod) => {
          if (!mounted || termRef.current !== term) return;
          const unicode11Addon = new unicode11Mod.Unicode11Addon();
          term!.loadAddon(unicode11Addon);
          term!.unicode.activeVersion = "11";
        })
        .catch(() => {});

      void loadTerminalWebLinksAddonModule()
        .then((webLinksMod) => {
          if (!mounted || termRef.current !== term) return;
          const webLinksAddon = new webLinksMod.WebLinksAddon();
          term!.loadAddon(webLinksAddon);
        })
        .catch(() => {});

      termRef.current = term;
      fitRef.current = fit;
      lastSyncedTerminalSizeRef.current = null;
      pendingResizeSyncRef.current = true;
      lastObservedContainerSizeRef.current = `${Math.round(containerRef.current.clientWidth)}x${Math.round(containerRef.current.clientHeight)}`;
      lastViewportOptionKeyRef.current = `${viewportOptions.fontFamily}:${viewportOptions.fontSize}:${viewportOptions.lineHeight}`;
      term.options.disableStdin = !expectsLiveTerminalRef.current || !inputInteractiveRef.current;
      setTerminalReady(true);
      updateScrollStateRef.current();
      window.requestAnimationFrame(() => {
        if (!mounted) {
          return;
        }
        requestSnapshotRenderRef.current();
      });

      inputDisposableRef.current = term.onData((data) => {
        handleTerminalData(data);
      });
      scrollDisposableRef.current = term.onScroll(() => {
        handleTerminalScroll();
      });

      resizeObserverRef.current = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || !term) {
          return;
        }
        handleTerminalResizeObserved(term, entry);
      });
      resizeObserverRef.current.observe(containerRef.current);
    }

    if (!shouldAttachTerminalSurface) {
      setTerminalReady(false);
      return () => { mounted = false; };
    }

    void init();

    return () => {
      mounted = false;
      if (term) {
        pendingViewportRestoreRef.current = captureTerminalViewport(term);
      }
      clearScheduledTerminalFlushRef.current();
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
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
      setTerminalReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, shouldAttachTerminalSurface]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.disableStdin = !expectsLiveTerminal || !interactiveTerminal;
  }, [expectsLiveTerminal, interactiveTerminal]);

  // Active pane recovery — fires ONLY on tab activation.
  // A single recovery re-fits the terminal after potential WebGL context loss,
  // plus one delayed retry to handle late-settling layouts.
  // connectionState and shouldStreamLiveTerminal intentionally excluded —
  // recovery must NEVER fire during live streaming or connection transitions,
  // as it triggers term.refresh() which causes full-screen repaints that
  // produce visible flicker while data is actively streaming.
  useEffect(() => {
    if (!active) {
      return;
    }

    scheduleRendererRecovery(true);
    const retryTimer = window.setTimeout(() => {
      scheduleRendererRecovery(false);
    }, 150);

    return () => {
      window.clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, scheduleRendererRecovery]);

  // Snapshot render effect
  useEffect(() => {
    if (!terminalReady || !snapshotReady || !canRenderTerminal) {
      return;
    }

    const term = termRef.current;
    if (!term) {
      return;
    }

    const hasRenderedContent = terminalHasRenderedContent(term);

    if (snapshotAppliedRef.current === sessionId && hasRenderedContent) {
      updateScrollState();
      return;
    }

    if (expectsLiveTerminal && liveOutputStartedRef.current && hasRenderedContent) {
      snapshotAppliedRef.current = sessionId;
      updateScrollState();
      return;
    }

    snapshotAppliedRef.current = sessionId;
    if (snapshotAnsi.length > 0) {
      queueTerminalWrite({
        kind: "snapshot",
        payload: liveOutputStartedRef.current
          ? buildTerminalSnapshotPayload(snapshotAnsi, snapshotModes)
          : buildReadableSnapshotPayload(snapshotAnsi, snapshotTranscript),
      });
      return;
    }

    updateScrollState();
  }, [
    expectsLiveTerminal,
    liveOutputStartedRef,
    sessionId,
    snapshotAnsi,
    snapshotAppliedRef,
    snapshotTranscript,
    snapshotModes,
    snapshotReady,
    terminalReady,
    queueTerminalWrite,
    updateScrollState,
    canRenderTerminal,
  ]);

  // Debug state effect
  useEffect(() => {
    if (typeof window === "undefined" || process.env.NODE_ENV === "production") {
      return;
    }

    window.__conductorSessionTerminalDebug = {
      sessionId,
      getState: () => ({
        sessionId,
        active,
        terminalReady,
        snapshotReady,
        snapshotLength: snapshotAnsi.length,
        snapshotTranscriptLength: snapshotTranscript.length,
        snapshotPreview: snapshotAnsi.slice(0, 120),
        connectionState,
        interactiveTerminal,
        liveOutputStarted: liveOutputStartedRef.current,
        snapshotApplied: snapshotAppliedRef.current,
        hasRenderedContent: termRef.current ? terminalHasRenderedContent(termRef.current) : false,
        termRows: termRef.current?.rows ?? null,
        termCols: termRef.current?.cols ?? null,
        bufferBaseY: termRef.current?.buffer.active.baseY ?? null,
        bufferViewportY: termRef.current?.buffer.active.viewportY ?? null,
        ptyWsUrl,
        ttydConnected,
        ttydConnecting,
        ttydError: ttydError?.message ?? null,
        expectsLiveTerminal,
        pageVisible,
        shouldAttachTerminalSurface,
        shouldStreamLiveTerminal,
      }),
    };

    return () => {
      if (window.__conductorSessionTerminalDebug?.sessionId === sessionId) {
        delete window.__conductorSessionTerminalDebug;
      }
    };
  }, [
    active,
    connectionState,
    expectsLiveTerminal,
    interactiveTerminal,
    liveOutputStartedRef,
    pageVisible,
    ptyWsUrl,
    sessionId,
    shouldAttachTerminalSurface,
    shouldStreamLiveTerminal,
    snapshotAnsi,
    snapshotAppliedRef,
    snapshotTranscript,
    snapshotReady,
    terminalReady,
    ttydConnected,
    ttydConnecting,
    ttydError,
  ]);

  // Visibility/focus effect
  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(!document.hidden);
      if (document.hidden) {
        rememberFocusedSurface();
        return;
      }
      scheduleRendererRecovery(false);
    };

    const handleWindowFocus = () => {
      setPageVisible(!document.hidden);
      scheduleRendererRecovery(false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
    // connectionState and shouldStreamLiveTerminal intentionally excluded —
    // these event handlers must be stable regardless of streaming state.
    // Re-registering on connection changes was causing unnecessary churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberFocusedSurface, scheduleRendererRecovery]);

  useEffect(() => {
    const handleDocumentFocusIn = () => {
      rememberFocusedSurface();
    };

    document.addEventListener("focusin", handleDocumentFocusIn);
    return () => {
      document.removeEventListener("focusin", handleDocumentFocusIn);
    };
  }, [rememberFocusedSurface]);

  // Cleanup when not streaming
  useEffect(() => {
    if (shouldStreamLiveTerminal) {
      return;
    }

    clearScheduledTerminalFlush();
    clearScheduledTerminalHttpControlFlush();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    terminalHttpControlQueueRef.current = [];
    terminalHttpControlInFlightRef.current = false;
    ptyActiveRef.current = false;
    const ptyWs = ptySocketRef.current;
    ptySocketRef.current = null;
    if (ptyWs) {
      ptyWs.close();
    }
    if (expectsLiveTerminal) {
      clearCachedTerminalSnapshot(sessionId);
      snapshotAppliedRef.current = null;
      snapshotAnsiRef.current = "";
      snapshotTranscriptRef.current = "";
      snapshotModesRef.current = undefined;
      lastTerminalSequenceRef.current = null;
      liveOutputStartedRef.current = false;
      setSnapshotAnsi("");
      setSnapshotTranscript("");
      setSnapshotModes(undefined);
      setSnapshotReady(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldStreamLiveTerminal, sessionId, expectsLiveTerminal]);

  // WebSocket connection is now handled by useTtydConnection hook above


  // Global cleanup effect
  useEffect(() => () => {
    clearScheduledRecovery();
    clearScheduledTerminalFlush();
    clearScheduledTerminalHttpControlFlush();
    clearVisibilityRecoveryTimers();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    terminalHttpControlQueueRef.current = [];
    terminalHttpControlInFlightRef.current = false;
    ptyActiveRef.current = false;
    ptySocketRef.current?.close();
    ptySocketRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pending insert effect — only for live terminal inline text
  useEffect(() => {
    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;

    if (canSendLiveInput) {
      const inlineText = pendingInsert.inlineText.trim();
      if (inlineText.length > 0) {
        void sendTerminalKeys(`${inlineText} `).catch(() => {
          // Ignore transient errors during live input
        });
      }
    }
  }, [canSendLiveInput, pendingInsert, sendTerminalKeys]);

  const scrollToBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    preferredFocusTargetRef.current = "terminal";
    restoreFocusOnRecoveryRef.current = true;
    term.scrollToBottom();
    updateScrollState();
    if (activeRef.current) {
      try {
        term.focus();
      } catch {
        return;
      }
    }
  }, [preferredFocusTargetRef, restoreFocusOnRecoveryRef, updateScrollState]);

  const focusTerminal = useCallback(() => {
    preferredFocusTargetRef.current = "terminal";
    restoreFocusOnRecoveryRef.current = true;
    if (!expectsLiveTerminal) {
      return;
    }
    const term = termRef.current;
    if (!term) {
      return;
    }
    try {
      term.focus();
    } catch {
      return;
    }
    scheduleRendererRecovery(false);
  }, [expectsLiveTerminal, preferredFocusTargetRef, restoreFocusOnRecoveryRef, scheduleRendererRecovery]);

  const handleTerminalPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      return;
    }
    focusTerminal();
  }, [focusTerminal]);

  const handleTerminalWheel = useCallback((event: WheelEvent) => {
    const term = termRef.current;
    if (!term || event.ctrlKey || event.metaKey || event.defaultPrevented) {
      return;
    }

    if (term.buffer.active.baseY <= 0) {
      return;
    }

    let deltaLines = event.deltaY;
    if (event.deltaMode === 0) {
      deltaLines = event.deltaY / 18;
    } else if (event.deltaMode === 2) {
      deltaLines = event.deltaY * Math.max(1, term.rows - 1);
    }

    const roundedDelta = deltaLines > 0 ? Math.ceil(deltaLines) : Math.floor(deltaLines);
    if (roundedDelta === 0) {
      return;
    }

    term.scrollLines(roundedDelta);
    updateScrollState();
    event.preventDefault();
  }, [updateScrollState]);

  // Touch/wheel scroll effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const wheelListener = (event: WheelEvent) => {
      handleTerminalWheel(event);
    };

    let touchLastY: number | null = null;
    let touchScrolled = false;
    let touchAccumY = 0;
    let touchVelocity = 0;
    let touchLastTime = 0;
    let momentumFrame: number | null = null;

    const LINE_HEIGHT_PX = 16;
    const MOMENTUM_DECAY = 0.92;
    const MOMENTUM_MIN_VELOCITY = 0.3;
    const VELOCITY_WEIGHT = 0.6;

    const cancelMomentum = () => {
      if (momentumFrame !== null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
      }
    };

    const stepMomentum = () => {
      const term = termRef.current;
      if (!term || Math.abs(touchVelocity) < MOMENTUM_MIN_VELOCITY) {
        momentumFrame = null;
        updateScrollState();
        return;
      }
      touchAccumY += touchVelocity;
      const lines = Math.trunc(touchAccumY / LINE_HEIGHT_PX);
      if (lines !== 0) {
        touchAccumY -= lines * LINE_HEIGHT_PX;
        term.scrollLines(lines);
      }
      touchVelocity *= MOMENTUM_DECAY;
      momentumFrame = requestAnimationFrame(stepMomentum);
    };

    const onTouchStart = (event: TouchEvent) => {
      cancelMomentum();
      if (event.touches.length === 1) {
        touchLastY = event.touches[0]!.clientY;
        touchLastTime = event.timeStamp;
        touchScrolled = false;
        touchAccumY = 0;
        touchVelocity = 0;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      const term = termRef.current;
      if (!term || touchLastY === null || event.touches.length !== 1) {
        return;
      }
      const currentY = event.touches[0]!.clientY;
      const deltaY = touchLastY - currentY;
      const now = event.timeStamp;
      const dt = now - touchLastTime;

      if (term.buffer.active.baseY > 0) {
        touchScrolled = true;
        touchAccumY += deltaY;

        const lines = Math.trunc(touchAccumY / LINE_HEIGHT_PX);
        if (lines !== 0) {
          touchAccumY -= lines * LINE_HEIGHT_PX;
          term.scrollLines(lines);
        }

        if (dt > 0) {
          const instantVelocity = (deltaY / dt) * 16;
          touchVelocity = touchVelocity === 0
            ? instantVelocity
            : VELOCITY_WEIGHT * instantVelocity + (1 - VELOCITY_WEIGHT) * touchVelocity;
        }

        event.preventDefault();
      }
      touchLastY = currentY;
      touchLastTime = now;
    };

    const onTouchEnd = () => {
      if (!touchScrolled && touchLastY !== null) {
        focusTerminal();
      } else if (touchScrolled && Math.abs(touchVelocity) >= MOMENTUM_MIN_VELOCITY) {
        momentumFrame = requestAnimationFrame(stepMomentum);
      }
      touchLastY = null;
      touchScrolled = false;
      updateScrollState();
    };

    container.addEventListener("wheel", wheelListener, { passive: false });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      cancelMomentum();
      container.removeEventListener("wheel", wheelListener);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [handleTerminalWheel, focusTerminal, updateScrollState]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    restorePreferredFocus();
  }, [restorePreferredFocus]);

  // --- Render ---
  return (
    <div
      ref={surfaceRef}
      style={terminalSurfaceStyle}
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-white/10 bg-[#060404] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      {searchOpen ? (
        <div className={immersiveMobileMode
          ? "absolute right-3 top-14 z-10 flex max-w-[calc(100%-1.5rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur"
          : "absolute right-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur sm:right-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)]"}
        >
          <Search className="h-3.5 w-3.5 text-[#8e847d]" />
          <input
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
        <div className={`${immersiveMobileMode ? "absolute right-3 top-14" : "absolute right-2 top-2 sm:right-3 sm:top-3"} z-10 flex items-center gap-1.5 transition-opacity sm:gap-2 ${
          connectionState === "live"
            ? "opacity-0 group-hover/terminal:opacity-100 focus-within:opacity-100"
            : "opacity-100"
        }`}>
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
              disabled
              aria-label="Reconnect (auto-managed by WebSocket)"
            >
              {connectionState === "connecting"
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : transportError
                  ? <AlertCircle className="h-3.5 w-3.5" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="pointer-events-auto h-10 w-10 sm:h-7 sm:w-7 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818]"
            onClick={() => setSearchOpen(true)}
            aria-label="Search terminal"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className={immersiveMobileMode ? "min-h-0 flex-1 overflow-hidden px-0 pb-0 pt-0" : "min-h-0 flex-1 overflow-hidden px-0.5 pb-0.5 pt-2 sm:px-1.5 sm:pb-1 sm:pt-3"}>
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden touch-pan-y"
          onClick={focusTerminal}
          onPointerDown={handleTerminalPointerDown}
        />
      </div>

      {showScrollToBottom ? (
        <div
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ bottom: `${floatingOverlayBottomPx}px` }}
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
    </div>
  );
}

export default SessionTerminal;
