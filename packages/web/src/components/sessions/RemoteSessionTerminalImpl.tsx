"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, Loader2, RefreshCw, Send, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { Button } from "@/components/ui/Button";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";
import { attachMobileTouchScrollShim } from "@/components/sessions/terminal/mobileTouchScroll";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { buildBridgeRepairHref } from "@/lib/bridgeOnboarding";
import { LIVE_TERMINAL_STATUSES, RESUMABLE_STATUSES } from "@/components/sessions/terminal/terminalConstants";
import {
  calculateMobileTerminalViewportMetrics,
  isTerminalScrollHostAtBottom,
  resolveSessionTerminalViewportOptions,
} from "@/components/sessions/sessionTerminalUtils";
import { uploadProjectAttachments } from "@/components/sessions/attachmentUploads";
import {
  extractImageFromClipboard,
  extractFilesFromTransfer,
  uploadClipboardImage,
} from "@/lib/clipboardImage";

const TERMINAL_CLOSED_STATUSES = new Set(["archived", "killed", "terminated", "restored"]);
const CMD_OUTPUT = "0".charCodeAt(0);
const CMD_RESIZE = "1".charCodeAt(0);
const RECONNECT_MAX_DELAY_MS = 4_000;
type TerminalSyncMode = "resize" | "handshake";

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

async function fetchClosedTerminalOutput(
  sessionId: string,
  bridgeId?: string | null,
): Promise<string> {
  const response = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/output?lines=500`, bridgeId),
    {
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => null)) as { output?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Failed to load terminal output (${response.status})`);
  }
  return typeof payload?.output === "string" ? payload.output : "";
}

async function fetchRelayTerminalUrl(
  sessionId: string,
  bridgeId?: string | null,
): Promise<string> {
  const response = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/relay`, bridgeId),
    {
      method: "POST",
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => null)) as { wsUrl?: string; error?: string } | null;
  if (!response.ok || !payload?.wsUrl) {
    throw new Error(payload?.error ?? `Failed to attach relay terminal (${response.status})`);
  }
  return payload.wsUrl;
}

type RelayTerminalAvailability =
  | { available: true }
  | { available: false; reason: string | null };

async function probeRelayTerminalAvailability(
  sessionId: string,
  bridgeId?: string | null,
): Promise<RelayTerminalAvailability> {
  const response = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/token`, bridgeId),
    {
      cache: "no-store",
    },
  );
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (response.ok) {
    return { available: true };
  }
  if (response.status === 404 || response.status === 409) {
    return {
      available: false,
      reason: payload?.error ?? null,
    };
  }
  throw new Error(payload?.error ?? `Failed to resolve relay terminal availability (${response.status})`);
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

export function RemoteSessionTerminal({
  sessionId,
  projectId,
  bridgeId,
  sessionState,
  runtimeMode,
  pendingInsert,
  immersiveMobileMode = false,
}: SessionTerminalProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const geometryRef = useRef({ cols: 120, rows: 32 });
  const lastAppliedInsertNonceRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const scheduledLayoutSyncTimersRef = useRef<number[]>([]);
  const followBottomRef = useRef(true);
  const [hasOutput, setHasOutput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relayUnavailableReason, setRelayUnavailableReason] = useState<string | null>(null);
  const [promptMessage, setPromptMessage] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [queuedInsertError, setQueuedInsertError] = useState<string | null>(null);
  const [connectionTick, setConnectionTick] = useState(0);
  const normalizedSessionStatus = useMemo(
    () => sessionState.trim().toLowerCase(),
    [sessionState],
  );
  const normalizedRuntimeMode = runtimeMode?.trim().toLowerCase() ?? null;
  const sessionClosed = TERMINAL_CLOSED_STATUSES.has(normalizedSessionStatus);
  const ttydBacked = normalizedRuntimeMode === "ttyd";
  const expectsRelayTerminal = ttydBacked
    ? !sessionClosed
    : false;
  const showPromptBar = !ttydBacked && !immersiveMobileMode && RESUMABLE_STATUSES.has(normalizedSessionStatus);
  const showStoredOutput = !expectsRelayTerminal;
  const outputFallbackActive = showStoredOutput || relayUnavailableReason !== null;
  const bridgeRecoveryHref = useMemo(
    () => (bridgeId ? buildBridgeRepairHref(bridgeId) : null),
    [bridgeId],
  );

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

  const clearScheduledLayoutSyncs = useCallback(() => {
    for (const timer of scheduledLayoutSyncTimersRef.current) {
      window.clearTimeout(timer);
    }
    scheduledLayoutSyncTimersRef.current = [];
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

    if (!keyboardVisible) {
      host.style.removeProperty("height");
      return;
    }

    if (usableHeight <= 0) {
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
    geometryRef.current = next;

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
    if (!next) {
      return null;
    }

    geometryRef.current = { cols: next.cols, rows: next.rows };
    if (!expectsRelayTerminal) {
      return next;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return next;
    }

    try {
      if (mode === "handshake") {
        sendHandshake();
      } else if (force || next.changed) {
        socket.send(encodeResizeFrame(next.cols, next.rows));
      }
    } catch {
      // Ignore transient geometry sync failures while reconnecting.
    }

    return next;
  }, [expectsRelayTerminal, fitTerminal, sendHandshake]);

  const scheduleHandshakeRefreshes = useCallback(() => {
    clearScheduledLayoutSyncs();
    if (typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      syncTerminalGeometry("handshake", true);
    });
    scheduledLayoutSyncTimersRef.current.push(
      window.setTimeout(() => {
        syncTerminalGeometry("handshake", true);
      }, 120),
      window.setTimeout(() => {
        syncTerminalGeometry("handshake", true);
      }, 360),
    );
  }, [clearScheduledLayoutSyncs, syncTerminalGeometry]);

  const scheduleReconnect = useCallback(() => {
    if (!expectsRelayTerminal) {
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
  }, [expectsRelayTerminal]);

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
      cursorBlink: expectsRelayTerminal,
      disableStdin: !expectsRelayTerminal,
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
      if (!expectsRelayTerminal) {
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

    const handlePaste = async (event: ClipboardEvent) => {
      if (!expectsRelayTerminal) {
        return;
      }

      const clipboardData = event.clipboardData;
      const imageBlob = extractImageFromClipboard(clipboardData);
      if (!imageBlob) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      try {
        const result = await uploadClipboardImage({
          imageBlob,
          projectId,
          taskRef: sessionId,
          bridgeId,
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
      if (!expectsRelayTerminal) {
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
      if (!expectsRelayTerminal) {
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
          projectId,
          taskRef: sessionId,
          bridgeId,
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
      syncTerminalGeometry("resize", true);
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
  }, [
    applyKeyboardAwareTerminalHeight,
    expectsRelayTerminal,
    projectId,
    sendTerminalFrame,
    syncTerminalGeometry,
    bridgeId,
    sessionId,
  ]);

  useEffect(() => {
    lastAppliedInsertNonceRef.current = 0;
    retryAttemptRef.current = 0;
    followBottomRef.current = true;
    setHasOutput(false);
    setLoading(true);
    setError(null);
    setRelayUnavailableReason(null);
    setPromptMessage("");
    setPromptSending(false);
    setPromptError(null);
    setQueuedInsertError(null);
    decoderRef.current = new TextDecoder();
    if (terminalRef.current) {
      resetTerminalOutput(terminalRef.current, "", true);
      terminalRef.current.options.disableStdin = !expectsRelayTerminal;
      terminalRef.current.options.cursorBlink = expectsRelayTerminal;
    }
    clearScheduledLayoutSyncs();
    closeSocket();
  }, [clearScheduledLayoutSyncs, closeSocket, expectsRelayTerminal, sessionId]);

  useEffect(() => {
    const host = terminalHostRef.current;
    const terminal = terminalRef.current;
    if (!host || !terminal) {
      return;
    }

    terminal.options.disableStdin = !expectsRelayTerminal || socketRef.current?.readyState !== WebSocket.OPEN;
    terminal.options.cursorBlink = expectsRelayTerminal && socketRef.current?.readyState === WebSocket.OPEN;

    const applyGeometry = () => {
      applyKeyboardAwareTerminalHeight();
      syncTerminalGeometry("resize");
    };

    const refreshTerminalLayout = () => {
      if (!expectsRelayTerminal) {
        fitTerminal();
        return;
      }
      syncTerminalGeometry("handshake", true);
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
  }, [expectsRelayTerminal, fitTerminal, syncTerminalGeometry]);

  useEffect(() => {
    if (outputFallbackActive) {
      let cancelled = false;
      setLoading(true);
      void fetchClosedTerminalOutput(sessionId, bridgeId)
        .then((output) => {
          if (cancelled) {
            return;
          }
          if (terminalRef.current) {
            resetTerminalOutput(terminalRef.current, output, true);
          }
          setHasOutput(output.length > 0);
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
    setRelayUnavailableReason(null);

    void probeRelayTerminalAvailability(sessionId, bridgeId)
      .then((availability) => {
        if (cancelled) {
          return;
        }

        if (!availability.available) {
          setRelayUnavailableReason(
            availability.reason ?? "This session no longer exposes a live ttyd terminal.",
          );
          return;
        }

        return fetchRelayTerminalUrl(sessionId, bridgeId).then((wsUrl) => {
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
            setHasOutput(false);
            if (terminalRef.current) {
              resetTerminalOutput(terminalRef.current, "", followBottomRef.current);
              terminalRef.current.options.disableStdin = false;
              terminalRef.current.options.cursorBlink = true;
            }
            try {
              syncTerminalGeometry("handshake", true);
              scheduleHandshakeRefreshes();
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
                  if (followBottomRef.current) {
                    terminal.scrollToBottom();
                  }
                  setHasOutput(true);
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
        });
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
      clearScheduledLayoutSyncs();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closeSocket();
    };
  }, [
    bridgeId,
    clearScheduledLayoutSyncs,
    closeSocket,
    connectionTick,
    scheduleHandshakeRefreshes,
    scheduleReconnect,
    sessionId,
    outputFallbackActive,
    syncTerminalGeometry,
  ]);

  useEffect(() => {
    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    const inlineText = pendingInsert.inlineText.trim();
    if (inlineText.length === 0 || !expectsRelayTerminal) {
      return;
    }

    try {
      sendTerminalFrame(encodeInputFrame(`${inlineText} `));
      setError(null);
      setQueuedInsertError(null);
    } catch (nextError) {
      setQueuedInsertError(nextError instanceof Error ? nextError.message : "Failed to queue terminal input.");
    }
  }, [expectsRelayTerminal, pendingInsert, sendTerminalFrame]);

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
    } catch (nextError) {
      setPromptError(nextError instanceof Error ? nextError.message : "Failed to send message.");
    } finally {
      setPromptSending(false);
    }
  }, [bridgeId, promptMessage, promptSending, sessionId]);

  const handleRetry = useCallback(() => {
    retryAttemptRef.current = 0;
    setError(null);
    setRelayUnavailableReason(null);
    setConnectionTick((value) => value + 1);
  }, []);

  const emptyStateTitle = expectsRelayTerminal
    ? "Connecting live terminal"
    : showPromptBar
      ? "Session is waiting for input"
      : "Live terminal is not active";
  const emptyStateDescription = relayUnavailableReason
    ?? error
    ?? (expectsRelayTerminal
      ? "Reconnecting to the existing relay terminal."
      : ttydBacked
        ? "This ttyd terminal is no longer attached. It only closes after an explicit kill or archive."
        : showPromptBar
          ? "Send a follow-up below to relaunch the agent in a fresh ttyd terminal."
          : LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus)
            ? "This session no longer exposes a relay terminal. Wait for it to relaunch or open the session overview."
            : `Session status is \`${normalizedSessionStatus}\`. Relay terminals only run while a ttyd runtime is active.`);

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
          className="h-full min-h-0 w-full flex-1 overflow-hidden overscroll-contain rounded-[10px] bg-[#060404] px-2 py-2 text-left touch-pan-y [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm]:px-1 [&_.xterm-screen]:h-full [&_.xterm-screen]:w-full [&_.xterm-viewport]:overflow-y-auto [&_.xterm-viewport]:overscroll-contain [&_.xterm-viewport]:[-webkit-overflow-scrolling:touch] [&_.xterm-scrollable-element]:overscroll-contain [&_.xterm-scrollable-element]:[-webkit-overflow-scrolling:touch]"
        />
        {!loading && !hasOutput ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#060404]/84 px-4">
            <div className="max-w-lg rounded-[16px] border border-white/10 bg-[#141010]/92 p-5 text-[#efe8e1] shadow-[0_24px_48px_rgba(0,0,0,0.34)]">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-full border border-white/10 bg-[#201818] p-2 text-[#c9c0b7]">
                  {error ? (
                    <AlertCircle className="h-4 w-4" />
                  ) : (
                    <Loader2 className={`h-4 w-4 ${expectsRelayTerminal ? "animate-spin" : ""}`} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{emptyStateTitle}</div>
                  <div className="mt-1 text-[12px] leading-5 text-[#a79c94]">{emptyStateDescription}</div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#060404]/84">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#141010]/92 px-3 py-2 text-[12px] text-[#c9c0b7] backdrop-blur-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{showStoredOutput ? "Loading terminal output…" : "Connecting relay terminal…"}</span>
            </div>
          </div>
        ) : null}
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

      {error ? (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/12 bg-[#161212] px-3 py-2 text-[11px] text-[#ffb39e] backdrop-blur-sm [padding-bottom:env(safe-area-inset-bottom)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-1.5">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{error}</span>
            </div>
            {bridgeRecoveryHref ? (
              <Link
                href={bridgeRecoveryHref}
                className="shrink-0 text-[11px] font-medium text-[#ffd089] underline underline-offset-2 hover:text-[#fff8f2]"
              >
                Open bridge recovery
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
