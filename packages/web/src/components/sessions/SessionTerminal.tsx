"use client";

import React, { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, RefreshCw, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getTerminalTheme } from "@/components/terminal/xtermTheme";
import { captureTerminalViewport } from "./terminalViewport";
import {
  calculateMobileTerminalViewportMetrics,
  getSessionTerminalViewportOptions,
} from "./sessionTerminalUtils";
import type { TerminalInsertRequest } from "./terminalInsert";

// --- Extracted modules ---
import {
  LIVE_TERMINAL_STATUSES,
  LIVE_TERMINAL_SCROLLBACK,
  RESUMABLE_STATUSES,
} from "./terminal/terminalConstants";
import {
  readCachedTerminalUiState,
  storeCachedTerminalUiState,
  clearCachedTerminalConnection,
} from "./terminal/terminalCache";
import {
  fetchTerminalConnection,
} from "./terminal/terminalApi";
import {
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
import { useTerminalResize } from "./terminal/useTerminalResize";
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
  const lastAppliedInsertNonceRef = useRef<number>(0);
  const expectsLiveTerminalRef = useRef(false);

  const initialUiState = readCachedTerminalUiState(sessionId);

  const [terminalReady, setTerminalReady] = useState(false);
  const [ptyWsUrl, setPtyWsUrl] = useState<string | null>(null);
  const [interactiveTerminal, setInteractiveTerminal] = useState(true);
  const [searchOpen, setSearchOpen] = useState(() => initialUiState?.searchOpen ?? false);
  const [searchQuery, setSearchQuery] = useState(() => initialUiState?.searchQuery ?? "");
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const [sessionStatusOverride, setSessionStatusOverride] = useState<string | null>(null);
  const [mobileViewportHeight, setMobileViewportHeight] = useState<number | null>(null);
  const [promptMessage, setPromptMessage] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);

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
  const shouldAttachTerminalSurface = active;
  const shouldStreamLiveTerminal = expectsLiveTerminal && active && pageVisible;
  expectsLiveTerminalRef.current = expectsLiveTerminal;
  pageVisibleRef.current = pageVisible;

  // TTyD WebSocket connection (for direct PTY I/O via binary protocol)
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
    enabled: ptyWsUrl !== null && expectsLiveTerminalRef.current && pageVisibleRef.current,
  });

  const canSendLiveInput = expectsLiveTerminal && interactiveTerminal && ttydConnected;

  // Resize is handled directly over the TTyD WebSocket
  const handleSendResize = useCallback(
    async (cols: number, rows: number): Promise<boolean> => {
      if (ttydConnected) {
        ttydSendResize(cols, rows);
        return true;
      }
      return false;
    },
    [ttydConnected, ttydSendResize],
  );

  // No-op error setter for useTerminalResize (errors are handled by ttyd hook)
  const noop = useCallback(() => {}, []);

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
    handleSendResize,
    noop,
    initialUiState?.viewport ?? null,
  );

  const { searchRef, runSearch } = useTerminalSearch({
    searchOpen,
    searchQuery,
    termRef,
  });

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
  const updateScrollStateRef = useRef(updateScrollState);
  const scheduleRendererRecoveryRef = useRef<(forceResize: boolean) => void>(scheduleRendererRecovery);

  useEffect(() => { updateScrollStateRef.current = updateScrollState; }, [updateScrollState]);
  useEffect(() => { scheduleRendererRecoveryRef.current = scheduleRendererRecovery; }, [scheduleRendererRecovery]);

  // --- Callbacks ---
  const persistCachedUiState = useEffectEvent(() => {
    const term = termRef.current;
    const viewport = term && terminalHasRenderedContent(term)
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
    if (!immersiveMobileMode || typeof window === "undefined" || !window.visualViewport) {
      const fallbackSyncMobileViewport = () => {
        const surface = surfaceRef.current;
        if (!surface) {
          return;
        }
        const metrics = calculateMobileTerminalViewportMetrics(
          window.innerHeight,
          window.innerHeight,
          0,
          surface.getBoundingClientRect().top,
        );
        setMobileViewportHeight((current) => (current === metrics.usableHeight ? current : metrics.usableHeight));
      };

      fallbackSyncMobileViewport();
      window.addEventListener("resize", fallbackSyncMobileViewport);
      window.addEventListener("orientationchange", fallbackSyncMobileViewport);
      return () => {
        window.removeEventListener("resize", fallbackSyncMobileViewport);
        window.removeEventListener("orientationchange", fallbackSyncMobileViewport);
      };
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
    window.addEventListener("orientationchange", syncMobileViewport);

    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      visualViewport.removeEventListener("resize", syncMobileViewport);
      visualViewport.removeEventListener("scroll", syncMobileViewport);
      window.removeEventListener("resize", syncMobileViewport);
      window.removeEventListener("orientationchange", syncMobileViewport);
    };
  }, [immersiveMobileMode, scheduleRendererRecovery]);

  // Reset state when sessionId changes
  useEffect(() => {
    const cachedUiState = readCachedTerminalUiState(sessionId);
    lastAppliedInsertNonceRef.current = 0;
    lastSyncedTerminalSizeRef.current = null;
    pendingResizeSyncRef.current = true;
    preferredFocusTargetRef.current = "none";
    restoreFocusOnRecoveryRef.current = false;
    clearScheduledRecovery();
    lastObservedContainerSizeRef.current = null;
    lastViewportOptionKeyRef.current = null;
    pendingViewportRestoreRef.current = cachedUiState?.viewport ?? null;
    setInteractiveTerminal(true);
    setSearchOpen(cachedUiState?.searchOpen ?? false);
    setSearchQuery(cachedUiState?.searchQuery ?? "");
    _setShowScrollToBottom(false);
    setSessionStatusOverride(null);
    setMobileViewportHeight(null);
    setPtyWsUrl(null);
    termRef.current?.reset();
    updateScrollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    setSessionStatusOverride(null);
  }, [sessionState]);

  // Connection resolution effect — fetches ptyWsUrl for TTyD WebSocket
  useEffect(() => {
    let mounted = true;

    if (!expectsLiveTerminal || !shouldStreamLiveTerminal) {
      return () => { mounted = false; };
    }

    // Bust stale cached connection info so we always get a fresh ptyWsUrl/token
    clearCachedTerminalConnection(sessionId);

    void (async () => {
      try {
        const connection = await fetchTerminalConnection(sessionId);
        if (!mounted) return;
        setPtyWsUrl(connection.ptyWsUrl);
        setInteractiveTerminal(connection.interactive);
      } catch (err) {
        if (!mounted) return;
        console.error("Failed to resolve terminal connection:", err);
      }
    })();

    return () => { mounted = false; };
  }, [expectsLiveTerminal, sessionId, shouldStreamLiveTerminal]);

  // --- Event handlers (useEffectEvent) ---
  const handleTerminalData = useEffectEvent((data: string) => {
    if (ttydConnected) {
      ttydSendInput(data);
    }
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
        allowProposedApi: true,
        allowTransparency: false,
        // convertEol intentionally omitted — the PTY's ONLCR flag already
        // converts \n→\r\n. Enabling it here would double-convert.
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
      term.options.disableStdin = !expectsLiveTerminalRef.current;
      setTerminalReady(true);
      updateScrollStateRef.current();

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
      scheduleRendererRecoveryRef.current(true);
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
      lastSyncedTerminalSizeRef.current = null;
      lastObservedContainerSizeRef.current = null;
      lastViewportOptionKeyRef.current = null;
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

  useEffect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) {
      return;
    }

    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled || !activeRef.current) {
        return;
      }

      lastObservedContainerSizeRef.current = null;
      lastViewportOptionKeyRef.current = null;
      pendingResizeSyncRef.current = true;
      scheduleRendererRecovery(true);
    });

    return () => {
      cancelled = true;
    };
  }, [
    immersiveMobileMode,
    lastObservedContainerSizeRef,
    lastViewportOptionKeyRef,
    pendingResizeSyncRef,
    scheduleRendererRecovery,
    sessionId,
  ]);

  useEffect(() => {
    const termElement = termRef.current?.element;
    if (!termElement) {
      return;
    }

    termElement.classList.add("session-terminal-xterm");
    termElement.classList.toggle("session-terminal-xterm-mobile", immersiveMobileMode);
    lastObservedContainerSizeRef.current = null;
    lastViewportOptionKeyRef.current = null;
    pendingResizeSyncRef.current = true;
    scheduleRendererRecovery(true);
  }, [
    immersiveMobileMode,
    lastObservedContainerSizeRef,
    lastViewportOptionKeyRef,
    pendingResizeSyncRef,
    scheduleRendererRecovery,
    terminalReady,
  ]);

  // Active pane recovery — fires ONLY on tab activation.
  // A single recovery re-fits the terminal after potential WebGL context loss,
  // plus one delayed retry to handle late-settling layouts.
  useEffect(() => {
    if (!active) {
      return;
    }

    // Reset cached viewport metrics when mobile immersive chrome toggles so
    // xterm recalculates cols/rows instead of keeping the previous fit result.
    lastObservedContainerSizeRef.current = null;
    lastViewportOptionKeyRef.current = null;
    pendingResizeSyncRef.current = true;

    scheduleRendererRecovery(true);
    const retryTimer = window.setTimeout(() => {
      scheduleRendererRecovery(true);
    }, 150);

    return () => {
      window.clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, immersiveMobileMode, scheduleRendererRecovery]);

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
        connectionState: ttydConnected ? "live" : ttydConnecting ? "connecting" : ttydError ? "error" : "closed",
        interactiveTerminal,
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
    ttydConnected,
    ttydConnecting,
    ttydError,
    expectsLiveTerminal,
    interactiveTerminal,
    pageVisible,
    ptyWsUrl,
    sessionId,
    shouldAttachTerminalSurface,
    shouldStreamLiveTerminal,
    terminalReady,
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
    // shouldStreamLiveTerminal intentionally excluded — these event handlers must be stable
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

  // Global cleanup effect
  useEffect(() => () => {
    clearScheduledRecovery();
    clearVisibilityRecoveryTimers();
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
        ttydSendInput(`${inlineText} `);
      }
    }
  }, [canSendLiveInput, pendingInsert, ttydSendInput]);

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

  // --- Prompt send bar ---
  const showPromptBar = !immersiveMobileMode && RESUMABLE_STATUSES.has(normalizedSessionStatus);
  const scrollToBottomOffsetPx = showPromptBar ? 60 : floatingOverlayBottomPx;

  const handlePromptSend = useCallback(async () => {
    const message = promptMessage.trim();
    if (message.length === 0 || promptSending) return;
    setPromptSending(true);
    setPromptError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", message }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Failed to send message (${res.status})`);
      }
      setPromptMessage("");
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setPromptSending(false);
    }
  }, [promptMessage, promptSending, sessionId]);

  const handlePromptSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    void handlePromptSend();
  }, [handlePromptSend]);

  // --- Render ---
  return (
    <div
      ref={surfaceRef}
      style={terminalSurfaceStyle}
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      {searchOpen ? (
          <div className="absolute right-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur sm:right-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)]">
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
          <div className={`absolute right-2 top-2 z-10 flex items-center gap-1.5 transition-opacity sm:right-3 sm:top-3 sm:gap-2 ${
            ttydConnected
              ? "opacity-0 group-hover/terminal:opacity-100 focus-within:opacity-100"
              : "opacity-100"
          }`}>
            {!ttydConnected ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={`pointer-events-auto h-10 w-10 sm:h-7 sm:w-7 rounded-full border backdrop-blur-sm ${
                  ttydError
                    ? "border-[#ff8f7a]/25 bg-[#2a1616]/92 text-[#ff8f7a] hover:bg-[#351b1b]"
                    : "border-white/10 bg-[#141010]/92 text-[#c9c0b7] hover:bg-[#201818]"
                }`}
                disabled
                aria-label="Connecting... (auto-managed by TTyD)"
              >
                {ttydConnecting
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : ttydError
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

      <div className={immersiveMobileMode ? "min-h-0 min-w-0 flex-1 overflow-hidden px-2 pb-0 pt-0 w-full" : "min-h-0 min-w-0 flex-1 overflow-hidden px-1.5 pb-0 pt-0.5 lg:px-1.5 lg:pb-1 lg:pt-3 w-full"}>
        <div
          ref={containerRef}
          className="h-full w-full min-w-0 max-w-full overflow-hidden touch-pan-y"
          onClick={focusTerminal}
          onPointerDown={handleTerminalPointerDown}
        />
      </div>

      {showScrollToBottom ? (
        <div
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ bottom: `calc(${scrollToBottomOffsetPx}px + env(safe-area-inset-bottom))` }}
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

      {showPromptBar ? (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/12 bg-[#161212] backdrop-blur-sm [padding-bottom:env(safe-area-inset-bottom)]">
          {promptError ? (
            <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] text-[#ff8f7a]">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{promptError}</span>
              <button type="button" className="ml-auto shrink-0 text-[#8e847d] hover:text-[#c9c0b7]" onClick={() => setPromptError(null)}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          <form onSubmit={handlePromptSubmit} className="flex items-center gap-2 px-2 py-2 lg:px-3">
            <input
              ref={promptInputRef}
              value={promptMessage}
              onChange={(event) => setPromptMessage(event.target.value)}
              placeholder="Send a follow-up message…"
              disabled={promptSending}
              className="h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-[#0c0808] px-2.5 text-[12px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] focus:border-white/20 disabled:opacity-50"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={promptSending || promptMessage.trim().length === 0}
              className="h-8 w-8 shrink-0 rounded-md border border-white/10 bg-[#0c0808] text-[#c9c0b7] hover:bg-[#201818] disabled:opacity-30"
              aria-label="Send message"
            >
              {promptSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export default SessionTerminal;
