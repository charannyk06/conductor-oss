/**
 * Unified terminal WebSocket/SSE lifecycle hook.
 * State machine: idle -> connecting -> restoring -> live -> reconnecting -> closed
 * No sticky downgrade flags -- each reconnect cycle starts fresh with WS preference.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { buildTerminalSocketUrl } from "../sessionTerminalUtils";
import { clearCachedTerminalConnection } from "./terminalCache";
import type { TerminalServerEvent } from "./terminalTypes";

export type TerminalConnectionState =
  | "idle" | "connecting" | "restoring" | "live" | "reconnecting" | "closed";

export interface UseTerminalSocketOptions {
  sessionId: string;
  wsUrl: string | null;
  sseUrl: string | null;
  enabled: boolean;
  cols: number;
  rows: number;
  lastSequence: number | null;
  onData: (data: ArrayBuffer | string) => void;
  onReady: (isReconnect: boolean) => void;
  onExit: (exitCode: number) => void;
  onError: (message: string) => void;
  onControlNotice?: (message: string) => void;
  onStateChange: (state: TerminalConnectionState) => void;
}

export interface UseTerminalSocketReturn {
  state: TerminalConnectionState;
  send: (message: string) => void;
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
  reconnect: () => void;
  close: () => void;
  socketRef: React.MutableRefObject<WebSocket | null>;
}

const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 30_000;

function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
}

export function useTerminalSocket(options: UseTerminalSocketOptions): UseTerminalSocketReturn {
  const { sessionId, wsUrl, sseUrl, enabled, cols, rows, lastSequence } = options;

  const [state, setState] = useState<TerminalConnectionState>("idle");
  const stateRef = useRef<TerminalConnectionState>("idle");
  const socketRef = useRef<WebSocket | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  // Refs for cols/rows so the connection effect does not re-run on resize
  const colsRef = useRef(cols);
  const rowsRef = useRef(rows);
  colsRef.current = cols;
  rowsRef.current = rows;

  // Track lastSequence in a ref so the value is always fresh inside the
  // connection effect without needing it in the dependency array (which
  // would cause spurious reconnects).
  const lastSequenceRef = useRef(lastSequence);
  lastSequenceRef.current = lastSequence;

  const transition = useCallback((next: TerminalConnectionState) => {
    stateRef.current = next;
    setState(next);
    callbacksRef.current.onStateChange(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    clearTimer();
    const ws = socketRef.current;
    if (ws) { socketRef.current = null; ws.close(); }
    const es = eventSourceRef.current;
    if (es) { eventSourceRef.current = null; es.close(); }
  }, [clearTimer]);

  const scheduleReconnect = useCallback(() => {
    // Tear down any existing socket/eventsource before scheduling reconnect
    // to prevent orphaned connections when reconnecting after transient failures.
    teardown();
    const delay = backoffDelay(attemptRef.current);
    attemptRef.current += 1;
    transition("reconnecting");
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      transition("connecting");
    }, delay);
  }, [teardown, transition]);

  const send = useCallback((message: string) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(message);
  }, []);

  const sendBinary = useCallback((data: ArrayBuffer | Uint8Array) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  }, []);

  const reconnect = useCallback(() => {
    teardown();
    attemptRef.current = 0;
    clearCachedTerminalConnection(sessionId);
    transition("connecting");
  }, [teardown, sessionId, transition]);

  const close = useCallback(() => {
    teardown();
    transition("closed");
  }, [teardown, transition]);

  // Connection lifecycle -- fires when state enters "connecting".
  // IMPORTANT: `state` is in the dependency array so that reconnect cycles
  // (which transition back to "connecting") re-trigger this effect.  When the
  // connection succeeds (state moves to "live"/"restoring"), the effect re-runs
  // and hits the early-return guard.  We track `connected` so the cleanup does
  // NOT tear down a successfully established socket -- other effects (disable,
  // close, unmount) handle that.
  useEffect(() => {
    if (!enabled || state !== "connecting") return;
    if (!wsUrl && !sseUrl) return;
    let cancelled = false;
    let connected = false;

    // Read the current lastSequence from the ref to avoid stale closures
    const currentLastSequence = lastSequenceRef.current;

    const handleServerEvent = (event: TerminalServerEvent): void => {
      if (event.type === "control" && event.event === "exit") {
        callbacksRef.current.onExit(event.exitCode ?? 0);
      } else if (event.type === "control" && event.event === "input_queue_full") {
        const action = typeof event.action === "string" && event.action.length > 0
          ? ` (${event.action})`
          : "";
        callbacksRef.current.onControlNotice?.(
          `Terminal input queue is full${action}. Input is still being retried when possible.`,
        );
      } else if (event.type === "control" && event.event === "ready") {
        const wasReconnect = hasConnectedRef.current;
        hasConnectedRef.current = true;
        transition("live");
        callbacksRef.current.onReady(wasReconnect);
      } else if (event.type === "error") {
        callbacksRef.current.onError(event.error);
      } else if (event.type === "recovery") {
        callbacksRef.current.onData(JSON.stringify(event));
      }
    };

    const tryEventSource = (url: string): void => {
      const fullUrl = buildTerminalSocketUrl(url, colsRef.current, rowsRef.current, currentLastSequence);
      const es = new EventSource(fullUrl, { withCredentials: true });
      eventSourceRef.current = es;
      es.onopen = () => {
        if (cancelled) return;
        connected = true;
        attemptRef.current = 0;
        const wasReconnect = hasConnectedRef.current;
        hasConnectedRef.current = true;
        transition(currentLastSequence !== null ? "restoring" : "live");
        callbacksRef.current.onReady(wasReconnect);
      };
      es.onmessage = (e: MessageEvent) => {
        if (cancelled) return;
        callbacksRef.current.onData(e.data as string);
        if (stateRef.current === "restoring") transition("live");
      };
      es.onerror = () => {
        if (cancelled) return;
        eventSourceRef.current = null;
        es.close();
        scheduleReconnect();
      };
    };

    const tryWebSocket = (url: string): void => {
      // Close any existing socket before opening a new one to prevent orphaned
      // connections when wsUrl/sseUrl changes while already connected.
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      const fullUrl = buildTerminalSocketUrl(url, colsRef.current, rowsRef.current, currentLastSequence);
      const ws = new WebSocket(fullUrl);
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;
      let closeHandled = false;

      ws.onopen = () => {
        if (cancelled) return;
        connected = true;
        attemptRef.current = 0;
        const wasReconnect = hasConnectedRef.current;
        hasConnectedRef.current = true;
        transition(currentLastSequence !== null ? "restoring" : "live");
        callbacksRef.current.onReady(wasReconnect);
      };
      ws.onmessage = (e: MessageEvent) => {
        if (cancelled) return;
        if (e.data instanceof ArrayBuffer) {
          callbacksRef.current.onData(e.data);
          if (stateRef.current === "restoring") transition("live");
          return;
        }
        if (typeof e.data === "string") {
          try { handleServerEvent(JSON.parse(e.data) as TerminalServerEvent); }
          catch { callbacksRef.current.onError("Received an invalid terminal event"); }
        }
      };
      ws.onerror = () => {
        if (cancelled || closeHandled) return;
        closeHandled = true;
        socketRef.current = null;
        sseUrl ? tryEventSource(sseUrl) : scheduleReconnect();
      };
      ws.onclose = (event: CloseEvent) => {
        if (cancelled || closeHandled) return;
        closeHandled = true;
        socketRef.current = null;
        // Normal closure (1000) or "going away" (1001) -- don't reconnect.
        if (event.code === 1000 || event.code === 1001) {
          transition("closed");
          return;
        }
        scheduleReconnect();
      };
    };

    if (wsUrl) tryWebSocket(wsUrl);
    else if (sseUrl) tryEventSource(sseUrl);

    return () => {
      // Only cancel + tear down if the connection attempt didn't succeed.
      // When wsUrl/sseUrl change, a new effect invocation creates a fresh
      // connection — the unconditional teardown here was previously killing
      // successfully established sockets as soon as state transitioned from
      // "connecting" → "live" (which re-ran this effect via the `state` dep).
      //
      // CRITICAL: Do NOT set `cancelled = true` when `connected` is true.
      // The WebSocket's onmessage/onclose handlers were created in this
      // closure and check `cancelled` — setting it to true would silently
      // drop all incoming data even though the socket is still alive.
      if (!connected) {
        cancelled = true;
        teardown();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state, wsUrl, sseUrl]);

  // Unconditional unmount cleanup -- always close the socket when the component
  // is torn down, regardless of the current connection state.
  useEffect(() => () => teardown(), [teardown]);

  // Auto-connect when enabled with valid URLs and currently idle or closed.
  // "closed" can occur when the session-reset effect calls socketClose() before
  // bootstrap URLs arrive -- we must still allow a fresh connection attempt.
  useEffect(() => {
    if (enabled && (stateRef.current === "idle" || stateRef.current === "closed") && (wsUrl || sseUrl)) {
      transition("connecting");
    }
  }, [enabled, wsUrl, sseUrl, transition]);

  // Reset to idle when disabled.
  useEffect(() => {
    if (!enabled && stateRef.current !== "idle" && stateRef.current !== "closed") {
      teardown();
      transition("idle");
    }
  }, [enabled, teardown, transition]);

  return { state, send, sendBinary, reconnect, close, socketRef };
}
