"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BRIDGE_CONNECTION_SCOPE,
  type BridgeStatus,
  type BrowserToBridgeMessage,
  type FileEntry,
  isBridgeToBrowserMessage,
} from "@/types/bridge";
import { buildBridgeWebSocketUrl, hasBridgeSettings } from "@/lib/bridge";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PendingBrowseRequest = {
  path: string;
  resolve: (entries: FileEntry[]) => void;
  reject: (error: Error) => void;
};

function makeRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.trim().length > 0) return new Error(value);
  return new Error(fallback);
}

function normalizeTerminalChunk(value: string): { reset: boolean; data: string } {
  if (value.startsWith("\u000c")) {
    return { reset: true, data: value.slice(1) };
  }
  return { reset: false, data: value };
}

export interface BridgeTunnelState {
  connected: boolean;
  bridgeStatus: BridgeStatus | null;
  error: string | null;
  terminalChunk: string | null;
  terminalSequence: number;
  requestApi: (method: string, path: string, body?: unknown) => Promise<unknown>;
  browsePath: (path: string) => Promise<FileEntry[]>;
  sendTerminalInput: (data: string) => void;
  sendTerminalResize: (cols: number, rows: number) => void;
  sendPing: () => void;
}

export function useBridgeTunnel(scope: string = BRIDGE_CONNECTION_SCOPE): BridgeTunnelState {
  const [connected, setConnected] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalChunk, setTerminalChunk] = useState<string | null>(null);
  const [terminalSequence, setTerminalSequence] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const retryRef = useRef(0);
  const connectBridgeRef = useRef<() => void>(() => {});
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());
  const pendingBrowseRef = useRef<PendingBrowseRequest | null>(null);

  const flushPending = useCallback((reason: string) => {
    for (const [id, pending] of pendingRequestsRef.current.entries()) {
      pending.reject(new Error(reason));
      pendingRequestsRef.current.delete(id);
    }
    if (pendingBrowseRef.current) {
      pendingBrowseRef.current.reject(new Error(reason));
      pendingBrowseRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        // Ignore close failures during teardown.
      }
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (cancelledRef.current) return;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    const delay = Math.min(4000, 500 * 2 ** retryRef.current);
    retryRef.current = Math.min(retryRef.current + 1, 3);
    reconnectTimerRef.current = window.setTimeout(() => {
      connectBridgeRef.current();
    }, delay);
  }, []);

  const sendMessage = useCallback((message: BrowserToBridgeMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Bridge is not connected.");
    }
    socket.send(JSON.stringify(message));
  }, []);

  const requestApi = useCallback(async (method: string, path: string, body?: unknown) => {
    return await new Promise<unknown>((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Bridge is not connected."));
        return;
      }

      const id = makeRequestId();
      pendingRequestsRef.current.set(id, { resolve, reject });

      try {
        socket.send(JSON.stringify({
          type: "api_request",
          id,
          method,
          path,
          ...(body === undefined ? {} : { body }),
        } satisfies BrowserToBridgeMessage));
      } catch (err) {
        pendingRequestsRef.current.delete(id);
        reject(asError(err, "Failed to send bridge request."));
      }
    });
  }, [sendMessage]);

  const browsePath = useCallback(async (path: string) => {
    return await new Promise<FileEntry[]>((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Bridge is not connected."));
        return;
      }

      if (pendingBrowseRef.current) {
        pendingBrowseRef.current.reject(new Error("A file browse request is already in flight."));
      }

      pendingBrowseRef.current = { path, resolve, reject };
      try {
        socket.send(JSON.stringify({ type: "file_browse", path } satisfies BrowserToBridgeMessage));
      } catch (err) {
        pendingBrowseRef.current = null;
        reject(asError(err, "Failed to send file browse request."));
      }
    });
  }, []);

  const sendTerminalInput = useCallback((data: string) => {
    if (!data) return;
    try {
      sendMessage({ type: "terminal_input", data });
    } catch (err) {
      setError(asError(err, "Failed to send terminal input.").message);
    }
  }, [sendMessage]);

  const sendTerminalResize = useCallback((cols: number, rows: number) => {
    try {
      sendMessage({ type: "terminal_resize", cols, rows });
    } catch (err) {
      setError(asError(err, "Failed to send terminal resize.").message);
    }
  }, [sendMessage]);

  const sendPing = useCallback(() => {
    try {
      sendMessage({ type: "ping" });
    } catch (err) {
      setError(asError(err, "Failed to send bridge ping.").message);
    }
  }, [sendMessage]);

  const connectBridge = useCallback(() => {
    if (cancelledRef.current) return;
    if (!hasBridgeSettings()) {
      setConnected(false);
      setBridgeStatus(null);
      setError(null);
      flushPending("Bridge settings removed.");
      closeSocket();
      return;
    }

    const url = buildBridgeWebSocketUrl(scope);
    if (!url) {
      setConnected(false);
      setBridgeStatus(null);
      setError("Bridge relay URL is invalid.");
      flushPending("Bridge relay URL is invalid.");
      closeSocket();
      scheduleReconnect();
      return;
    }

    closeSocket();
    flushPending("Bridge connection closed.");

    try {
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
        setError(null);
      };

      socket.onmessage = (event) => {
        let payload: unknown;
        try {
          payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }

        if (!isBridgeToBrowserMessage(payload)) {
          return;
        }

        switch (payload.type) {
          case "bridge_status":
            setBridgeStatus(payload);
            setConnected(payload.connected);
            break;
          case "api_response": {
            const pending = pendingRequestsRef.current.get(payload.id);
            if (pending) {
              pending.resolve(payload.body);
              pendingRequestsRef.current.delete(payload.id);
            }
            break;
          }
          case "file_tree": {
            const pending = pendingBrowseRef.current;
            if (pending && pending.path === payload.path) {
              pending.resolve(payload.entries);
              pendingBrowseRef.current = null;
            }
            break;
          }
          case "terminal_output": {
            const chunk = normalizeTerminalChunk(payload.data);
            setTerminalChunk(chunk.reset ? `\u000c${chunk.data}` : chunk.data);
            setTerminalSequence((value) => value + 1);
            break;
          }
          case "pong":
            break;
        }
      };

      socket.onerror = () => {
        setConnected(false);
      };

      socket.onclose = () => {
        socketRef.current = null;
        setConnected(false);
        if (!cancelledRef.current) {
          setError("Bridge disconnected.");
          flushPending("Bridge connection closed.");
          scheduleReconnect();
        }
      };
    } catch (err) {
      setConnected(false);
      setError(asError(err, "Failed to connect to bridge.").message);
      scheduleReconnect();
    }
  }, [closeSocket, flushPending, scheduleReconnect, scope]);

  connectBridgeRef.current = connectBridge;

  useEffect(() => {
    cancelledRef.current = false;
    connectBridge();

    const onStorage = () => {
      if (!cancelledRef.current) {
        connectBridgeRef.current();
      }
    };

    window.addEventListener("storage", onStorage);
    return () => {
      cancelledRef.current = true;
      window.removeEventListener("storage", onStorage);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      flushPending("Bridge connection closed.");
      closeSocket();
    };
  }, [closeSocket, connectBridge, flushPending]);

  return {
    connected,
    bridgeStatus,
    error,
    terminalChunk,
    terminalSequence,
    requestApi,
    browsePath,
    sendTerminalInput,
    sendTerminalResize,
    sendPing,
  };
}
