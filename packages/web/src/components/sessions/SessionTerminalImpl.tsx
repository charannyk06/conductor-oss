"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { uploadProjectAttachments } from "./attachmentUploads";
import {
  calculateMobileTerminalViewportMetrics,
  isTerminalScrollHostAtBottom,
  resolveSessionTerminalViewportOptions,
} from "./sessionTerminalUtils";
import { LIVE_TERMINAL_STATUSES, RESUMABLE_STATUSES } from "./terminal/terminalConstants";
import { attachMobileTouchScrollShim } from "./terminal/mobileTouchScroll";
import { resolveTerminalConnection } from "./terminal/terminalApi";
import type { SessionTerminalProps } from "./terminal/terminalTypes";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import {
  extractFilesFromTransfer,
  extractImageFromClipboard,
  uploadClipboardImage,
} from "@/lib/clipboardImage";

const TERMINAL_CLOSED_STATUSES = new Set(["archived", "killed", "terminated", "restored"]);
const TOKEN_REFRESH_LEAD_SECONDS = 10;
const TERMINAL_SNAPSHOT_LINES = 10_000;
const RECONNECT_MAX_DELAY_MS = 4_000;

const CMD_OUTPUT = "0".charCodeAt(0);
const CMD_RESIZE = "1".charCodeAt(0);
const CMD_PAUSE = "2".charCodeAt(0);
const CMD_RESUME = "3".charCodeAt(0);

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

type TerminalSyncMode = "resize" | "handshake";

function computeTokenRefreshDelayMs(expiresInSeconds: number | null | undefined): number | null {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return null;
  }
  const safeSeconds = Math.max(5, expiresInSeconds - TOKEN_REFRESH_LEAD_SECONDS);
  return safeSeconds * 1000;
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

function encodePauseFrame(): Uint8Array {
  return new Uint8Array([CMD_PAUSE]);
}

function encodeResumeFrame(): Uint8Array {
  return new Uint8Array([CMD_RESUME]);
}

function terminalEndpointIdentity(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    url.searchParams.delete("token");
    url.searchParams.delete("jwt");
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

async function sendTerminalKeys(
  sessionId: string,
  keys: string,
  bridgeId?: string | null,
): Promise<void> {
  const response = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, bridgeId),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keys }),
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Failed to queue terminal input (${response.status})`);
  }
}

async function sendFollowUpMessage(
  sessionId: string,
  message: string,
  bridgeId?: string | null,
): Promise<void> {
  const response = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, bridgeId),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "send", message }),
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to send message (${response.status})`);
  }
}

async function fetchTerminalSnapshot(
  sessionId: string,
  bridgeId?: string | null,
): Promise<string> {
  const response = await fetch(
    withBridgeQuery(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?lines=${TERMINAL_SNAPSHOT_LINES}&live=1`,
      bridgeId,
    ),
    {
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | { snapshot?: string; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Failed to load terminal snapshot (${response.status})`);
  }
  return typeof payload?.snapshot === "string" ? payload.snapshot : "";
}

function asFrameData(data: string | ArrayBufferLike | Blob): Uint8Array | null {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function arePendingInsertRequestsEqual(
  left: SessionTerminalProps["pendingInsert"],
  right: SessionTerminalProps["pendingInsert"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.nonce === right.nonce && left.inlineText === right.inlineText;
}

function sessionTerminalPropsEqual(
  previous: SessionTerminalProps,
  next: SessionTerminalProps,
): boolean {
  return (
    previous.sessionId === next.sessionId
    && previous.projectId === next.projectId
    && previous.bridgeId === next.bridgeId
    && previous.sessionState === next.sessionState
    && previous.runtimeMode === next.runtimeMode
    && previous.immersiveMobileMode === next.immersiveMobileMode
    && arePendingInsertRequestsEqual(previous.pendingInsert, next.pendingInsert)
  );
}

function SessionTerminalView(props: SessionTerminalProps) {
  const {
    sessionId,
    projectId,
    bridgeId,
    sessionState,
    runtimeMode,
    pendingInsert,
    immersiveMobileMode = false,
  } = props;

  const promptInputRef = useRef<HTMLInputElement>(null);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const latestWebSocketUrlRef = useRef<string | null>(null);
  const currentSocketIdentityRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastAppliedInsertNonceRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const scheduledLayoutSyncTimersRef = useRef<number[]>([]);
  const followBottomRef = useRef(true);
  const pendingRestoreOnNextOutputRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  const hasStreamedOutputRef = useRef(false);
  const snapshotRequestIdRef = useRef(0);
  const inputStateRef = useRef({
    expectsLiveTerminal: false,
    projectId,
    sessionId,
    bridgeId,
  });

  const normalizedSessionStatus = useMemo(
    () => sessionState.trim().toLowerCase(),
    [sessionState],
  );
  const normalizedRuntimeMode = runtimeMode?.trim().toLowerCase() ?? null;
  const ttydBacked = normalizedRuntimeMode === "ttyd";
  const expectsLiveTerminal = ttydBacked
    ? !TERMINAL_CLOSED_STATUSES.has(normalizedSessionStatus)
    : LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus);
  const showPromptBar =
    !ttydBacked && !immersiveMobileMode && RESUMABLE_STATUSES.has(normalizedSessionStatus);

  const [terminalLinkUrl, setTerminalLinkUrl] = useState<string | null>(null);
  const [resolvingConnection, setResolvingConnection] = useState(expectsLiveTerminal);
  const [socketConnected, setSocketConnected] = useState(false);
  const [loadingSnapshot, setLoadingSnapshot] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hasOutput, setHasOutput] = useState(false);
  const [connectionRefreshTick, setConnectionRefreshTick] = useState(0);
  const [snapshotRefreshTick, setSnapshotRefreshTick] = useState(0);
  const [promptMessage, setPromptMessage] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [queuedInsertError, setQueuedInsertError] = useState<string | null>(null);

  useEffect(() => {
    inputStateRef.current = {
      expectsLiveTerminal,
      projectId,
      sessionId,
      bridgeId,
    };
  }, [bridgeId, expectsLiveTerminal, projectId, sessionId]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearScheduledLayoutSyncs = useCallback(() => {
    for (const timer of scheduledLayoutSyncTimersRef.current) {
      window.clearTimeout(timer);
    }
    scheduledLayoutSyncTimersRef.current = [];
  }, []);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    currentSocketIdentityRef.current = null;
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
      throw new Error("Live terminal is not connected.");
    }
    socket.send(frame);
  }, []);

  const applyTerminalViewport = useCallback(() => {
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
  }, []);

  const applyKeyboardAwareTerminalHeight = useCallback(() => {
    const host = terminalHostRef.current;
    if (!host || typeof window === "undefined") {
      return;
    }

    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return;
    }

    const { usableHeight, keyboardVisible } = calculateMobileTerminalViewportMetrics(
      window.innerHeight,
      visualViewport.height,
      visualViewport.offsetTop,
      host.getBoundingClientRect().top,
    );

    if (!keyboardVisible || usableHeight <= 0) {
      host.style.removeProperty("height");
      return;
    }

    host.style.height = `${Math.max(0, Math.round(usableHeight))}px`;
  }, []);

  const fitTerminal = useCallback(() => {
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
  }, [applyTerminalViewport]);

  const syncTerminalGeometry = useCallback((
    mode: TerminalSyncMode,
    force = false,
  ) => {
    const next = fitTerminal();
    if (!next || !expectsLiveTerminal) {
      return next;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return next;
    }

    try {
      if (mode === "handshake") {
        socket.send(JSON.stringify({ columns: next.cols, rows: next.rows }));
      } else if (force || next.changed) {
        socket.send(encodeResizeFrame(next.cols, next.rows));
      }
    } catch {
      // Ignore transient geometry sync failures while reconnecting.
    }

    return next;
  }, [expectsLiveTerminal, fitTerminal]);

  const scheduleGeometryRefreshes = useCallback(() => {
    clearScheduledLayoutSyncs();
    if (typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      syncTerminalGeometry("resize", true);
    });
    scheduledLayoutSyncTimersRef.current.push(
      window.setTimeout(() => {
        syncTerminalGeometry("resize", true);
      }, 120),
      window.setTimeout(() => {
        syncTerminalGeometry("resize", true);
      }, 360),
    );
  }, [clearScheduledLayoutSyncs, syncTerminalGeometry]);

  const writeSnapshot = useCallback((snapshot: string, scrollToBottom = true) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    resetTerminalOutput(terminal, snapshot, scrollToBottom);
    setHasOutput(snapshot.length > 0);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!expectsLiveTerminal) {
      return;
    }
    clearReconnectTimer();
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** retryAttemptRef.current);
    retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, 3);
    reconnectTimerRef.current = window.setTimeout(() => {
      setConnectionRefreshTick((value) => value + 1);
    }, delay);
  }, [clearReconnectTimer, expectsLiveTerminal]);

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
      cursorBlink: false,
      disableStdin: true,
      fontFamily: initialViewport.fontFamily,
      fontSize: initialViewport.fontSize,
      lineHeight: initialViewport.lineHeight,
      letterSpacing: 0.2,
      scrollback: 10_000,
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
      if (!inputStateRef.current.expectsLiveTerminal) {
        return;
      }
      try {
        sendTerminalFrame(encodeInputFrame(data));
        setConnectionError(null);
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : "Failed to send terminal input.",
        );
      }
    });

    const focusTerminal = () => {
      terminal.focus();
    };

    const handlePaste = async (event: ClipboardEvent) => {
      if (!inputStateRef.current.expectsLiveTerminal) {
        return;
      }

      const imageBlob = extractImageFromClipboard(event.clipboardData);
      if (!imageBlob) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      try {
        const result = await uploadClipboardImage({
          imageBlob,
          projectId: inputStateRef.current.projectId,
          taskRef: inputStateRef.current.sessionId,
          bridgeId: inputStateRef.current.bridgeId,
        });
        const imagePath = result.absolutePath || result.path;
        sendTerminalFrame(encodeInputFrame(`\r\n[pasted image: ${imagePath}]\r\n`));
        setQueuedInsertError(null);
      } catch (error) {
        setQueuedInsertError(
          error instanceof Error ? error.message : "Failed to upload pasted image.",
        );
      }
    };

    const handleDragOver = (event: DragEvent) => {
      if (!inputStateRef.current.expectsLiveTerminal) {
        return;
      }

      const files = extractFilesFromTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDrop = async (event: DragEvent) => {
      if (!inputStateRef.current.expectsLiveTerminal) {
        return;
      }

      const files = extractFilesFromTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      try {
        const uploadedPaths = await uploadProjectAttachments({
          files,
          projectId: inputStateRef.current.projectId,
          taskRef: inputStateRef.current.sessionId,
          bridgeId: inputStateRef.current.bridgeId,
        });
        for (const path of uploadedPaths) {
          sendTerminalFrame(encodeInputFrame(`\r\n[attached file: ${path}]\r\n`));
        }
        setQueuedInsertError(null);
      } catch (error) {
        setQueuedInsertError(
          error instanceof Error ? error.message : "Failed to upload dropped files.",
        );
      }
    };

    host.addEventListener("click", focusTerminal);
    host.addEventListener("paste", handlePaste, true);
    host.addEventListener("dragover", handleDragOver, true);
    host.addEventListener("drop", handleDrop, true);
    terminal.focus();
    window.requestAnimationFrame(() => {
      applyKeyboardAwareTerminalHeight();
      fitTerminal();
    });

    return () => {
      host.removeEventListener("click", focusTerminal);
      host.removeEventListener("paste", handlePaste, true);
      host.removeEventListener("dragover", handleDragOver, true);
      host.removeEventListener("drop", handleDrop, true);
      scrollHost?.removeEventListener("scroll", syncFollowBottom);
      dataSubscription.dispose();
      cleanupMobileTouchScroll?.();
      host.style.removeProperty("height");
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [applyKeyboardAwareTerminalHeight, fitTerminal, sendTerminalFrame]);

  useEffect(() => {
    clearReconnectTimer();
    clearScheduledLayoutSyncs();
    closeSocket();
    latestWebSocketUrlRef.current = null;
    decoderRef.current = new TextDecoder();
    lastAppliedInsertNonceRef.current = 0;
    retryAttemptRef.current = 0;
    followBottomRef.current = true;
    pendingRestoreOnNextOutputRef.current = false;
    pauseRequestedRef.current = false;
    hasStreamedOutputRef.current = false;
    snapshotRequestIdRef.current += 1;
    setTerminalLinkUrl(null);
    setResolvingConnection(expectsLiveTerminal);
    setSocketConnected(false);
    setLoadingSnapshot(true);
    setConnectionError(null);
    setHasOutput(false);
    setPromptMessage("");
    setPromptSending(false);
    setPromptError(null);
    setQueuedInsertError(null);
    if (terminalRef.current) {
      resetTerminalOutput(terminalRef.current, "", true);
      terminalRef.current.options.disableStdin = true;
      terminalRef.current.options.cursorBlink = false;
    }
  }, [clearReconnectTimer, clearScheduledLayoutSyncs, closeSocket, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.disableStdin = !expectsLiveTerminal || !socketConnected;
    terminal.options.cursorBlink = false;
  }, [expectsLiveTerminal, socketConnected]);

  useEffect(() => {
    let cancelled = false;
    const requestId = snapshotRequestIdRef.current + 1;
    snapshotRequestIdRef.current = requestId;
    setLoadingSnapshot(true);

    void fetchTerminalSnapshot(sessionId, bridgeId)
      .then((snapshot) => {
        if (cancelled || snapshotRequestIdRef.current !== requestId) {
          return;
        }
        if (hasStreamedOutputRef.current) {
          return;
        }
        const socket = socketRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          return;
        }
        writeSnapshot(snapshot, true);
      })
      .catch((error) => {
        if (!cancelled && snapshotRequestIdRef.current === requestId) {
          setConnectionError(
            (current) => current ?? (error instanceof Error ? error.message : "Failed to load terminal snapshot."),
          );
        }
      })
      .finally(() => {
        if (!cancelled && snapshotRequestIdRef.current === requestId) {
          setLoadingSnapshot(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeId, expectsLiveTerminal, sessionId, snapshotRefreshTick, writeSnapshot]);

  useEffect(() => {
    const host = terminalHostRef.current;
    const terminal = terminalRef.current;
    if (!host || !terminal) {
      return;
    }

    const applyGeometry = () => {
      applyKeyboardAwareTerminalHeight();
      syncTerminalGeometry("resize");
    };

    const refreshTerminalLayout = () => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        if (pauseRequestedRef.current) {
          pendingRestoreOnNextOutputRef.current = true;
          pauseRequestedRef.current = false;
          try {
            sendTerminalFrame(encodeResumeFrame());
          } catch {
            setConnectionRefreshTick((value) => value + 1);
            return;
          }
        }
        scheduleGeometryRefreshes();
        return;
      }

      fitTerminal();
      if (expectsLiveTerminal) {
        retryAttemptRef.current = 0;
        setConnectionRefreshTick((value) => value + 1);
      }
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
        return;
      }

      if (socketRef.current?.readyState === WebSocket.OPEN && !pauseRequestedRef.current) {
        pauseRequestedRef.current = true;
        try {
          sendTerminalFrame(encodePauseFrame());
        } catch {
          pauseRequestedRef.current = false;
        }
      }
    };
    const fontSet = typeof document === "undefined" ? null : document.fonts;
    let fontReadyCancelled = false;

    observer?.observe(host);
    window.addEventListener("resize", applyGeometry);
    window.addEventListener("pageshow", refreshTerminalLayout);
    window.addEventListener("focus", refreshTerminalLayout);
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
      window.removeEventListener("pageshow", refreshTerminalLayout);
      window.removeEventListener("focus", refreshTerminalLayout);
      visualViewport?.removeEventListener("resize", applyGeometry);
      visualViewport?.removeEventListener("scroll", applyGeometry);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      fontSet?.removeEventListener?.("loadingdone", refreshTerminalLayout as EventListener);
    };
  }, [
    applyKeyboardAwareTerminalHeight,
    expectsLiveTerminal,
    fitTerminal,
    scheduleGeometryRefreshes,
    sendTerminalFrame,
    syncTerminalGeometry,
  ]);

  useEffect(() => {
    if (!expectsLiveTerminal) {
      setResolvingConnection(false);
      setSocketConnected(false);
      clearReconnectTimer();
      closeSocket();
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let refreshTimer: number | null = null;
    const abortController = new AbortController();
    setResolvingConnection(true);

    const connectTerminal = (websocketUrl: string, identity: string) => {
      closeSocket();
      const socket = new WebSocket(websocketUrl, "tty");
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      currentSocketIdentityRef.current = identity;

      socket.onopen = () => {
        if (cancelled || socketRef.current !== socket) {
          return;
        }
        retryAttemptRef.current = 0;
        decoderRef.current = new TextDecoder();
        pendingRestoreOnNextOutputRef.current = true;
        pauseRequestedRef.current = false;
        setSocketConnected(true);
        setResolvingConnection(false);
        setConnectionError(null);
        try {
          syncTerminalGeometry("handshake", true);
          scheduleGeometryRefreshes();
        } catch (error) {
          setConnectionError(
            error instanceof Error ? error.message : "Failed to initialize terminal.",
          );
        }
      };

      socket.onmessage = (event) => {
        const terminal = terminalRef.current;
        if (!terminal || socketRef.current !== socket) {
          return;
        }

        const frame = asFrameData(event.data);
        if (!frame || frame.length === 0) {
          return;
        }

        switch (frame[0]) {
          case CMD_OUTPUT: {
            const text = decoderRef.current.decode(frame.slice(1), { stream: true });
            if (text.length === 0) {
              return;
            }
            hasStreamedOutputRef.current = true;
            if (pendingRestoreOnNextOutputRef.current) {
              pendingRestoreOnNextOutputRef.current = false;
              resetTerminalOutput(terminal, text, followBottomRef.current);
            } else {
              terminal.write(text);
              if (followBottomRef.current) {
                terminal.scrollToBottom();
              }
            }
            setHasOutput(true);
            break;
          }
          default:
            break;
        }
      };

      socket.onerror = () => {
        if (!cancelled && socketRef.current === socket) {
          setConnectionError("Live terminal connection failed.");
        }
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          currentSocketIdentityRef.current = null;
        }
        if (!cancelled) {
          setSocketConnected(false);
          setConnectionError("Live terminal disconnected.");
          scheduleReconnect();
        }
      };
    };

    void resolveTerminalConnection(sessionId, {
      signal: abortController.signal,
      bridgeId,
    })
      .then((connection) => {
        if (cancelled) {
          return;
        }

        setTerminalLinkUrl(connection.terminalUrl);
        latestWebSocketUrlRef.current = connection.websocketUrl;

        if (!connection.interactive || !connection.websocketUrl) {
          setSocketConnected(false);
          setResolvingConnection(false);
          closeSocket();
          setConnectionError(connection.reason ?? "Live ttyd terminal is unavailable.");
          return;
        }

        const identity = terminalEndpointIdentity(connection.websocketUrl);
        const socket = socketRef.current;
        const sameSocket =
          !!socket
          && identity !== null
          && identity === currentSocketIdentityRef.current
          && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN);

        if (!sameSocket) {
          connectTerminal(connection.websocketUrl, identity ?? connection.websocketUrl);
        } else {
          setConnectionError(null);
          setResolvingConnection(false);
        }

        const delayMs = computeTokenRefreshDelayMs(connection.expiresInSeconds);
        if (delayMs !== null) {
          refreshTimer = window.setTimeout(() => {
            setConnectionRefreshTick((current) => current + 1);
          }, delayMs);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setResolvingConnection(false);
        setSocketConnected(false);
        setConnectionError(
          error instanceof Error ? error.message : "Failed to resolve live ttyd terminal.",
        );
        const delay = Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** retryAttemptRef.current);
        retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, 3);
        retryTimer = window.setTimeout(() => {
          setConnectionRefreshTick((current) => current + 1);
        }, delay);
      });

    return () => {
      cancelled = true;
      abortController.abort();
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [
    bridgeId,
    clearReconnectTimer,
    closeSocket,
    connectionRefreshTick,
    expectsLiveTerminal,
    scheduleGeometryRefreshes,
    scheduleReconnect,
    sessionId,
    syncTerminalGeometry,
  ]);

  useEffect(() => {
    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    const inlineText = pendingInsert.inlineText.trim();
    if (inlineText.length === 0) {
      return;
    }

    let cancelled = false;
    void sendTerminalKeys(sessionId, `${inlineText} `, bridgeId)
      .then(() => {
        if (!cancelled) {
          setQueuedInsertError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setQueuedInsertError(
            error instanceof Error ? error.message : "Failed to queue terminal input.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeId, pendingInsert, sessionId]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") {
      return;
    }

    window.__conductorSessionTerminalDebug = {
      sessionId,
      getState: () => ({
        mode: "ttyd-xterm",
        expectsLiveTerminal,
        runtimeMode: normalizedRuntimeMode,
        ttydBacked,
        terminalLinkUrl,
        websocketUrl: latestWebSocketUrlRef.current,
        resolvingConnection,
        socketConnected,
        loadingSnapshot,
        connectionError,
        hasOutput,
        promptError,
        queuedInsertError,
      }),
    };

    return () => {
      if (window.__conductorSessionTerminalDebug?.sessionId === sessionId) {
        delete window.__conductorSessionTerminalDebug;
      }
    };
  }, [
    connectionError,
    expectsLiveTerminal,
    hasOutput,
    loadingSnapshot,
    normalizedRuntimeMode,
    promptError,
    queuedInsertError,
    resolvingConnection,
    sessionId,
    socketConnected,
    terminalLinkUrl,
    ttydBacked,
  ]);

  const handlePromptSend = useCallback(async () => {
    const message = promptMessage.trim();
    if (message.length === 0 || promptSending) {
      return;
    }

    setPromptSending(true);
    setPromptError(null);
    try {
      await sendFollowUpMessage(sessionId, message, bridgeId);
      setPromptMessage("");
      promptInputRef.current?.focus();
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setPromptSending(false);
    }
  }, [bridgeId, promptMessage, promptSending, sessionId]);

  const handleRetry = useCallback(() => {
    retryAttemptRef.current = 0;
    hasStreamedOutputRef.current = false;
    clearReconnectTimer();
    closeSocket();
    setConnectionError(null);
    setResolvingConnection(expectsLiveTerminal);
    setConnectionRefreshTick((value) => value + 1);
    setSnapshotRefreshTick((value) => value + 1);
  }, [clearReconnectTimer, closeSocket, expectsLiveTerminal]);

  const emptyStateTitle = expectsLiveTerminal
    ? "Connecting live terminal"
    : showPromptBar
      ? "Session is waiting for input"
      : "Live terminal is not active";
  const emptyStateDescription = connectionError
    ?? (expectsLiveTerminal
      ? "Reconnecting to the existing ttyd terminal."
      : ttydBacked
        ? "This ttyd terminal is no longer attached. It only closes after an explicit kill or archive."
        : showPromptBar
          ? "Send a follow-up below to relaunch the agent in a fresh ttyd terminal."
          : LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus)
            ? "This session no longer exposes a live ttyd terminal. Wait for it to relaunch or open the session overview."
            : `Session status is \`${normalizedSessionStatus}\`. Interactive ttyd terminals only run while the agent is active.`);
  const loadingTerminal = !hasOutput && (
    loadingSnapshot
    || resolvingConnection
    || (expectsLiveTerminal && socketConnected)
  );

  return (
    <div
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 sm:right-3 sm:top-3">
        {terminalLinkUrl ? (
          <a
            href={terminalLinkUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm transition hover:bg-[#201818] sm:h-7 sm:w-7"
            aria-label="Open ttyd terminal in a new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={handleRetry}
          aria-label="Reload ttyd terminal"
        >
          {loadingTerminal ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div
        className={
          immersiveMobileMode
            ? "min-h-0 min-w-0 flex-1 overflow-hidden px-0 pb-0 pt-0 w-full"
            : "min-h-0 min-w-0 flex-1 overflow-hidden px-0.5 pb-0 pt-0.5 lg:px-1.5 lg:pb-1 lg:pt-3 w-full"
        }
      >
        <div className="relative flex h-full flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#060404] text-[#efe8e1]">
          <div
            ref={terminalHostRef}
            className="h-full min-h-0 flex-1 overflow-hidden overscroll-contain px-2 py-2 text-left touch-pan-y [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm]:px-1 [&_.xterm-screen]:h-full [&_.xterm-screen]:w-full [&_.xterm-viewport]:overflow-y-auto [&_.xterm-viewport]:overscroll-contain [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch] [&_.xterm-scrollable-element]:overscroll-contain [&_.xterm-scrollable-element]:[-webkit-overflow-scrolling:touch]"
          />

          {!hasOutput && !loadingTerminal ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 py-12">
              <div className="max-w-lg rounded-[16px] border border-white/10 bg-[#141010]/92 p-5 text-[#efe8e1] shadow-[0_24px_48px_rgba(0,0,0,0.34)] backdrop-blur-sm">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full border border-white/10 bg-[#201818] p-2 text-[#c9c0b7]">
                    {connectionError ? (
                      <AlertCircle className="h-4 w-4" />
                    ) : (
                      <Loader2 className={`h-4 w-4 ${resolvingConnection ? "animate-spin" : ""}`} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{emptyStateTitle}</div>
                    <div className="mt-1 text-[12px] leading-5 text-[#a79c94]">{emptyStateDescription}</div>
                    {terminalLinkUrl ? (
                      <div className="mt-3">
                        <a
                          href={terminalLinkUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12px] text-[#d7c6b7] underline underline-offset-4"
                        >
                          Open the ttyd terminal directly
                        </a>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {loadingTerminal ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#060404]/84">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#141010]/92 px-3 py-2 text-[12px] text-[#c9c0b7] backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{expectsLiveTerminal ? "Connecting live terminal…" : "Loading terminal snapshot…"}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {!showPromptBar && queuedInsertError ? (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/12 bg-[#161212] px-3 py-2 text-[11px] text-[#ffb39e] backdrop-blur-sm [padding-bottom:env(safe-area-inset-bottom)]">
          <div className="flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{queuedInsertError}</span>
            <button
              type="button"
              className="ml-auto shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
              onClick={() => setQueuedInsertError(null)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : null}

      {showPromptBar ? (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/12 bg-[#161212] backdrop-blur-sm [padding-bottom:env(safe-area-inset-bottom)]">
          {queuedInsertError ? (
            <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] text-[#ffb39e]">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{queuedInsertError}</span>
              <button
                type="button"
                className="ml-auto shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
                onClick={() => setQueuedInsertError(null)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          {promptError ? (
            <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] text-[#ff8f7a]">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{promptError}</span>
              <button
                type="button"
                className="ml-auto shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
                onClick={() => setPromptError(null)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handlePromptSend();
            }}
            className="flex items-center gap-2 px-2 py-2 lg:px-3"
          >
            <input
              ref={promptInputRef}
              type="text"
              value={promptMessage}
              onChange={(event) => setPromptMessage(event.target.value)}
              placeholder="Send a follow-up message…"
              enterKeyHint="done"
              disabled={promptSending}
              className="h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-[#0c0808] px-2.5 text-[12px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] focus:border-white/20 disabled:opacity-50"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={promptSending || promptMessage.trim().length === 0}
              className="h-8 w-8 shrink-0 rounded-md border border-white/10 bg-[#0c0808] text-[#c9c0b7] hover:bg-[#201818] disabled:opacity-30"
              aria-label="Send message"
            >
              {promptSending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function SessionTerminalContainer(props: SessionTerminalProps) {
  return <SessionTerminalView {...props} />;
}

export const SessionTerminal = memo(SessionTerminalContainer, sessionTerminalPropsEqual);
