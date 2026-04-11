"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { attachMobileTouchScrollShim } from "@/components/sessions/terminal/mobileTouchScroll";

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

type ControlMessage =
  | { type: "ready"; sequence?: number; cwd?: string | null }
  | { type: "cwd"; cwd?: string | null }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message?: string }
  | { type: "pong" };

const RECONNECT_MAX_DELAY_MS = 4_000;
const MAX_RECONNECT_ATTEMPTS = 20;

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

function resolveWebSocketUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("ws://") || pathOrUrl.startsWith("wss://")) {
    return pathOrUrl;
  }
  const origin = window.location.protocol === "https:"
    ? `wss://${window.location.host}`
    : `ws://${window.location.host}`;
  return `${origin}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

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

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>("Connecting terminal…");
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
    setStatus(reason ?? "Showing stored terminal output.");
    if (!outputUrl) {
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

  const connect = useCallback(async () => {
    if (!allowReconnectRef.current) {
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(retryAttemptRef.current > 0 ? "Reconnecting terminal…" : "Connecting terminal…");

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

    const ws = new WebSocket(resolveWebSocketUrl(info.wsUrl));
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    ws.onopen = () => {
      retryAttemptRef.current = 0;
      const geometry = fitTerminal();
      ws.send(JSON.stringify({
        type: "hello",
        cols: geometry?.cols ?? 120,
        rows: geometry?.rows ?? 32,
      }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        terminalRef.current?.write(new Uint8Array(event.data));
        return;
      }

      const text = typeof event.data === "string" ? event.data : "";
      try {
        const payload = JSON.parse(text) as ControlMessage;
        switch (payload.type) {
          case "ready":
            setLoading(false);
            setStatus(payload.cwd ? `Live terminal, ${payload.cwd}` : "Live terminal connected.");
            return;
          case "cwd":
            setStatus(payload.cwd ? `Live terminal, ${payload.cwd}` : "Live terminal connected.");
            return;
          case "exit":
            setLoading(false);
            setStatus(`Terminal exited (${payload.exitCode ?? 0}).`);
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
      setError("Terminal websocket failed.");
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
        setStatus("Terminal disconnected.");
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
  }, [clearReconnectTimer, fitTerminal, loadStoredOutput, tokenUrl]);

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
      socket.send(JSON.stringify({ type: "input", data }));
    });

    const resizeObserver = new ResizeObserver(() => {
      const geometry = fitTerminal();
      const socket = socketRef.current;
      if (!geometry || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        type: "resize",
        cols: geometry.cols,
        rows: geometry.rows,
      }));
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
  }, [clearReconnectTimer, closeSocket, connect, fitTerminal]);

  return (
    <div className="flex h-screen min-h-0 w-full min-w-0 flex-col bg-[#060404] text-[#efe8e1]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-[11px] uppercase tracking-[0.24em] text-[#c9c0b7]">
        <span>Conductor terminal</span>
        <span>{status ?? ""}</span>
      </div>
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
        <div ref={hostRef} className="h-full w-full overflow-hidden px-2 py-1" />
      </div>
    </div>
  );
}
