"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { Button } from "@/components/ui/Button";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

const TERMINAL_CLOSED_STATUSES = new Set(["archived", "killed", "terminated", "restored"]);
const CMD_OUTPUT = "0".charCodeAt(0);
const CMD_RESIZE = "1".charCodeAt(0);
const RECONNECT_MAX_DELAY_MS = 4_000;

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

function calculateTerminalGeometry(element: HTMLElement): { cols: number; rows: number } {
  const { width, height } = element.getBoundingClientRect();
  const cols = Math.max(48, Math.floor(Math.max(width - 28, 320) / 9));
  const rows = Math.max(14, Math.floor(Math.max(height - 20, 280) / 20));
  return { cols, rows };
}

function resetTerminalOutput(terminal: Terminal, value: string) {
  terminal.reset();
  if (value.length > 0) {
    terminal.write(value);
  }
}

function encodeResizeFrame(cols: number, rows: number): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ columns: cols, rows }));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = CMD_RESIZE;
  frame.set(payload, 1);
  return frame;
}

function encodeInputFrame(data: string): Uint8Array {
  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = CMD_OUTPUT;
  frame.set(payload, 1);
  return frame;
}

async function fetchClosedTerminalOutput(sessionId: string): Promise<string> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/output?lines=500`, {
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { output?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Failed to load terminal output (${response.status})`);
  }
  return typeof payload?.output === "string" ? payload.output : "";
}

async function fetchRelayTerminalUrl(sessionId: string): Promise<string> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/relay`, {
    method: "POST",
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { wsUrl?: string; error?: string } | null;
  if (!response.ok || !payload?.wsUrl) {
    throw new Error(payload?.error ?? `Failed to attach relay terminal (${response.status})`);
  }
  return payload.wsUrl;
}

export function RemoteSessionTerminal({
  sessionId,
  sessionState,
  pendingInsert,
  immersiveMobileMode = false,
}: SessionTerminalProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const geometryRef = useRef({ cols: 120, rows: 32 });
  const lastAppliedInsertNonceRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionTick, setConnectionTick] = useState(0);
  const normalizedSessionStatus = useMemo(
    () => sessionState.trim().toLowerCase(),
    [sessionState],
  );
  const sessionClosed = TERMINAL_CLOSED_STATUSES.has(normalizedSessionStatus);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore close failures during teardown.
      }
    }
  }, []);

  const sendTerminalFrame = useCallback((frame: string | Uint8Array) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Relay terminal is not connected.");
    }
    socket.send(frame);
  }, []);

  const sendHandshake = useCallback(() => {
    const { cols, rows } = geometryRef.current;
    sendTerminalFrame(JSON.stringify({ columns: cols, rows }));
  }, [sendTerminalFrame]);

  const scheduleReconnect = useCallback(() => {
    if (sessionClosed) {
      return;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** retryAttemptRef.current);
    retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, 3);
    reconnectTimerRef.current = window.setTimeout(() => {
      setConnectionTick((value) => value + 1);
    }, delay);
  }, [sessionClosed]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) {
      return;
    }

    host.textContent = "";
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: !sessionClosed,
      disableStdin: sessionClosed,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
      fontSize: immersiveMobileMode ? 12 : 13,
      lineHeight: immersiveMobileMode ? 1.34 : 1.44,
      letterSpacing: 0.2,
      scrollback: 4_000,
      theme: TERMINAL_THEME,
    });

    terminal.open(host);
    terminalRef.current = terminal;
    const dataSubscription = terminal.onData((data) => {
      if (sessionClosed) {
        return;
      }
      try {
        sendTerminalFrame(encodeInputFrame(data));
        setError(null);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to send terminal input.");
      }
    });

    const focusTerminal = () => {
      terminal.focus();
    };

    host.addEventListener("click", focusTerminal);
    terminal.focus();

    return () => {
      host.removeEventListener("click", focusTerminal);
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [immersiveMobileMode, sendTerminalFrame, sessionClosed]);

  useEffect(() => {
    lastAppliedInsertNonceRef.current = 0;
    retryAttemptRef.current = 0;
    setLoading(true);
    setError(null);
    decoderRef.current = new TextDecoder();
    if (terminalRef.current) {
      resetTerminalOutput(terminalRef.current, "");
      terminalRef.current.options.disableStdin = sessionClosed;
      terminalRef.current.options.cursorBlink = !sessionClosed;
    }
    closeSocket();
  }, [closeSocket, sessionClosed, sessionId]);

  useEffect(() => {
    const host = terminalHostRef.current;
    const terminal = terminalRef.current;
    if (!host || !terminal) {
      return;
    }

    terminal.options.disableStdin = sessionClosed || socketRef.current?.readyState !== WebSocket.OPEN;
    terminal.options.cursorBlink = !sessionClosed && socketRef.current?.readyState === WebSocket.OPEN;
    terminal.options.fontSize = immersiveMobileMode ? 12 : 13;
    terminal.options.lineHeight = immersiveMobileMode ? 1.34 : 1.44;

    const applyGeometry = () => {
      const next = calculateTerminalGeometry(host);
      geometryRef.current = next;
      if (terminal.cols !== next.cols || terminal.rows !== next.rows) {
        terminal.resize(next.cols, next.rows);
      }
      if (!sessionClosed) {
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(encodeResizeFrame(next.cols, next.rows));
          } catch {
            // Ignore transient resize failures while reconnecting.
          }
        }
      }
    };

    applyGeometry();

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        applyGeometry();
      });

    observer?.observe(host);
    window.addEventListener("resize", applyGeometry);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", applyGeometry);
    };
  }, [immersiveMobileMode, sessionClosed]);

  useEffect(() => {
    if (sessionClosed) {
      let cancelled = false;
      setLoading(true);
      void fetchClosedTerminalOutput(sessionId)
        .then((output) => {
          if (cancelled) {
            return;
          }
          if (terminalRef.current) {
            resetTerminalOutput(terminalRef.current, output);
          }
          setError(null);
        })
        .catch((nextError) => {
          if (!cancelled) {
            setError(nextError instanceof Error ? nextError.message : "Failed to load terminal output.");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void fetchRelayTerminalUrl(sessionId)
      .then((wsUrl) => {
        if (cancelled) {
          return;
        }

        closeSocket();
        const socket = new WebSocket(wsUrl);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          retryAttemptRef.current = 0;
          decoderRef.current = new TextDecoder();
          if (terminalRef.current) {
            resetTerminalOutput(terminalRef.current, "");
            terminalRef.current.options.disableStdin = false;
            terminalRef.current.options.cursorBlink = true;
          }
          try {
            sendHandshake();
            window.setTimeout(() => {
              if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
                try {
                  sendHandshake();
                } catch {
                  // Ignore handshake retries during reconnect churn.
                }
              }
            }, 300);
            setError(null);
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "Failed to initialize terminal.");
          } finally {
            setLoading(false);
          }
        };

        socket.onmessage = (event) => {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }

          const frame = typeof event.data === "string"
            ? new TextEncoder().encode(event.data)
            : new Uint8Array(event.data as ArrayBuffer);
          if (frame.length === 0) {
            return;
          }

          switch (frame[0]) {
            case CMD_OUTPUT: {
              const text = decoderRef.current.decode(frame.slice(1), { stream: true });
              if (text.length > 0) {
                terminal.write(text);
              }
              break;
            }
            default:
              break;
          }
        };

        socket.onerror = () => {
          if (!cancelled) {
            setError("Relay terminal connection failed.");
          }
        };

        socket.onclose = () => {
          socketRef.current = null;
          if (terminalRef.current) {
            terminalRef.current.options.disableStdin = true;
            terminalRef.current.options.cursorBlink = false;
          }
          if (!cancelled) {
            setError("Relay terminal disconnected.");
            scheduleReconnect();
          }
        };
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to connect relay terminal.");
          setLoading(false);
          scheduleReconnect();
        }
      });

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closeSocket();
    };
  }, [closeSocket, connectionTick, scheduleReconnect, sendHandshake, sessionClosed, sessionId]);

  useEffect(() => {
    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    const inlineText = pendingInsert.inlineText.trim();
    if (inlineText.length === 0 || sessionClosed) {
      return;
    }

    try {
      sendTerminalFrame(encodeInputFrame(`${inlineText} `));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to queue terminal input.");
    }
  }, [pendingInsert, sendTerminalFrame, sessionClosed]);

  const handleRetry = useCallback(() => {
    retryAttemptRef.current = 0;
    setError(null);
    setConnectionTick((value) => value + 1);
  }, []);

  return (
    <div className="group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 sm:right-3 sm:top-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={handleRetry}
          aria-label="Reload relay terminal"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-0.5 pb-0 pt-0.5 lg:px-1.5 lg:pb-1 lg:pt-3 w-full">
        <div
          ref={terminalHostRef}
          className="h-full w-full overflow-hidden rounded-[10px] bg-[#060404]"
        />
        {loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#060404]/84">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#141010]/92 px-3 py-2 text-[12px] text-[#c9c0b7] backdrop-blur-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{sessionClosed ? "Loading terminal output…" : "Connecting relay terminal…"}</span>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/12 bg-[#161212] px-3 py-2 text-[11px] text-[#ffb39e] backdrop-blur-sm [padding-bottom:env(safe-area-inset-bottom)]">
          <div className="flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
