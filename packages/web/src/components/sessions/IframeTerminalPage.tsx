"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { attachMobileTouchScrollShim } from "@/components/sessions/terminal/mobileTouchScroll";
import { resolveNativeTerminalWebSocketUrl } from "@/components/sessions/terminal/terminalClientUrls";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";

type ConnectionInfo = {
  interactive?: boolean;
  reason?: string | null;
  wsUrl?: string | null;
  outputUrl?: string | null;
};

type OutputPayload = {
  output?: string;
  error?: string;
};

type RelayConnectionInfo = {
  wsUrl: string;
  wsProtocol: string;
};

type ControlMessage =
  | { type: "ready"; sequence?: number; cwd?: string | null }
  | { type: "cwd"; cwd?: string | null }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message?: string }
  | { type: "pong" };

const RECONNECT_MAX_DELAY_MS = 4_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const CMD_OUTPUT = "0".charCodeAt(0);
const CMD_SET_WINDOW_TITLE = "1".charCodeAt(0);
const CMD_SET_PREFERENCES = "2".charCodeAt(0);
const CMD_RESIZE = "1".charCodeAt(0);

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

export function IframeTerminalPage({
  sessionId,
  bridgeId,
}: {
  sessionId: string;
  bridgeId?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const allowReconnectRef = useRef(true);
  const reconnectTimerRef = useRef<number | null>(null);
  const cleanupTouchRef = useRef<(() => void) | null>(null);
  const retryAttemptRef = useRef(0);
  const decoderRef = useRef(new TextDecoder());
  const bridgeScopedSession = useMemo(() => decodeBridgeSessionId(sessionId), [sessionId]);
  const usesRelayTerminal = Boolean(bridgeId?.trim() || bridgeScopedSession);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tokenUrl = useMemo(
    () => withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/token`, bridgeId),
    [bridgeId, sessionId],
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    allowReconnectRef.current = false;
    if (!socket) {
      return;
    }
    try {
      socket.close();
    } catch {
      // Ignore teardown failures.
    }
  }, []);

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return null;
    }
    fitAddon.fit();
    return { cols: terminal.cols, rows: terminal.rows };
  }, []);

  const loadStoredOutput = useCallback(async (outputUrl?: string | null, reason?: string | null) => {
    setLoading(false);
    if (!outputUrl) {
      if (reason) {
        terminalRef.current?.writeln(`\r\n[Conductor] ${reason}`);
      }
      return;
    }
    try {
      const response = await fetch(outputUrl, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as OutputPayload | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to load terminal output (${response.status})`);
      }
      const output = typeof payload?.output === "string" ? payload.output : "";
      if (output.length > 0) {
        terminalRef.current?.write(output);
      }
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Failed to load stored output.";
      setError(message);
      terminalRef.current?.writeln(`\r\n[Conductor] ${message}`);
    }
  }, []);

  const fetchRelayTerminalUrl = useCallback(async (): Promise<RelayConnectionInfo> => {
    const response = await fetch(
      withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/relay`, bridgeId),
      {
        method: "POST",
        cache: "no-store",
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | { wsUrl?: string; wsProtocol?: string; error?: string }
      | null;
    if (!response.ok || !payload?.wsUrl || !payload.wsProtocol) {
      throw new Error(payload?.error ?? `Failed to attach relay terminal (${response.status})`);
    }
    return { wsUrl: payload.wsUrl, wsProtocol: payload.wsProtocol };
  }, [bridgeId, sessionId]);

  const encodeResizeFrame = useCallback((cols: number, rows: number): Uint8Array => {
    const payload = new TextEncoder().encode(JSON.stringify({ columns: cols, rows }));
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = CMD_RESIZE;
    frame.set(payload, 1);
    return frame;
  }, []);

  const encodeInputFrame = useCallback((data: string): Uint8Array => {
    const payload = new TextEncoder().encode(data);
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = CMD_OUTPUT;
    frame.set(payload, 1);
    return frame;
  }, []);

  const connect = useCallback(async () => {
    if (!allowReconnectRef.current) {
      return;
    }
    setLoading(true);
    setError(null);

    const response = await fetch(tokenUrl, { cache: "no-store" });
    if (!allowReconnectRef.current) {
      return;
    }
    const info = (await response.json().catch(() => null)) as ConnectionInfo | null;
    if (!response.ok) {
      throw new Error((info as { error?: string } | null)?.error ?? `Failed to resolve terminal (${response.status})`);
    }

    if (!info?.wsUrl) {
      await loadStoredOutput(info?.outputUrl, info?.reason ?? "Session is not running.");
      return;
    }

    const relayConnection = usesRelayTerminal ? await fetchRelayTerminalUrl() : null;
    const ws = relayConnection
      ? new WebSocket(relayConnection.wsUrl, relayConnection.wsProtocol)
      : new WebSocket(resolveNativeTerminalWebSocketUrl(info.wsUrl, window.location.origin));
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    ws.onopen = () => {
      retryAttemptRef.current = 0;
      decoderRef.current = new TextDecoder();
      const geometry = fitTerminal();
      if (relayConnection) {
        ws.send(encodeResizeFrame(geometry?.cols ?? 120, geometry?.rows ?? 32));
      } else {
        ws.send(JSON.stringify({
          type: "hello",
          cols: geometry?.cols ?? 120,
          rows: geometry?.rows ?? 32,
        }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = new Uint8Array(event.data);
        if (relayConnection) {
          if (frame.length === 0) {
            return;
          }
          switch (frame[0]) {
            case CMD_OUTPUT: {
              const text = decoderRef.current.decode(frame.slice(1), { stream: true });
              if (text.length > 0) {
                terminalRef.current?.write(text);
              }
              return;
            }
            case CMD_SET_WINDOW_TITLE: {
              try {
                const title = new TextDecoder().decode(frame.slice(1)).trim();
                if (title) {
                  document.title = title;
                }
              } catch {
                // Ignore malformed title payloads.
              }
              return;
            }
            case CMD_SET_PREFERENCES:
              return;
            default:
              return;
          }
        }
        terminalRef.current?.write(frame);
        return;
      }

      const text = typeof event.data === "string" ? event.data : "";
      try {
        const payload = JSON.parse(text) as ControlMessage;
        switch (payload.type) {
          case "ready":
            setLoading(false);
            return;
          case "cwd":
            return;
          case "exit":
            setLoading(false);
            terminalRef.current?.writeln(`\r\n[Conductor] Terminal exited (${payload.exitCode ?? 0}).`);
            return;
          case "error":
            setLoading(false);
            setError(payload.message ?? "Terminal connection failed.");
            terminalRef.current?.writeln(`\r\n[Conductor] ${payload.message ?? "Terminal connection failed."}`);
            return;
          case "pong":
            return;
        }
      } catch {
        terminalRef.current?.write(text);
      }
    };

    ws.onerror = () => {
      setError(relayConnection ? "Relay terminal connection failed." : "Terminal websocket failed.");
    };

    ws.onclose = async () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }
      if (!allowReconnectRef.current) {
        return;
      }
      if (retryAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setLoading(false);
        terminalRef.current?.writeln("\r\n[Conductor] Terminal disconnected.");
        return;
      }
      retryAttemptRef.current += 1;
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, 500 * retryAttemptRef.current);
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        void connect().catch((nextError) => {
          setLoading(false);
          setError(nextError instanceof Error ? nextError.message : "Failed to reconnect terminal.");
        });
      }, delay);
    };
  }, [clearReconnectTimer, fitTerminal, loadStoredOutput, tokenUrl, usesRelayTerminal, fetchRelayTerminalUrl, encodeResizeFrame]);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--font-ibm-plex-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      convertEol: false,
      scrollback: 5000,
      allowTransparency: false,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const host = hostRef.current;
    if (!host) {
      return () => {
        terminal.dispose();
      };
    }

    terminal.open(host);
    fitAddon.fit();
    allowReconnectRef.current = true;
    cleanupTouchRef.current = attachMobileTouchScrollShim(terminal, host);

    terminal.onData((data) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (usesRelayTerminal) {
        socket.send(encodeInputFrame(data));
      } else {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      const geometry = fitTerminal();
      const socket = socketRef.current;
      if (!geometry || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (usesRelayTerminal) {
        socket.send(encodeResizeFrame(geometry.cols, geometry.rows));
      } else {
        socket.send(JSON.stringify({
          type: "resize",
          cols: geometry.cols,
          rows: geometry.rows,
        }));
      }
    });
    resizeObserver.observe(host);

    void connect().catch((nextError) => {
      setLoading(false);
      setError(nextError instanceof Error ? nextError.message : "Failed to connect terminal.");
    });

    return () => {
      allowReconnectRef.current = false;
      resizeObserver.disconnect();
      cleanupTouchRef.current?.();
      cleanupTouchRef.current = null;
      clearReconnectTimer();
      closeSocket();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [clearReconnectTimer, closeSocket, connect, encodeInputFrame, encodeResizeFrame, fitTerminal, usesRelayTerminal]);

  return (
    <div className="flex h-screen min-h-0 w-full min-w-0 flex-col bg-[#060404] text-[#efe8e1]">
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full border border-white/10 bg-[#141010]/92 px-3 py-1 text-[12px] text-[#c9c0b7]">
            Connecting…
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[12px] text-red-200">
            {error}
          </div>
        ) : null}
        <div ref={hostRef} className="h-full w-full overflow-hidden" />
      </div>
    </div>
  );
}
