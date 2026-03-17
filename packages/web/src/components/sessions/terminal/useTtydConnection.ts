/**
 * React hook for managing ttyd WebSocket connection with xterm.js.
 *
 * The TtydClient owns the Terminal reference and writes output directly —
 * this hook just manages lifecycle, reconnection, and exposes control methods.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TtydClient, DEFAULT_FLOW_CONTROL } from "./ttydClient";
import { RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from "./terminalConstants";

export interface UseTtydConnectionOptions {
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  ptyWsUrl: string | null;
  enabled?: boolean;
  onConnectionReady?: () => void;
  onConnectionError?: (error: Error) => void;
  onConnectionClosed?: (code: number, reason: string) => void;
  onReconnectsExhausted?: () => void;
}

export interface UseTtydConnectionResult {
  isConnected: boolean;
  isConnecting: boolean;
  error: Error | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  sendInput: (data: string | Uint8Array) => void;
  sendResize: (cols: number, rows: number) => void;
}

export function useTtydConnection(
  options: UseTtydConnectionOptions
): UseTtydConnectionResult {
  const { terminal, fitAddon, ptyWsUrl, enabled = true, onConnectionReady, onConnectionError, onConnectionClosed, onReconnectsExhausted } = options;

  const clientRef = useRef<TtydClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxReconnectAttempts = 5;

  // Store callbacks in refs to avoid re-running effects on every render
  const onConnectionReadyRef = useRef(onConnectionReady);
  const onConnectionErrorRef = useRef(onConnectionError);
  const onConnectionClosedRef = useRef(onConnectionClosed);
  const onReconnectsExhaustedRef = useRef(onReconnectsExhausted);
  onConnectionReadyRef.current = onConnectionReady;
  onConnectionErrorRef.current = onConnectionError;
  onConnectionClosedRef.current = onConnectionClosed;
  onReconnectsExhaustedRef.current = onReconnectsExhausted;

  // Reset connection state when ptyWsUrl changes (new URL = fresh connection attempt)
  const prevPtyWsUrlRef = useRef(ptyWsUrl);
  useEffect(() => {
    if (ptyWsUrl !== prevPtyWsUrlRef.current) {
      prevPtyWsUrlRef.current = ptyWsUrl;
      setError(null);
      setIsConnected(false);
      setIsConnecting(false);
      reconnectAttemptsRef.current = 0;
    }
  }, [ptyWsUrl]);

  // Create TtydClient when terminal is available.
  // The client owns the terminal ref and writes output directly.
  useEffect(() => {
    if (!enabled || !terminal) return;

    const client = new TtydClient(terminal, DEFAULT_FLOW_CONTROL, {
      onTitle: (title) => {
        try {
          document.title = title;
        } catch {
          /* ignore */
        }
      },
      onPreferences: () => {
        // Server preferences intentionally ignored.
        // Frontend owns terminal theme and font sizing.
      },
      onConnected: () => {
        reconnectAttemptsRef.current = 0;
        setIsConnected(true);
        setIsConnecting(false);
        setError(null);
        onConnectionReadyRef.current?.();
      },
      onDisconnected: (code, reason) => {
        setIsConnected(false);
        setIsConnecting(false);
        onConnectionClosedRef.current?.(code, reason);

        // Auto-reconnect on abnormal closure
        if (code !== 1000 && reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++;
          const delayMs = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current - 1),
            RECONNECT_MAX_DELAY_MS,
          );
          // Set a sentinel error to prevent the auto-connect effect from
          // firing immediately — cleared after the backoff delay.
          setError(new Error("Reconnecting…"));
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            setError(null); // allow auto-connect effect to fire
          }, delayMs);
        } else if (code !== 1000) {
          // All reconnect attempts exhausted — signal parent to refresh URL/token
          setError(new Error("Connection lost"));
          onReconnectsExhaustedRef.current?.();
        }
      },
      onError: (errorMsg) => {
        const err = new Error(`Terminal error: ${errorMsg}`);
        setError(err);
        onConnectionErrorRef.current?.(err);
      },
    });

    clientRef.current = client;

    return () => {
      client.disconnect();
      clientRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [enabled, terminal]);

  // Wire terminal resize → WebSocket
  useEffect(() => {
    if (!terminal || !fitAddon || !clientRef.current) return;

    const disposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      clientRef.current?.sendResize(cols, rows);
    });

    return () => disposable.dispose();
  }, [terminal, fitAddon]);

  // Connect — passes terminal dimensions in the ttyd handshake
  const connect = useCallback(async () => {
    if (!ptyWsUrl || !clientRef.current || isConnected || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const cols = terminal?.cols ?? 120;
      const rows = terminal?.rows ?? 40;
      await clientRef.current.connect(ptyWsUrl, cols, rows);
    } catch (err) {
      const connectError = err instanceof Error ? err : new Error(String(err));
      setError(connectError);
      setIsConnecting(false);
      onConnectionErrorRef.current?.(connectError);
    }
  }, [ptyWsUrl, isConnected, isConnecting, terminal]);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    setIsConnected(false);
  }, []);

  const sendInput = useCallback((data: string | Uint8Array) => {
    clientRef.current?.sendInput(data);
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    clientRef.current?.sendResize(cols, rows);
  }, []);

  // Auto-connect when enabled and URL is available
  useEffect(() => {
    if (!enabled || !ptyWsUrl || !terminal || isConnected || isConnecting || error) return;

    const timer = setTimeout(() => {
      connect();
    }, 0);

    return () => clearTimeout(timer);
  }, [enabled, ptyWsUrl, isConnected, isConnecting, error, connect, terminal]);

  return {
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
    sendInput,
    sendResize,
  };
}
