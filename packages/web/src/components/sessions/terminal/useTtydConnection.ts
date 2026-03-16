/**
 * React hook for managing ttyd WebSocket connection with xterm.js
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TtydClient, DEFAULT_FLOW_CONTROL } from "./ttydClient";

export interface UseTtydConnectionOptions {
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  ptyWsUrl: string | null;
  enabled?: boolean;
  onConnectionReady?: () => void;
  onConnectionError?: (error: Error) => void;
  onConnectionClosed?: (code: number, reason: string) => void;
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

/**
 * Hook for managing ttyd WebSocket connection
 * Handles terminal I/O, resizing, and flow control
 */
export function useTtydConnection(
  options: UseTtydConnectionOptions
): UseTtydConnectionResult {
  const { terminal, fitAddon, ptyWsUrl, enabled = true, onConnectionReady, onConnectionError, onConnectionClosed } = options;

  const clientRef = useRef<TtydClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const writeCallbackRef = useRef<(() => void) | null>(null);

  // Initialize client
  useEffect(() => {
    if (!enabled || !terminal) return;

    const client = new TtydClient(DEFAULT_FLOW_CONTROL);

    // Handle output from server
    client.setOnData((data) => {
      if (typeof data === "string") {
        terminal.write(data, () => {
          writeCallbackRef.current?.();
        });
      } else {
        const str = new TextDecoder().decode(data);
        terminal.write(str, () => {
          writeCallbackRef.current?.();
        });
      }
    });

    // Handle window title
    client.setOnTitle((title) => {
      // Update document title or display in UI
      try {
        document.title = title;
      } catch {
        // Ignore if setting document title fails
      }
    });

    // Handle preferences (color scheme, font size, etc.)
    client.setOnPreferences((prefs) => {
      if (!prefs || typeof prefs !== "object") return;

      const prefsObj = prefs as Record<string, unknown>;

      // Apply theme if available
      if (typeof prefsObj.theme === "string") {
        terminal.options.theme = {
          background: "#000000",
          foreground: "#ffffff",
        };
      }

      // Apply font size if available
      if (typeof prefsObj.fontSize === "number") {
        terminal.options.fontSize = prefsObj.fontSize;
      }
    });

    // Handle connection established
    client.setOnConnected(() => {
      setIsConnected(true);
      setIsConnecting(false);
      setError(null);
      onConnectionReady?.();
    });

    // Handle disconnection
    client.setOnDisconnected((code, reason) => {
      setIsConnected(false);
      setIsConnecting(false);
      onConnectionClosed?.(code, reason);
    });

    // Handle errors
    client.setOnError((errorMsg) => {
      const err = new Error(`Terminal error: ${errorMsg}`);
      setError(err);
      onConnectionError?.(err);
    });

    clientRef.current = client;

    return () => {
      client.disconnect();
    };
  }, [enabled, terminal, onConnectionReady, onConnectionError, onConnectionClosed]);

  // Handle terminal input from user
  useEffect(() => {
    if (!terminal || !clientRef.current) return;

    const handleData = (data: string) => {
      clientRef.current?.sendInput(data);
    };

    terminal.onData(handleData);

    return () => {
      // Note: xterm.js doesn't provide a way to unsubscribe directly
      // These listeners will be cleaned up when terminal is disposed
    };
  }, [terminal]);

  // Handle terminal resize
  useEffect(() => {
    if (!terminal || !fitAddon || !clientRef.current) return;

    const handleResize = ({ cols, rows }: { cols: number; rows: number }) => {
      clientRef.current?.sendResize(cols, rows);
    };

    terminal.onResize(handleResize);

    return () => {
      // Same as above - listeners cleaned up with terminal disposal
    };
  }, [terminal, fitAddon]);

  // Track xterm.js write completion for flow control
  useEffect(() => {
    if (!terminal || !clientRef.current) return;

    writeCallbackRef.current = () => {
      clientRef.current?.markWriteComplete();
    };

    return () => {
      writeCallbackRef.current = null;
    };
  }, [terminal]);

  // Connect function
  const connect = useCallback(async () => {
    if (!ptyWsUrl || !clientRef.current || isConnected || isConnecting) {
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      await clientRef.current.connect(ptyWsUrl);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      setIsConnecting(false);
      onConnectionError?.(error);
    }
  }, [ptyWsUrl, isConnected, isConnecting, onConnectionError]);

  // Disconnect function
  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    setIsConnected(false);
  }, []);

  // Send input function
  const sendInput = useCallback((data: string | Uint8Array) => {
    clientRef.current?.sendInput(data);
  }, []);

  // Send resize function
  const sendResize = useCallback((cols: number, rows: number) => {
    clientRef.current?.sendResize(cols, rows);
  }, []);

  // Auto-connect when enabled and URL is available
  useEffect(() => {
    console.log("[useTtydConnection] Auto-connect check", {
      enabled,
      ptyWsUrl: ptyWsUrl?.slice(0, 50),
      isConnected,
      isConnecting,
      error: error?.message,
      terminal: !!terminal,
      clientRef: !!clientRef.current,
    });

    if (!enabled) {
      console.log("[useTtydConnection] Connection disabled");
      return;
    }

    if (!ptyWsUrl) {
      console.log("[useTtydConnection] No ptyWsUrl provided");
      return;
    }

    if (!terminal) {
      console.log("[useTtydConnection] Terminal not ready");
      return;
    }

    if (isConnected) {
      console.log("[useTtydConnection] Already connected");
      return;
    }

    if (isConnecting) {
      console.log("[useTtydConnection] Already connecting");
      return;
    }

    if (error) {
      console.log("[useTtydConnection] Previous error exists", error.message);
      return;
    }

    console.log("[useTtydConnection] Initiating connection to", ptyWsUrl);
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
