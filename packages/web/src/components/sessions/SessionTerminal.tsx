"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, Paperclip, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SUPERSET_TERMINAL_FONT_FAMILY, getSupersetLikeTerminalTheme } from "@/components/terminal/xtermTheme";
import { useSessionFeed } from "@/hooks/useSessionFeed";
import type { TerminalInsertRequest } from "./terminalInsert";

interface SessionTerminalProps {
  sessionId: string;
  agentName: string;
  projectId: string;
  sessionModel: string;
  sessionReasoningEffort: string;
  sessionState: string;
  active: boolean;
  pendingInsert: TerminalInsertRequest | null;
}

type TerminalConnectionInfo = {
  wsUrl: string;
};

type TerminalSnapshot = {
  snapshot: string;
  source: string;
  live: boolean;
  restored: boolean;
};

type TerminalServerEvent =
  | { type: "ready"; sessionId: string }
  | { type: "ack"; sessionId: string; action: string }
  | { type: "exit"; sessionId: string; exitCode: number }
  | { type: "pong"; sessionId: string }
  | { type: "error"; sessionId: string; error: string };

const LIVE_TERMINAL_STATUSES = new Set(["queued", "spawning", "running", "working", "needs_input", "stuck"]);
const RESUMABLE_STATUSES = new Set(["done", "needs_input", "stuck", "errored", "terminated", "killed"]);
const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 1600;
const RENDERER_RECOVERY_THROTTLE_MS = 120;
const LIVE_TERMINAL_SCROLLBACK = 200000;
const READ_ONLY_TERMINAL_SNAPSHOT_LINES = 200000;
const MANAGED_SCROLL_PRIVATE_MODES = new Set([1000, 1002, 1003, 1005, 1006, 1015, 1047, 1048, 1049]);

function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

async function uploadAttachments(files: File[]): Promise<string[]> {
  if (!files.length) return [];

  const uploadedPaths = await Promise.all(files.map(async (file) => {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/attachments", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload ${file.name}`);
    }

    const payload = await response.json();
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const nested = record?.attachment && typeof record.attachment === "object"
      ? record.attachment as Record<string, unknown>
      : null;

    for (const candidate of [
      record?.absolutePath,
      record?.path,
      record?.filePath,
      nested?.absolutePath,
      nested?.path,
      nested?.filePath,
    ]) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    throw new Error(`Attachment response for ${file.name} did not include a file path`);
  }));

  return uploadedPaths.filter(Boolean);
}

async function fetchTerminalConnection(sessionId: string): Promise<TerminalConnectionInfo> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/connection`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as { wsUrl?: string; error?: string } | null;
  if (!response.ok || typeof data?.wsUrl !== "string" || data.wsUrl.trim().length === 0) {
    throw new Error(data?.error ?? `Failed to resolve terminal connection: ${response.status}`);
  }
  return { wsUrl: data.wsUrl.trim() };
}

async function fetchTerminalSnapshot(sessionId: string, lines: number): Promise<TerminalSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?lines=${lines}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { snapshot?: string; source?: string; live?: boolean; restored?: boolean; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal snapshot: ${response.status}`);
  }
  return {
    snapshot: typeof data?.snapshot === "string" ? data.snapshot : "",
    source: typeof data?.source === "string" ? data.source : "empty",
    live: data?.live === true,
    restored: data?.restored === true,
  };
}

function buildTerminalSocketUrl(baseUrl: string, cols: number, rows: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("cols", String(Math.max(1, cols)));
  url.searchParams.set("rows", String(Math.max(1, rows)));
  return url.toString();
}

function normalizeTerminalSnapshot(snapshot: string): string {
  return snapshot.replace(/\r?\n/g, "\r\n");
}

function terminalHasRenderedContent(term: XTerminal): boolean {
  const buffer = term.buffer.active;
  if (buffer.baseY > 0) {
    return true;
  }

  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    if (line.translateToString(true).trim().length > 0) {
      return true;
    }
  }

  return false;
}

function getTerminalViewportOptions(width: number): Pick<ITerminalOptions, "fontFamily" | "fontSize" | "lineHeight"> {
  if (width < 420) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 11,
      lineHeight: 1,
    };
  }

  if (width < 640) {
    return {
      fontFamily: "'SF Mono', Menlo, Monaco, monospace",
      fontSize: 13,
      lineHeight: 1.08,
    };
  }

  return {
    fontFamily: SUPERSET_TERMINAL_FONT_FAMILY,
    fontSize: 17,
    lineHeight: 1.06,
  };
}

export function SessionTerminal({
  sessionId,
  agentName,
  projectId,
  sessionModel,
  sessionReasoningEffort,
  sessionState,
  active,
  pendingInsert,
}: SessionTerminalProps) {
  const router = useRouter();
  const { sessionStatus, refresh } = useSessionFeed(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const searchRef = useRef<XSearchAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectAttemptRef = useRef(0);
  const inputDisposableRef = useRef<IDisposable | null>(null);
  const scrollDisposableRef = useRef<IDisposable | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const latestStatusRef = useRef(sessionState);
  const activeRef = useRef(active);
  const hasConnectedOnceRef = useRef(false);
  const reconnectNoticeWrittenRef = useRef(false);
  const snapshotAppliedRef = useRef<string | null>(null);
  const liveOutputStartedRef = useRef(false);
  const previousLiveTerminalRef = useRef(false);
  const recoveryFrameRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryLastRunRef = useRef(0);
  const recoveryPendingResizeRef = useRef(false);
  const visibilityRecoveryTimersRef = useRef<number[]>([]);
  const lastAppliedInsertNonceRef = useRef<number>(0);

  const [terminalReady, setTerminalReady] = useState(false);
  const [socketBaseUrl, setSocketBaseUrl] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Array<{ file: File }>>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [snapshotAnsi, setSnapshotAnsi] = useState("");

  const normalizedSessionStatus = useMemo(
    () => {
      const candidate = typeof sessionStatus === "string" && sessionStatus.trim().length > 0
        ? sessionStatus
        : sessionState;
      return candidate.trim().toLowerCase();
    },
    [sessionState, sessionStatus],
  );
  latestStatusRef.current = normalizedSessionStatus;
  activeRef.current = active;

  const expectsLiveTerminal = LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus);
  const showResumeRail = RESUMABLE_STATUSES.has(normalizedSessionStatus) && !expectsLiveTerminal;
  const railPlaceholder = normalizedSessionStatus === "done"
    ? "Continue the session..."
    : normalizedSessionStatus === "needs_input" || normalizedSessionStatus === "stuck"
      ? "Answer the agent and resume..."
      : "Restart this session with a follow-up...";

  const normalizeWhitespaceOnlyDraft = useCallback(() => {
    setMessage((current) => (current.trim().length === 0 ? "" : current));
  }, []);

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
  }, [clearReconnectTimer]);

  const requestReconnect = useCallback(() => {
    clearReconnectTimer();
    setTransportError(null);
    setConnectionState("connecting");
    setSocketBaseUrl(null);
    setReconnectToken((value) => value + 1);
  }, [clearReconnectTimer]);

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "resize",
      cols: Math.max(1, term.cols),
      rows: Math.max(1, term.rows),
    }));
  }, []);

  const sendTerminalKeys = useCallback((data: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Terminal is not connected");
    }
    socket.send(JSON.stringify({ type: "keys", keys: data }));
  }, []);

  const updateScrollState = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      setShowScrollToBottom(false);
      return;
    }
    const buffer = term.buffer.active;
    setShowScrollToBottom(buffer.viewportY < buffer.baseY);
  }, []);

  const clearScheduledRecovery = useCallback(() => {
    if (recoveryFrameRef.current !== null) {
      window.cancelAnimationFrame(recoveryFrameRef.current);
      recoveryFrameRef.current = null;
    }
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryPendingResizeRef.current = false;
  }, []);

  const clearVisibilityRecoveryTimers = useCallback(() => {
    for (const timer of visibilityRecoveryTimersRef.current) {
      window.clearTimeout(timer);
    }
    visibilityRecoveryTimersRef.current = [];
  }, []);

  const runRendererRecovery = useCallback((forceResize: boolean) => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) {
      return;
    }

    const style = window.getComputedStyle(container);
    if (style.display === "none" || style.visibility === "hidden") {
      return;
    }

    const rect = container.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return;
    }

    const previousCols = term.cols;
    const previousRows = term.rows;
    const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;

    try {
      fit.fit();
    } catch {
      return;
    }

    if (forceResize) {
      term.refresh(0, Math.max(0, term.rows - 1));
    }

    if (forceResize || term.cols !== previousCols || term.rows !== previousRows) {
      sendResize();
    }

    if (wasAtBottom) {
      term.scrollToBottom();
    }

    updateScrollState();
    if (activeRef.current) {
      term.focus();
    }
  }, [sendResize, updateScrollState]);

  const scheduleRendererRecovery = useCallback((forceResize: boolean) => {
    recoveryPendingResizeRef.current ||= forceResize;
    if (recoveryFrameRef.current !== null) {
      return;
    }

    recoveryFrameRef.current = window.requestAnimationFrame(() => {
      recoveryFrameRef.current = null;

      const now = Date.now();
      if (now - recoveryLastRunRef.current < RENDERER_RECOVERY_THROTTLE_MS) {
        const remaining = RENDERER_RECOVERY_THROTTLE_MS - (now - recoveryLastRunRef.current);
        if (recoveryTimerRef.current !== null) {
          window.clearTimeout(recoveryTimerRef.current);
        }
        recoveryTimerRef.current = window.setTimeout(() => {
          recoveryTimerRef.current = null;
          scheduleRendererRecovery(recoveryPendingResizeRef.current);
        }, remaining + 1);
        return;
      }

      recoveryLastRunRef.current = now;
      const shouldForceResize = recoveryPendingResizeRef.current;
      recoveryPendingResizeRef.current = false;
      runRendererRecovery(shouldForceResize);
    });
  }, [runRendererRecovery]);

  const queueResumeAttachments = useCallback((files: File[]) => {
    if (!files.length) return;
    setAttachments((current) => [
      ...current,
      ...files.map((file) => ({ file })),
    ]);
  }, []);

  const injectFilesIntoTerminal = useCallback(async (files: File[]) => {
    const uploadedPaths = await uploadAttachments(files);
    if (!uploadedPaths.length) return;
    const escaped = shellEscapePaths(uploadedPaths);
    sendTerminalKeys(escaped);
  }, [sendTerminalKeys]);

  const handleIncomingFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setSendError(null);
    try {
      if (expectsLiveTerminal && connectionState === "live") {
        await injectFilesIntoTerminal(files);
        return;
      }
      queueResumeAttachments(files);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to process files");
    }
  }, [connectionState, expectsLiveTerminal, injectFilesIntoTerminal, queueResumeAttachments]);

  useEffect(() => {
    const wasLiveTerminal = previousLiveTerminalRef.current;
    previousLiveTerminalRef.current = expectsLiveTerminal;
    if (wasLiveTerminal && !expectsLiveTerminal) {
      snapshotAppliedRef.current = null;
      liveOutputStartedRef.current = false;
    }
  }, [expectsLiveTerminal]);

  useEffect(() => {
    hasConnectedOnceRef.current = false;
    reconnectNoticeWrittenRef.current = false;
    snapshotAppliedRef.current = null;
    liveOutputStartedRef.current = false;
    reconnectCountRef.current = 0;
    connectAttemptRef.current = 0;
    lastAppliedInsertNonceRef.current = 0;
    clearReconnectTimer();
    clearScheduledRecovery();
    socketRef.current?.close();
    socketRef.current = null;
    setSocketBaseUrl(null);
    setConnectionState("connecting");
    setTransportError(null);
    setMessage("");
    setAttachments([]);
    setSending(false);
    setSendError(null);
    setDragActive(false);
    setSearchOpen(false);
    setSearchQuery("");
    setShowScrollToBottom(false);
    setSnapshotReady(false);
    setSnapshotAnsi("");
    termRef.current?.reset();
    updateScrollState();
  }, [clearReconnectTimer, clearScheduledRecovery, sessionId, updateScrollState]);

  useEffect(() => {
    let mounted = true;
    setSnapshotReady(false);
    setSnapshotAnsi("");

    if (expectsLiveTerminal) {
      setSnapshotReady(true);
      return () => {
        mounted = false;
      };
    }

    void (async () => {
      try {
        const snapshot = await fetchTerminalSnapshot(sessionId, READ_ONLY_TERMINAL_SNAPSHOT_LINES);
        if (!mounted) return;
        setSnapshotAnsi(snapshot.snapshot);
      } catch {
        if (!mounted) return;
        setSnapshotAnsi("");
      } finally {
        if (mounted) {
          setSnapshotReady(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [expectsLiveTerminal, sessionId]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        setSocketBaseUrl(null);
        const connection = await fetchTerminalConnection(sessionId);
        if (!mounted) return;
        setSocketBaseUrl(connection.wsUrl);
        setTransportError(null);
      } catch (err) {
        if (!mounted) return;
        setTransportError(err instanceof Error ? err.message : "Failed to resolve terminal connection");
        setConnectionState("error");
      }
    })();

    return () => {
      mounted = false;
    };
  }, [reconnectToken, sessionId]);

  useEffect(() => {
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let mounted = true;

    async function init() {
      if (!containerRef.current || !mounted) return;

      const [xtermMod, fitMod, searchMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
      ]);

      if (!mounted || !containerRef.current) return;

      const isLight = document.documentElement.classList.contains("light");
      const viewportOptions = getTerminalViewportOptions(window.innerWidth);
      const terminalOptions: ITerminalOptions & { scrollbar?: { showScrollbar: boolean } } = {
        allowTransparency: false,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: false,
        drawBoldTextInBrightColors: true,
        fontFamily: viewportOptions.fontFamily,
        fontSize: viewportOptions.fontSize,
        fastScrollSensitivity: 4,
        lineHeight: viewportOptions.lineHeight,
        scrollSensitivity: 1.1,
        scrollback: LIVE_TERMINAL_SCROLLBACK,
        theme: getSupersetLikeTerminalTheme(isLight),
        scrollbar: {
          showScrollbar: false,
        },
      };
      term = new xtermMod.Terminal(terminalOptions);
      const registerManagedScrollMode = (final: "h" | "l") => {
        term?.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
          const hasManagedMode = params.some((param) => (
            Array.isArray(param)
              ? param.some((value) => MANAGED_SCROLL_PRIVATE_MODES.has(value))
              : MANAGED_SCROLL_PRIVATE_MODES.has(param)
          ));
          if (!hasManagedMode) {
            return false;
          }
          return true;
        });
      };
      const handleManagedWheel = (event: WheelEvent): boolean => {
        const normalizedDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY
          : event.deltaY / 14;
        const scrollLines = normalizedDelta === 0
          ? 0
          : normalizedDelta > 0
            ? Math.max(1, Math.round(normalizedDelta))
            : Math.min(-1, Math.round(normalizedDelta));
        if (scrollLines === 0) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        term?.scrollLines(scrollLines);
        updateScrollState();
        return false;
      };
      registerManagedScrollMode("h");
      registerManagedScrollMode("l");
      term.attachCustomWheelEventHandler(handleManagedWheel);

      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      const searchAddon = new searchMod.SearchAddon();
      term.loadAddon(searchAddon);
      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = searchAddon;
      setTerminalReady(true);
      updateScrollState();

      inputDisposableRef.current = term.onData((data) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "keys", keys: data }));
      });
      scrollDisposableRef.current = term.onScroll(() => {
        updateScrollState();
      });

      resizeObserverRef.current = new ResizeObserver(() => {
        if (!activeRef.current || !term) {
          return;
        }
        try {
          const nextViewportOptions = getTerminalViewportOptions(window.innerWidth);
          term.options.fontFamily = nextViewportOptions.fontFamily;
          term.options.fontSize = nextViewportOptions.fontSize;
          term.options.lineHeight = nextViewportOptions.lineHeight;
        } catch {
          return;
        }
        scheduleRendererRecovery(true);
      });
      resizeObserverRef.current.observe(containerRef.current);
    }

    void init();

    return () => {
      mounted = false;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      setTerminalReady(false);
    };
  }, [scheduleRendererRecovery, sendResize, updateScrollState]);

  useEffect(() => {
    if (!active) {
      return;
    }

    clearVisibilityRecoveryTimers();
    const frameHandle = window.requestAnimationFrame(() => {
      scheduleRendererRecovery(true);
      visibilityRecoveryTimersRef.current.push(window.setTimeout(() => {
        scheduleRendererRecovery(true);
      }, 48));
      visibilityRecoveryTimersRef.current.push(window.setTimeout(() => {
        scheduleRendererRecovery(true);
      }, 140));
    });

    return () => {
      window.cancelAnimationFrame(frameHandle);
      clearVisibilityRecoveryTimers();
    };
  }, [active, clearVisibilityRecoveryTimers, scheduleRendererRecovery]);

  useEffect(() => {
    if (!terminalReady || !snapshotReady) {
      return;
    }

    const term = termRef.current;
    if (!term || snapshotAppliedRef.current === sessionId) {
      return;
    }

    if (expectsLiveTerminal && (liveOutputStartedRef.current || terminalHasRenderedContent(term))) {
      snapshotAppliedRef.current = sessionId;
      updateScrollState();
      return;
    }

    snapshotAppliedRef.current = sessionId;
    if (snapshotAnsi.length > 0) {
      term.reset();
      term.write(normalizeTerminalSnapshot(snapshotAnsi), () => {
        if (termRef.current !== term) {
          return;
        }
        updateScrollState();
        if (activeRef.current) {
          try {
            term.focus();
          } catch {
            // Terminal may have been disposed while the write callback was queued.
          }
        }
      });
      return;
    }

    updateScrollState();
  }, [sessionId, snapshotAnsi, snapshotReady, terminalReady, updateScrollState]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        return;
      }
      normalizeWhitespaceOnlyDraft();
      scheduleRendererRecovery(false);
    };

    const handleWindowFocus = () => {
      normalizeWhitespaceOnlyDraft();
      scheduleRendererRecovery(false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [normalizeWhitespaceOnlyDraft, scheduleRendererRecovery]);

  useEffect(() => {
    if (!terminalReady || !socketBaseUrl || !termRef.current || !expectsLiveTerminal) return;

    const term = termRef.current;
    const socketUrl = buildTerminalSocketUrl(socketBaseUrl, term.cols, term.rows);
    const attemptId = connectAttemptRef.current + 1;
    connectAttemptRef.current = attemptId;
    clearReconnectTimer();
    setConnectionState("connecting");

    const socket = new WebSocket(socketUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      if (connectAttemptRef.current !== attemptId) return;
      reconnectCountRef.current = 0;
      setTransportError(null);
      setConnectionState("live");
      const wasReconnect = hasConnectedOnceRef.current;
      hasConnectedOnceRef.current = true;
      reconnectNoticeWrittenRef.current = false;
      if (wasReconnect) {
        term.writeln("\r\n\x1b[90m[Reconnected]\x1b[0m");
      }
      updateScrollState();
      scheduleRendererRecovery(true);
    };

    socket.onmessage = (event) => {
      if (connectAttemptRef.current !== attemptId) return;

      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data) as TerminalServerEvent;
          if (payload.type === "error") {
            setTransportError(payload.error);
            setConnectionState("error");
          } else if (payload.type === "exit") {
            setConnectionState("closed");
          }
        } catch {
          setTransportError("Received an invalid terminal event");
          setConnectionState("error");
        }
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        liveOutputStartedRef.current = true;
        const shouldFollow = term.buffer.active.viewportY >= term.buffer.active.baseY;
        term.write(new Uint8Array(event.data), () => {
          if (termRef.current !== term) {
            return;
          }
          if (shouldFollow) {
            try {
              term.scrollToBottom();
            } catch {
              return;
            }
          }
          updateScrollState();
        });
      }
    };

    socket.onclose = () => {
      if (connectAttemptRef.current !== attemptId) return;
      socketRef.current = null;
      const shouldRetry = LIVE_TERMINAL_STATUSES.has(latestStatusRef.current);
      if (shouldRetry) {
        const currentTerm = termRef.current;
        if (currentTerm && hasConnectedOnceRef.current && !reconnectNoticeWrittenRef.current) {
          reconnectNoticeWrittenRef.current = true;
          currentTerm.writeln("\r\n\x1b[90m[Connection lost. Reconnecting...]\x1b[0m");
        }
        setConnectionState("connecting");
        setSocketBaseUrl(null);
        scheduleReconnect();
        return;
      }
      setConnectionState("closed");
    };

    socket.onerror = () => {
      if (connectAttemptRef.current !== attemptId) return;
      setTransportError("Terminal connection failed");
      setConnectionState("error");
    };

    return () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, [clearReconnectTimer, expectsLiveTerminal, reconnectToken, scheduleReconnect, scheduleRendererRecovery, socketBaseUrl, terminalReady, updateScrollState]);

  useEffect(() => {
    if (!terminalReady || !snapshotReady || !expectsLiveTerminal) {
      return;
    }

    const socket = socketRef.current;
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }

    if (connectionState !== "closed" && connectionState !== "error") {
      return;
    }

    if (reconnectTimerRef.current !== null) {
      return;
    }

    scheduleReconnect();
  }, [connectionState, expectsLiveTerminal, scheduleReconnect, snapshotReady, terminalReady]);

  useEffect(() => () => {
    clearReconnectTimer();
    clearScheduledRecovery();
    clearVisibilityRecoveryTimers();
    socketRef.current?.close();
  }, [clearReconnectTimer, clearScheduledRecovery, clearVisibilityRecoveryTimers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files ?? []);
      const hasText = (clipboard.getData("text/plain") ?? "").length > 0;
      if (!files.length || hasText) {
        return;
      }

      event.preventDefault();
      void handleIncomingFiles(files);
    };

    container.addEventListener("paste", handlePaste, { capture: true });
    return () => {
      container.removeEventListener("paste", handlePaste, { capture: true });
    };
  }, [handleIncomingFiles]);

  const handleSend = useCallback(async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && attachments.length === 0) return;

    setSending(true);
    setSendError(null);

    try {
      const attachmentPaths = await uploadAttachments(attachments.map((attachment) => attachment.file));

      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmedMessage,
          attachments: attachmentPaths,
          model: sessionModel || null,
          reasoningEffort: sessionReasoningEffort || null,
          projectId: projectId || null,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string; sessionId?: string | null }
        | null;

      if (!response.ok) {
        throw new Error(data?.error ?? `Failed to send message: ${response.status}`);
      }

      setMessage("");
      setAttachments([]);
      if (data?.sessionId && data.sessionId !== sessionId) {
        router.push(`/sessions/${encodeURIComponent(data.sessionId)}`);
        return;
      }
      setReconnectToken((value) => value + 1);
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to resume session");
    } finally {
      setSending(false);
    }
  }, [attachments, message, projectId, refresh, router, sessionId, sessionModel, sessionReasoningEffort]);

  useEffect(() => {
    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    setSendError(null);

    if (expectsLiveTerminal && connectionState === "live") {
      try {
        const inlineText = pendingInsert.inlineText.trim();
        if (inlineText.length > 0) {
          sendTerminalKeys(`${inlineText} `);
        }
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Failed to insert preview context into terminal");
      }
      return;
    }

    const draftText = pendingInsert.draftText.trim();
    if (draftText.length === 0) {
      return;
    }

    setMessage((current) => (current.trim().length > 0 ? `${current}\n\n${draftText}` : draftText));
  }, [connectionState, expectsLiveTerminal, pendingInsert, sendTerminalKeys]);

  const runSearch = useCallback((direction: "next" | "prev") => {
    const addon = searchRef.current;
    if (!addon || searchQuery.trim().length === 0) {
      return;
    }
    if (direction === "next") {
      addon.findNext(searchQuery, { incremental: true, caseSensitive: false });
    } else {
      addon.findPrevious(searchQuery, { incremental: true, caseSensitive: false });
    }
  }, [searchQuery]);

  const scrollToBottom = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.scrollToBottom();
    updateScrollState();
    if (activeRef.current) {
      term.focus();
    }
  }, [updateScrollState]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    if (activeRef.current) {
      termRef.current?.focus();
    }
  }, []);

  return (
    <div
      className="group/terminal relative flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-white/10 bg-[#060404] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        const plainText = event.dataTransfer.getData("text/plain").trim();
        if (files.length > 0) {
          void handleIncomingFiles(files);
          return;
        }
        if (!plainText) return;
        try {
          if (expectsLiveTerminal && connectionState === "live") {
            const payload = plainText.startsWith("/") ? shellEscapePath(plainText) : plainText;
            sendTerminalKeys(payload);
            return;
          }
          setMessage((current) => current.length > 0 ? `${current}\n${plainText}` : plainText);
        } catch (err) {
          setSendError(err instanceof Error ? err.message : "Failed to write drop payload");
        }
      }}
    >
      {searchOpen ? (
        <div className="absolute right-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur sm:right-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)]">
          <Search className="h-3.5 w-3.5 text-[#8e847d]" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "prev" : "next");
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find"
            className="h-6 w-20 min-w-0 bg-transparent px-2 text-[11px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] sm:w-28 sm:text-[12px]"
          />
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={() => runSearch("prev")} aria-label="Find previous">
            <span className="text-[11px]">↑</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={() => runSearch("next")} aria-label="Find next">
            <span className="text-[11px]">↓</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={closeSearch} aria-label="Close search">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className={`absolute right-2 top-2 z-10 flex items-center gap-1.5 transition-opacity sm:right-3 sm:top-3 sm:gap-2 ${
          connectionState === "live" ? "opacity-0 group-hover/terminal:opacity-100 focus-within:opacity-100" : "opacity-100"
        }`}>
          {connectionState !== "live" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={`pointer-events-auto h-7 w-7 rounded-full border backdrop-blur-sm sm:h-8 sm:w-8 ${
                transportError
                  ? "border-[#ff8f7a]/25 bg-[#2a1616]/92 text-[#ff8f7a] hover:bg-[#351b1b]"
                  : "border-white/10 bg-[#141010]/92 text-[#c9c0b7] hover:bg-[#201818]"
              }`}
              onClick={requestReconnect}
              aria-label="Reconnect"
            >
              {connectionState === "connecting"
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : transportError
                  ? <AlertCircle className="h-3.5 w-3.5" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="pointer-events-auto h-7 w-7 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-8 sm:w-8"
            onClick={() => setSearchOpen(true)}
            aria-label="Search terminal"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden px-0.5 pb-1 pt-2 sm:px-1.5 sm:pb-1.5 sm:pt-3">
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>

      {showScrollToBottom ? (
        <div className={`pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 ${showResumeRail ? "bottom-24" : "bottom-4"}`}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="pointer-events-auto h-9 rounded-full border border-white/10 bg-[#141010]/92 px-3 text-[#efe8e1] shadow-[0_14px_28px_rgba(0,0,0,0.38)] backdrop-blur-sm hover:bg-[#201818]"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <ChevronDown className="h-4 w-4" />
            <span className="ml-1 text-[11px] uppercase tracking-[0.16em]">Jump to latest</span>
          </Button>
        </div>
      ) : null}

      {dragActive ? (
        <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-[18px] border border-dashed border-white/20 bg-black/55">
          <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-[12px] text-[#efe8e1]">
            {expectsLiveTerminal
              ? "Drop files or screenshots to insert uploaded paths into the terminal"
              : "Drop files or screenshots to attach them before resuming"}
          </span>
        </div>
      ) : null}

      {showResumeRail ? (
        <div className="border-t border-white/8 bg-[#0b0808]/98 px-3 py-3">
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map(({ file }) => (
                <button
                  key={`${file.name}-${file.lastModified}`}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/6 px-2.5 py-1 text-[11px] text-[#d7cec7]"
                  onClick={() => {
                    setAttachments((current) => current.filter((attachment) => attachment.file !== file));
                  }}
                >
                  <Paperclip className="h-3 w-3" />
                  {file.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <textarea
              ref={resumeTextareaRef}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onFocus={() => {
                normalizeWhitespaceOnlyDraft();
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={railPlaceholder}
              className="min-h-[52px] flex-1 resize-none rounded-[14px] border border-white/10 bg-black/35 px-3 py-2 text-[13px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] focus:border-white/20"
            />
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) {
                  queueResumeAttachments(files);
                }
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="rounded-full border border-white/12 bg-white/6 p-2 text-[#d7cec7] transition hover:bg-white/10"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-full border border-[#f3f0ea]/12 bg-[#f3f0ea] px-4 py-2 text-[12px] font-medium text-[#0d0909] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={sending || (!message.trim() && attachments.length === 0)}
              onClick={() => {
                void handleSend();
              }}
            >
              {sending ? "Starting..." : "Resume"}
            </button>
          </div>

          {sendError ? (
            <p className="mt-2 text-[12px] text-[#ff8f7a]">{sendError}</p>
          ) : null}
        </div>
      ) : sendError ? (
        <div className="absolute bottom-3 left-3 rounded-full border border-[#ff8f7a]/30 bg-[#1d1111]/90 px-3 py-1.5 text-[12px] text-[#ff8f7a] backdrop-blur-sm">
          {sendError}
        </div>
      ) : null}
    </div>
  );
}

export default SessionTerminal;
