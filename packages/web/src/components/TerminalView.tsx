"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import type { ITerminalOptions, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SUPERSET_TERMINAL_FONT_FAMILY, getSupersetLikeTerminalTheme } from "@/components/terminal/xtermTheme";

interface TerminalViewProps {
  sessionId: string;
}

type TerminalConnectionInfo = {
  wsUrl: string;
};

type TerminalSnapshot = {
  snapshot: string;
  source: string;
  live: boolean;
  restored: boolean;
};

const READ_ONLY_SCROLLBACK = 200000;
const TERMINAL_SNAPSHOT_LINES = 200000;
const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 1600;
const MANAGED_SCROLL_PRIVATE_MODES = new Set([1000, 1002, 1003, 1005, 1006, 1015, 1047, 1048, 1049]);

async function fetchTerminalConnection(sessionId: string): Promise<TerminalConnectionInfo> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/connection`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as { wsUrl?: string; error?: string } | null;
  if (!response.ok || typeof data?.wsUrl !== "string" || data.wsUrl.trim().length === 0) {
    throw new Error(data?.error ?? `Failed to resolve terminal connection: ${response.status}`);
  }
  return { wsUrl: data.wsUrl.trim() };
}

async function fetchTerminalSnapshot(sessionId: string): Promise<TerminalSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?lines=${TERMINAL_SNAPSHOT_LINES}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { snapshot?: string; source?: string; live?: boolean; restored?: boolean; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal snapshot: ${response.status}`);
  }
  return {
    snapshot: typeof data?.snapshot === "string" ? data.snapshot : "",
    source: typeof data?.source === "string" ? data.source : "empty",
    live: data?.live === true,
    restored: data?.restored === true,
  };
}

function buildTerminalSocketUrl(baseUrl: string, cols: number, rows: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("cols", String(Math.max(1, cols)));
  url.searchParams.set("rows", String(Math.max(1, rows)));
  return url.toString();
}

function normalizeTerminalSnapshot(snapshot: string): string {
  return snapshot.replace(/\r?\n/g, "\r\n");
}

function getTerminalViewportOptions(width: number): Pick<ITerminalOptions, "fontFamily" | "fontSize" | "lineHeight"> {
  if (width < 420) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 10,
      lineHeight: 1,
    };
  }

  if (width < 640) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.08,
    };
  }

  return {
    fontFamily: SUPERSET_TERMINAL_FONT_FAMILY,
    fontSize: 16,
    lineHeight: 1.1,
  };
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const searchRef = useRef<XSearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectAttemptRef = useRef(0);
  const hasConnectedOnceRef = useRef(false);
  const reconnectNoticeWrittenRef = useRef(false);
  const snapshotAppliedRef = useRef<string | null>(null);

  const [terminalReady, setTerminalReady] = useState(false);
  const [socketBaseUrl, setSocketBaseUrl] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [snapshotAnsi, setSnapshotAnsi] = useState("");

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectCountRef.current += 1;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * reconnectCountRef.current,
    );
    reconnectTimerRef.current = window.setTimeout(() => {
      setReconnectToken((value) => value + 1);
    }, delay);
  }, [clearReconnectTimer]);

  const requestReconnect = useCallback(() => {
    clearReconnectTimer();
    setTransportError(null);
    setConnectionState("connecting");
    setSocketBaseUrl(null);
    setReconnectToken((value) => value + 1);
  }, [clearReconnectTimer]);

  const updateScrollState = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      setShowScrollToBottom(false);
      return;
    }
    const buffer = term.buffer.active;
    setShowScrollToBottom(buffer.viewportY < buffer.baseY);
  }, []);

  const runSearch = useCallback((direction: "next" | "prev") => {
    const addon = searchRef.current;
    if (!addon || searchQuery.trim().length === 0) {
      return;
    }
    if (direction === "next") {
      addon.findNext(searchQuery, { incremental: true, caseSensitive: false });
    } else {
      addon.findPrevious(searchQuery, { incremental: true, caseSensitive: false });
    }
  }, [searchQuery]);

  const scrollToBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.scrollToBottom();
    updateScrollState();
    term.focus();
  }, [updateScrollState]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    hasConnectedOnceRef.current = false;
    reconnectNoticeWrittenRef.current = false;
    snapshotAppliedRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    let mounted = true;
    setSnapshotReady(false);
    setSnapshotAnsi("");

    void (async () => {
      try {
        const snapshot = await fetchTerminalSnapshot(sessionId);
        if (!mounted) return;
        setSnapshotAnsi(snapshot.snapshot);
      } catch {
        if (!mounted) return;
        setSnapshotAnsi("");
      } finally {
        if (mounted) {
          setSnapshotReady(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [sessionId]);

  useEffect(() => {
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let scrollDisposable: { dispose: () => void } | null = null;
    let mounted = true;

    async function init() {
      if (!containerRef.current || !mounted) return;

      const [xtermMod, fitMod, searchMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
      ]);

      if (!mounted || !containerRef.current) return;

      const isLight = document.documentElement.classList.contains("light");
      const viewportOptions = getTerminalViewportOptions(window.innerWidth);
      const terminalOptions: ITerminalOptions & { scrollbar?: { showScrollbar: boolean } } = {
        cursorBlink: false,
        cursorStyle: "underline",
        disableStdin: true,
        scrollback: READ_ONLY_SCROLLBACK,
        fontSize: viewportOptions.fontSize,
        drawBoldTextInBrightColors: true,
        fontFamily: viewportOptions.fontFamily,
        lineHeight: viewportOptions.lineHeight,
        convertEol: true,
        theme: getSupersetLikeTerminalTheme(isLight),
        scrollbar: {
          showScrollbar: false,
        },
      };
      term = new xtermMod.Terminal(terminalOptions);
      const registerManagedScrollMode = (final: "h" | "l") => {
        term?.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
          const hasManagedMode = params.some((param) => (
            Array.isArray(param)
              ? param.some((value) => MANAGED_SCROLL_PRIVATE_MODES.has(value))
              : MANAGED_SCROLL_PRIVATE_MODES.has(param)
          ));
          if (!hasManagedMode) {
            return false;
          }
          return true;
        });
      };
      const handleManagedWheel = (event: WheelEvent): boolean => {
        const normalizedDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY
          : event.deltaY / 14;
        const scrollLines = normalizedDelta === 0
          ? 0
          : normalizedDelta > 0
            ? Math.max(1, Math.round(normalizedDelta))
            : Math.min(-1, Math.round(normalizedDelta));
        if (scrollLines === 0) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        term?.scrollLines(scrollLines);
        updateScrollState();
        return false;
      };
      registerManagedScrollMode("h");
      registerManagedScrollMode("l");
      term.attachCustomWheelEventHandler(handleManagedWheel);

      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      const searchAddon = new searchMod.SearchAddon();
      term.loadAddon(searchAddon);
      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = searchAddon;
      setTerminalReady(true);
      updateScrollState();
      scrollDisposable = term.onScroll(() => {
        updateScrollState();
      });

      resizeObserver = new ResizeObserver(() => {
        if (!fit || !mounted || !term) return;
        try {
          const nextViewportOptions = getTerminalViewportOptions(window.innerWidth);
          term.options.fontFamily = nextViewportOptions.fontFamily;
          term.options.fontSize = nextViewportOptions.fontSize;
          term.options.lineHeight = nextViewportOptions.lineHeight;
          fit.fit();
        } catch {
          // Container may be hidden while switching tabs.
        }
      });

      resizeObserver.observe(containerRef.current);
    }

    void init();

    return () => {
      mounted = false;
      scrollDisposable?.dispose();
      if (resizeObserver) resizeObserver.disconnect();
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      setTerminalReady(false);
    };
  }, [sessionId, updateScrollState]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        setSocketBaseUrl(null);
        const connection = await fetchTerminalConnection(sessionId);
        if (!mounted) return;
        setSocketBaseUrl(connection.wsUrl);
        setTransportError(null);
        setConnectionState("connecting");
      } catch (err) {
        if (!mounted) return;
        setTransportError(err instanceof Error ? err.message : "Failed to resolve terminal connection");
        setConnectionState("error");
      }
    })();

    return () => {
      mounted = false;
    };
  }, [reconnectToken, sessionId]);

  useEffect(() => {
    if (!terminalReady || !snapshotReady) {
      return;
    }

    const term = termRef.current;
    if (!term || snapshotAppliedRef.current === sessionId) {
      return;
    }

    snapshotAppliedRef.current = sessionId;
    term.reset();
    if (snapshotAnsi.length > 0) {
      term.write(normalizeTerminalSnapshot(snapshotAnsi), () => {
        updateScrollState();
        term.focus();
      });
      return;
    }

    updateScrollState();
  }, [sessionId, snapshotAnsi, snapshotReady, terminalReady, updateScrollState]);

  useEffect(() => {
    if (!terminalReady || !snapshotReady || !socketBaseUrl || !termRef.current) return;

    const term = termRef.current;
    const socketUrl = buildTerminalSocketUrl(socketBaseUrl, term.cols, term.rows);
    const attemptId = connectAttemptRef.current + 1;
    connectAttemptRef.current = attemptId;
    clearReconnectTimer();
    setConnectionState("connecting");

    const socket = new WebSocket(socketUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      if (connectAttemptRef.current !== attemptId) return;
      reconnectCountRef.current = 0;
      setTransportError(null);
      setConnectionState("live");
      const wasReconnect = hasConnectedOnceRef.current;
      hasConnectedOnceRef.current = true;
      reconnectNoticeWrittenRef.current = false;
      if (wasReconnect) {
        term.writeln("\r\n\x1b[90m[Reconnected]\x1b[0m");
      }
      try {
        fitRef.current?.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // Best-effort renderer recovery.
      }
      updateScrollState();
    };

    socket.onmessage = (event) => {
      if (connectAttemptRef.current !== attemptId) return;

      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data) as { type?: string; error?: string };
          if (payload.type === "error") {
            setTransportError(payload.error || "Terminal connection failed");
            setConnectionState("error");
          } else if (payload.type === "exit") {
            setConnectionState("closed");
          }
        } catch {
          setTransportError("Received an invalid terminal event");
          setConnectionState("error");
        }
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const shouldFollow = term.buffer.active.viewportY >= term.buffer.active.baseY;
        term.write(new Uint8Array(event.data), () => {
          if (shouldFollow) {
            term.scrollToBottom();
          }
          updateScrollState();
        });
      }
    };

    socket.onclose = () => {
      if (connectAttemptRef.current !== attemptId) return;
      socketRef.current = null;
      if (termRef.current && hasConnectedOnceRef.current && !reconnectNoticeWrittenRef.current) {
        reconnectNoticeWrittenRef.current = true;
        termRef.current.writeln("\r\n\x1b[90m[Connection lost. Reconnecting...]\x1b[0m");
      }
      setConnectionState("connecting");
      setSocketBaseUrl(null);
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (connectAttemptRef.current !== attemptId) return;
      setTransportError("Terminal connection failed");
      setConnectionState("error");
    };

    return () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, [clearReconnectTimer, scheduleReconnect, snapshotReady, socketBaseUrl, terminalReady, updateScrollState]);

  useEffect(() => () => {
    clearReconnectTimer();
    socketRef.current?.close();
  }, [clearReconnectTimer]);

  return (
    <div className="group/terminal relative flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-white/10 bg-[#060404] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
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
            className="h-6 w-20 min-w-0 bg-transparent px-2 text-[11px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] sm:w-28 sm:text-[12px]"
          />
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={() => runSearch("prev")} aria-label="Find previous">
            <span className="text-[11px]">↑</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={() => runSearch("next")} aria-label="Find next">
            <span className="text-[11px]">↓</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={closeSearch} aria-label="Close search">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className={`absolute right-2 top-2 z-10 flex items-center gap-1.5 transition-opacity sm:right-3 sm:top-3 sm:gap-2 ${
          connectionState === "live" ? "opacity-0 group-hover/terminal:opacity-100 focus-within:opacity-100" : "opacity-100"
        }`}>
          {connectionState !== "live" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={`pointer-events-auto h-7 w-7 rounded-full border backdrop-blur-sm sm:h-8 sm:w-8 ${
                transportError
                  ? "border-[#ff8f7a]/25 bg-[#2a1616]/92 text-[#ff8f7a] hover:bg-[#351b1b]"
                  : "border-white/10 bg-[#141010]/92 text-[#c9c0b7] hover:bg-[#201818]"
              }`}
              onClick={requestReconnect}
              aria-label="Reconnect terminal"
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
            className="pointer-events-auto h-7 w-7 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-8 sm:w-8"
            onClick={() => setSearchOpen(true)}
            aria-label="Search terminal"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-0.5 pb-1 pt-2 sm:px-1.5 sm:pb-1.5 sm:pt-3" />

      {showScrollToBottom ? (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
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
