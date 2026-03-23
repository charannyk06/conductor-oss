"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { Button } from "@/components/ui/Button";
import { useBridgeTunnel } from "@/hooks/useBridgeTunnel";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";
import { attachMobileTouchScrollShim } from "@/components/sessions/terminal/mobileTouchScroll";
import {
  isTerminalScrollHostAtBottom,
  resolveSessionTerminalViewportOptions,
} from "@/components/sessions/sessionTerminalUtils";

export interface BridgeSessionTerminalProps extends SessionTerminalProps {
  scope?: string;
  readOnly?: boolean;
}

function extractOutputText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }
  if (response && typeof response === "object") {
    const payload = response as { output?: unknown };
    if (typeof payload.output === "string") {
      return payload.output;
    }
  }
  return "";
}

function resetTerminalOutput(terminal: Terminal, value: string, scrollToBottom = true) {
  terminal.reset();
  if (value.length > 0) {
    terminal.write(value);
  }
  if (scrollToBottom) {
    terminal.scrollToBottom();
  }
}

const TERMINAL_THEME = {
  background: "#060404",
  foreground: "#efe8e1",
  cursor: "#f4b37c",
  cursorAccent: "#060404",
  selectionBackground: "rgba(244, 179, 124, 0.24)",
  black: "#060404",
  red: "#ff8f7a",
  green: "#18c58f",
  yellow: "#f0b35d",
  blue: "#8ea6ff",
  magenta: "#d19be8",
  cyan: "#75d6d0",
  white: "#efe8e1",
  brightBlack: "#7d746e",
  brightRed: "#ffb39e",
  brightGreen: "#5be0b0",
  brightYellow: "#ffd089",
  brightBlue: "#b6c7ff",
  brightMagenta: "#e4c0f1",
  brightCyan: "#9fe8e2",
  brightWhite: "#fff8f2",
} as const;

export function BridgeSessionTerminal({
  sessionId,
  sessionState,
  pendingInsert,
  immersiveMobileMode = false,
  scope = "conductor-bridge-control",
  readOnly = false,
}: BridgeSessionTerminalProps) {
  const {
    connected,
    bridgeStatus,
    error,
    terminalChunk,
    terminalSequence,
    requestApi,
    sendTerminalInput,
    sendTerminalResize,
  } = useBridgeTunnel(scope);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const bridgeInputRef = useRef({ connected, readOnly, sendTerminalInput });
  const lastAppliedInsertNonceRef = useRef(0);
  const scheduledLayoutSyncTimersRef = useRef<number[]>([]);
  const followBottomRef = useRef(true);
  const [hasOutput, setHasOutput] = useState(false);
  const [loadingOutput, setLoadingOutput] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const sessionLabel = sessionState.trim().replace(/[_-]+/g, " ");

  const clearScheduledLayoutSyncs = () => {
    for (const timer of scheduledLayoutSyncTimersRef.current) {
      window.clearTimeout(timer);
    }
    scheduledLayoutSyncTimersRef.current = [];
  };

  const applyTerminalViewport = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const viewport = resolveSessionTerminalViewportOptions(
      terminalHostRef.current?.clientWidth
      ?? (typeof window === "undefined" ? undefined : window.innerWidth),
    );
    terminal.options.fontFamily = viewport.fontFamily;
    terminal.options.fontSize = viewport.fontSize;
    terminal.options.lineHeight = viewport.lineHeight;
  };

  const fitTerminal = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return null;
    }

    applyTerminalViewport();
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    fitAddon.fit();
    if (followBottomRef.current) {
      terminal.scrollToBottom();
    }

    const next = { cols: terminal.cols, rows: terminal.rows };
    if (next.cols < 2 || next.rows < 2) {
      return null;
    }

    return {
      ...next,
      changed: next.cols !== previousCols || next.rows !== previousRows,
    };
  };

  const syncTerminalGeometry = (force: boolean = false) => {
    const next = fitTerminal();
    if (next && connected && (force || next.changed)) {
      sendTerminalResize(next.cols, next.rows);
    }
  };

  const scheduleGeometryRefreshes = () => {
    clearScheduledLayoutSyncs();
    if (typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      syncTerminalGeometry(true);
    });
    scheduledLayoutSyncTimersRef.current.push(
      window.setTimeout(() => {
        syncTerminalGeometry(true);
      }, 120),
      window.setTimeout(() => {
        syncTerminalGeometry(true);
      }, 360),
    );
  };

  useEffect(() => {
    bridgeInputRef.current = { connected, readOnly, sendTerminalInput };
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = readOnly || !connected;
      terminalRef.current.options.cursorBlink = !readOnly && connected;
    }
  }, [connected, readOnly, sendTerminalInput]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) {
      return;
    }

    host.textContent = "";
    const initialViewport = resolveSessionTerminalViewportOptions(
      typeof window === "undefined" ? undefined : window.innerWidth,
    );
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: !readOnly,
      disableStdin: readOnly || !connected,
      fontFamily: initialViewport.fontFamily,
      fontSize: initialViewport.fontSize,
      lineHeight: initialViewport.lineHeight,
      letterSpacing: 0.2,
      scrollback: 4_000,
      theme: TERMINAL_THEME,
    });

    terminal.open(host);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const scrollHost =
      host.querySelector<HTMLElement>(".xterm-viewport")
      ?? host.querySelector<HTMLElement>(".xterm-scrollable-element");
    const syncFollowBottom = () => {
      followBottomRef.current = isTerminalScrollHostAtBottom(scrollHost);
    };
    syncFollowBottom();
    scrollHost?.addEventListener("scroll", syncFollowBottom, { passive: true });
    const cleanupMobileTouchScroll = attachMobileTouchScrollShim(terminal, host);
    const dataSubscription = terminal.onData((data) => {
      const bridgeInput = bridgeInputRef.current;
      if (bridgeInput.readOnly || !bridgeInput.connected) {
        return;
      }
      bridgeInput.sendTerminalInput(data);
    });

    const focusTerminal = () => {
      terminal.focus();
    };

    host.addEventListener("click", focusTerminal);
    terminal.focus();
    window.requestAnimationFrame(() => {
      syncTerminalGeometry(true);
    });

    return () => {
      host.removeEventListener("click", focusTerminal);
      scrollHost?.removeEventListener("scroll", syncFollowBottom);
      dataSubscription.dispose();
      cleanupMobileTouchScroll?.();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    lastAppliedInsertNonceRef.current = 0;
    followBottomRef.current = true;
    setHasOutput(false);
    setLoadingOutput(true);
    setRequestError(null);
    if (terminalRef.current) {
      resetTerminalOutput(terminalRef.current, "", true);
    }
    clearScheduledLayoutSyncs();
  }, [sessionId]);

  useEffect(() => {
    const host = terminalHostRef.current;
    const terminal = terminalRef.current;
    if (!host || !terminal) {
      return;
    }

    const applyGeometry = () => {
      syncTerminalGeometry();
    };

    const refreshTerminalLayout = () => {
      syncTerminalGeometry(true);
    };

    applyGeometry();

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        applyGeometry();
      });
    const visualViewport = typeof window === "undefined" ? null : window.visualViewport;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshTerminalLayout();
      }
    };
    const fontSet = typeof document === "undefined" ? null : document.fonts;
    let fontReadyCancelled = false;

    observer?.observe(host);
    window.addEventListener("resize", applyGeometry);
    visualViewport?.addEventListener("resize", applyGeometry);
    visualViewport?.addEventListener("scroll", applyGeometry);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    fontSet?.addEventListener?.("loadingdone", refreshTerminalLayout as EventListener);
    void fontSet?.ready.then(() => {
      if (!fontReadyCancelled) {
        refreshTerminalLayout();
      }
    }).catch(() => {});
    return () => {
      fontReadyCancelled = true;
      observer?.disconnect();
      window.removeEventListener("resize", applyGeometry);
      visualViewport?.removeEventListener("resize", applyGeometry);
      visualViewport?.removeEventListener("scroll", applyGeometry);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      fontSet?.removeEventListener?.("loadingdone", refreshTerminalLayout as EventListener);
    };
  }, [connected, sendTerminalResize]);

  useEffect(() => {
    if (connected) {
      scheduleGeometryRefreshes();
      return () => {
        clearScheduledLayoutSyncs();
      };
    }

    clearScheduledLayoutSyncs();
  }, [connected]);

  useEffect(() => {
    if (!terminalChunk) {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (terminalChunk.startsWith("\u000c")) {
      const nextOutput = terminalChunk.slice(1);
      resetTerminalOutput(terminal, nextOutput, followBottomRef.current);
      setHasOutput(nextOutput.length > 0);
      return;
    }

    terminal.write(terminalChunk);
    if (followBottomRef.current) {
      terminal.scrollToBottom();
    }
    setHasOutput((current) => current || terminalChunk.length > 0);
  }, [terminalChunk, terminalSequence]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    let cancelled = false;
    setLoadingOutput(true);
    setRequestError(null);

    void requestApi("GET", `/api/sessions/${encodeURIComponent(sessionId)}/output?lines=500`)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const output = extractOutputText(response);
        if (terminalRef.current) {
          resetTerminalOutput(terminalRef.current, output, true);
        }
        setHasOutput(output.length > 0);
        setLoadingOutput(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setLoadingOutput(false);
        setRequestError(err instanceof Error ? err.message : "Failed to load bridge terminal output.");
      });

    return () => {
      cancelled = true;
    };
  }, [connected, requestApi, sessionId]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    const inlineText = pendingInsert.inlineText.trim();
    if (inlineText.length === 0) {
      return;
    }

    sendTerminalInput(`${inlineText} `);
  }, [connected, pendingInsert, sendTerminalInput]);

  const statusLine = connected
    ? bridgeStatus?.connected === false
      ? "Bridge disconnected"
      : `Bridge ${bridgeStatus?.hostname ?? "connected"}`
    : `Bridge offline${sessionLabel ? ` · ${sessionLabel}` : ""}`;

  const emptyStateDescription = error
    ?? requestError
    ?? (connected
      ? "Loading live session output from the bridge."
      : `Waiting for the bridge relay to come online${sessionLabel ? ` for ${sessionLabel}` : ""}.`);

  return (
    <div
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 sm:right-3 sm:top-3">
        <span className="inline-flex h-9 items-center rounded-full border border-white/10 bg-[#141010]/92 px-3 text-[11px] text-[#c9c0b7] backdrop-blur-sm sm:h-7">
          {statusLine}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={() => {
            setLoadingOutput(true);
            void requestApi("GET", `/api/sessions/${encodeURIComponent(sessionId)}/output?lines=500`)
              .then((response) => {
                const output = extractOutputText(response);
                if (terminalRef.current) {
                  resetTerminalOutput(terminalRef.current, output, followBottomRef.current);
                }
                setHasOutput(output.length > 0);
                setLoadingOutput(false);
                setRequestError(null);
              })
              .catch((err) => {
                setLoadingOutput(false);
                setRequestError(err instanceof Error ? err.message : "Failed to refresh bridge terminal.");
              });
          }}
          aria-label="Reload bridge terminal"
        >
          {loadingOutput ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div
        className={immersiveMobileMode
          ? "min-h-0 min-w-0 flex-1 overflow-hidden w-full"
          : "min-h-0 min-w-0 flex-1 overflow-hidden px-0.5 pb-0 pt-0.5 lg:px-1.5 lg:pb-1 lg:pt-3 w-full"}
      >
        <div className="relative flex h-full flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#060404] text-[#efe8e1]">
          <div
            ref={terminalHostRef}
            className="h-full min-h-0 flex-1 overflow-hidden overscroll-contain px-2 py-2 text-left touch-pan-y [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm]:px-1 [&_.xterm-screen]:h-full [&_.xterm-screen]:w-full [&_.xterm-viewport]:overflow-y-auto [&_.xterm-viewport]:overscroll-contain [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch] [&_.xterm-scrollable-element]:overscroll-contain [&_.xterm-scrollable-element]:[-webkit-overflow-scrolling:touch]"
          />

          {!hasOutput ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 py-12">
              <div className="max-w-lg rounded-[16px] border border-white/10 bg-[#141010]/92 p-5 text-[#efe8e1] shadow-[0_24px_48px_rgba(0,0,0,0.34)] backdrop-blur-sm">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full border border-white/10 bg-[#201818] p-2 text-[#c9c0b7]">
                    {error || requestError ? (
                      <AlertCircle className="h-4 w-4" />
                    ) : (
                      <Loader2 className={`h-4 w-4 ${loadingOutput ? "animate-spin" : ""}`} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">Connecting bridge terminal</div>
                    <div className="mt-1 text-[12px] leading-5 text-[#a79c94]">
                      {emptyStateDescription}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="border-t border-white/10 bg-[#101010] px-3 py-2 text-[11px] text-[#a79c94]">
            {readOnly
              ? "Read-only share"
              : connected
                ? "Live input is attached to this terminal."
                : "Reconnect the bridge to resume live terminal control."}
          </div>
        </div>
      </div>
    </div>
  );
}
