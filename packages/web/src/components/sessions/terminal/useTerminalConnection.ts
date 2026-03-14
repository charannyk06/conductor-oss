/**
 * Hook for EventSource/SSE lifecycle, reconnect logic, and connection
 * state management.
 */

import { useCallback, useRef } from "react";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "./terminalConstants";
import { clearCachedTerminalConnection } from "./terminalCache";

export interface UseTerminalConnectionReturn {
  eventSourceRef: React.MutableRefObject<EventSource | null>;
  reconnectTimerRef: React.MutableRefObject<number | null>;
  reconnectCountRef: React.MutableRefObject<number>;
  connectAttemptRef: React.MutableRefObject<number>;
  hasConnectedOnceRef: React.MutableRefObject<boolean>;
  reconnectNoticeWrittenRef: React.MutableRefObject<boolean>;
  clearReconnectTimer: () => void;
  scheduleReconnect: () => void;
  requestReconnect: () => void;
}

export function useTerminalConnection(
  sessionId: string,
  pendingResizeSyncRef: React.MutableRefObject<boolean>,
  setTransportError: React.Dispatch<React.SetStateAction<string | null>>,
  setTransportNotice: React.Dispatch<React.SetStateAction<string | null>>,
  setConnectionState: React.Dispatch<React.SetStateAction<"connecting" | "live" | "closed" | "error">>,
  setSocketBaseUrl: React.Dispatch<React.SetStateAction<string | null>>,
  setReconnectToken: React.Dispatch<React.SetStateAction<number>>,
): UseTerminalConnectionReturn {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectAttemptRef = useRef(0);
  const hasConnectedOnceRef = useRef(false);
  const reconnectNoticeWrittenRef = useRef(false);

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
  }, [clearReconnectTimer, setReconnectToken]);

  const requestReconnect = useCallback(() => {
    clearReconnectTimer();
    clearCachedTerminalConnection(sessionId);
    pendingResizeSyncRef.current = true;
    setTransportError(null);
    setTransportNotice(null);
    setConnectionState("connecting");
    setSocketBaseUrl(null);
    setReconnectToken((value) => value + 1);
  }, [
    clearReconnectTimer,
    sessionId,
    pendingResizeSyncRef,
    setTransportError,
    setTransportNotice,
    setConnectionState,
    setSocketBaseUrl,
    setReconnectToken,
  ]);

  return {
    eventSourceRef,
    reconnectTimerRef,
    reconnectCountRef,
    connectAttemptRef,
    hasConnectedOnceRef,
    reconnectNoticeWrittenRef,
    clearReconnectTimer,
    scheduleReconnect,
    requestReconnect,
  };
}
