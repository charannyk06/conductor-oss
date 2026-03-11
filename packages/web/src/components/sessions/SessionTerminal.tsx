"use client";

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, Paperclip, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SUPERSET_TERMINAL_FONT_FAMILY, getSupersetLikeTerminalTheme } from "@/components/terminal/xtermTheme";
import { extractLocalFileTransferPath, uploadProjectAttachments } from "./attachmentUploads";
import { captureTerminalViewport, restoreTerminalViewport } from "./terminalViewport";
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
  transport: "websocket" | "snapshot";
  wsUrl: string | null;
  pollIntervalMs: number;
  interactive: boolean;
  requiresToken: boolean;
  tokenExpiresInSeconds: number | null;
  fallbackReason: string | null;
};

type TerminalSnapshot = {
  snapshot: string;
  source: string;
  live: boolean;
  restored: boolean;
};

type TerminalServerEvent =
  | { type: "ready"; sessionId: string }
  | { type: "snapshot"; sessionId: string; reason: "attach" | "lagged" }
  | { type: "ack"; sessionId: string; action: string }
  | { type: "exit"; sessionId: string; exitCode: number }
  | { type: "pong"; sessionId: string }
  | { type: "error"; sessionId: string; error: string };

const LIVE_TERMINAL_STATUSES = new Set(["queued", "spawning", "running", "working", "needs_input", "stuck"]);
const RESUMABLE_STATUSES = new Set(["done", "needs_input", "stuck", "errored", "terminated", "killed"]);
const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 1600;
const RENDERER_RECOVERY_THROTTLE_MS = 120;
const LIVE_TERMINAL_SCROLLBACK = 50000;
const LIVE_TERMINAL_SNAPSHOT_LINES = 1200;
const READ_ONLY_TERMINAL_SNAPSHOT_LINES = 6000;
const MOBILE_TERMINAL_ACCESSORY_MAX_WIDTH_PX = 1024;
const MANAGED_SCROLL_PRIVATE_MODES = new Set([1000, 1002, 1003, 1005, 1006, 1015, 1047, 1048, 1049]);
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;
const BROWSER_TERMINAL_RESPONSE_PATTERNS = [
  /\x1b\[(?:I|O)/g,
  /\x1b\[\d+;\d+R/g,
  /\x1b\[(?:[?>])[\d;]*c/g,
  /\x1b\](?:10|11|12|4;\d+);[\s\S]*?(?:\x07|\x1b\\)/g,
];
const LIVE_TERMINAL_HELPER_KEYS = [
  { label: "Enter", special: "Enter" },
  { label: "Tab", special: "Tab" },
  { label: "Esc", special: "Escape" },
  { label: "Bksp", special: "Backspace" },
  { label: "Left", special: "ArrowLeft" },
  { label: "Right", special: "ArrowRight" },
  { label: "Up", special: "ArrowUp" },
  { label: "Down", special: "ArrowDown" },
  { label: "Ctrl+C", special: "C-c" },
  { label: "Ctrl+D", special: "C-d" },
] as const;

type PreferredFocusTarget = "none" | "terminal" | "live-input" | "resume";

function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

async function fetchTerminalConnection(sessionId: string): Promise<TerminalConnectionInfo> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/connection`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | {
        transport?: "websocket" | "snapshot";
        wsUrl?: string | null;
        pollIntervalMs?: number;
        interactive?: boolean;
        requiresToken?: boolean;
        tokenExpiresInSeconds?: number | null;
        fallbackReason?: string | null;
        error?: string;
      }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal connection: ${response.status}`);
  }
  const transport = data?.transport === "snapshot" ? "snapshot" : "websocket";
  const pollIntervalMs = typeof data?.pollIntervalMs === "number" && Number.isFinite(data.pollIntervalMs) && data.pollIntervalMs >= 100
    ? Math.round(data.pollIntervalMs)
    : DEFAULT_REMOTE_POLL_INTERVAL_MS;
  const interactive = data?.interactive === true;
  const requiresToken = data?.requiresToken === true;
  const tokenExpiresInSeconds = typeof data?.tokenExpiresInSeconds === "number" && Number.isFinite(data.tokenExpiresInSeconds)
    ? Math.round(data.tokenExpiresInSeconds)
    : null;
  const fallbackReason = typeof data?.fallbackReason === "string" && data.fallbackReason.trim().length > 0
    ? data.fallbackReason.trim()
    : null;

  if (transport === "websocket") {
    if (typeof data?.wsUrl !== "string" || data.wsUrl.trim().length === 0) {
      throw new Error("Terminal connection did not include a websocket URL");
    }
    return {
      transport,
      wsUrl: data.wsUrl.trim(),
      pollIntervalMs,
      interactive,
      requiresToken,
      tokenExpiresInSeconds,
      fallbackReason,
    };
  }

  return {
    transport,
    wsUrl: null,
    pollIntervalMs,
    interactive,
    requiresToken,
    tokenExpiresInSeconds,
    fallbackReason,
  };
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

async function fetchLiveTerminalSnapshot(sessionId: string, lines: number): Promise<TerminalSnapshot> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?lines=${lines}&live=1`,
    {
      cache: "no-store",
    },
  );
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

async function fetchSessionStatus(sessionId: string): Promise<string | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to load session: ${response.status}`);
  }

  const data = (await response.json().catch(() => null)) as { status?: unknown } | null;
  return typeof data?.status === "string" && data.status.trim().length > 0
    ? data.status.trim()
    : null;
}

async function postSessionTerminalKeys(
  sessionId: string,
  body: { keys?: string; special?: string },
): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to send terminal input: ${response.status}`);
  }
}

async function postTerminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/resize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cols: Math.max(1, Math.round(cols)),
      rows: Math.max(1, Math.round(rows)),
    }),
  });
  if (response.status === 404) {
    // Older backends do not expose the resize endpoint yet. Keep remote terminals usable.
    return;
  }
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resize terminal: ${response.status}`);
  }
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

function stripBrowserTerminalResponses(data: string): string {
  let sanitized = data;
  for (const pattern of BROWSER_TERMINAL_RESPONSE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized;
}

function localFileTransferError(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.includes("/temporaryitems/") || normalized.includes("nsird_screencaptureui")) {
    return "macOS exposed only a temporary screenshot path. Paste the screenshot or drop the saved file from Finder so Conductor can upload it cleanly.";
  }

  return "The browser exposed only a local file path for this drop. Use paste or the attach button so Conductor can upload the file instead of injecting raw path text.";
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

function shouldShowTerminalAccessoryBar(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const touchCapable = navigator.maxTouchPoints > 0;
  return window.innerWidth < MOBILE_TERMINAL_ACCESSORY_MAX_WIDTH_PX && (coarsePointer || touchCapable);
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
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const searchRef = useRef<XSearchAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const terminalHttpQueueRef = useRef<Promise<void>>(Promise.resolve());
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
  const lastLiveSnapshotRef = useRef("");
  const liveOutputStartedRef = useRef(false);
  const previousLiveTerminalRef = useRef(false);
  const recoveryFrameRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryLastRunRef = useRef(0);
  const recoveryPendingResizeRef = useRef(false);
  const visibilityRecoveryTimersRef = useRef<number[]>([]);
  const lastAppliedInsertNonceRef = useRef<number>(0);
  const lastSyncedTerminalSizeRef = useRef<string | null>(null);
  const pendingResizeSyncRef = useRef(true);
  const preferredFocusTargetRef = useRef<PreferredFocusTarget>("none");
  const restoreFocusOnRecoveryRef = useRef(false);
  const pendingSocketBinaryModeRef = useRef<"stream" | "snapshot">("stream");

  const [terminalReady, setTerminalReady] = useState(false);
  const [transportMode, setTransportMode] = useState<"websocket" | "snapshot">("websocket");
  const [socketBaseUrl, setSocketBaseUrl] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(DEFAULT_REMOTE_POLL_INTERVAL_MS);
  const [interactiveTerminal, setInteractiveTerminal] = useState(true);
  const [transportNotice, setTransportNotice] = useState<string | null>(null);
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
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const [sessionStatusOverride, setSessionStatusOverride] = useState<string | null>(null);
  const [showTerminalAccessoryBar, setShowTerminalAccessoryBar] = useState(() => shouldShowTerminalAccessoryBar());

  const normalizedSessionStatus = useMemo(
    () => {
      const candidate = typeof sessionStatusOverride === "string" && sessionStatusOverride.trim().length > 0
        ? sessionStatusOverride
        : sessionState;
      return candidate.trim().toLowerCase();
    },
    [sessionState, sessionStatusOverride],
  );
  latestStatusRef.current = normalizedSessionStatus;
  activeRef.current = active;

  const expectsLiveTerminal = LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus);
  const shouldStreamLiveTerminal = expectsLiveTerminal && active && pageVisible;
  const showResumeRail = RESUMABLE_STATUSES.has(normalizedSessionStatus) && !expectsLiveTerminal;
  const showSnapshotFallbackRail = expectsLiveTerminal && interactiveTerminal && transportMode === "snapshot";
  const showLiveInputRail = showSnapshotFallbackRail;
  const showLiveHelperBar = expectsLiveTerminal && interactiveTerminal && showTerminalAccessoryBar && transportMode === "websocket";
  const railPlaceholder = normalizedSessionStatus === "done"
    ? "Continue the session..."
    : normalizedSessionStatus === "needs_input" || normalizedSessionStatus === "stuck"
      ? "Answer the agent and resume..."
      : "Restart this session with a follow-up...";
  const canSendLiveInput = expectsLiveTerminal && interactiveTerminal && connectionState === "live";

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
    pendingResizeSyncRef.current = true;
    pendingSocketBinaryModeRef.current = "stream";
    setTransportError(null);
    setTransportNotice(null);
    setConnectionState("connecting");
    setTransportMode("websocket");
    setSocketBaseUrl(null);
    setReconnectToken((value) => value + 1);
  }, [clearReconnectTimer]);

  const enqueueTerminalHttpOperation = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = terminalHttpQueueRef.current
      .catch(() => undefined)
      .then(operation);
    terminalHttpQueueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const sendResize = useCallback(async (cols: number, rows: number): Promise<boolean> => {
    if (transportMode === "snapshot") {
      await enqueueTerminalHttpOperation(() => postTerminalResize(sessionId, cols, rows));
      return true;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify({
      type: "resize",
      cols: Math.max(1, Math.round(cols)),
      rows: Math.max(1, Math.round(rows)),
    }));
    return true;
  }, [enqueueTerminalHttpOperation, sessionId, transportMode]);

  const sendTerminalKeys = useCallback(async (data: string) => {
    if (!interactiveTerminal) {
      throw new Error("Operator access is required for live terminal input");
    }
    const keys = stripBrowserTerminalResponses(data);
    if (keys.length === 0) {
      return;
    }

    if (transportMode === "snapshot") {
      await enqueueTerminalHttpOperation(() => postSessionTerminalKeys(sessionId, { keys }));
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Terminal is not connected");
    }
    socket.send(JSON.stringify({ type: "keys", keys }));
  }, [enqueueTerminalHttpOperation, interactiveTerminal, sessionId, transportMode]);

  const sendTerminalSpecial = useCallback(async (special: string) => {
    if (!interactiveTerminal) {
      throw new Error("Operator access is required for live terminal input");
    }

    if (transportMode === "snapshot") {
      await enqueueTerminalHttpOperation(() => postSessionTerminalKeys(sessionId, { special }));
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Terminal is not connected");
    }
    socket.send(JSON.stringify({ type: "keys", special }));
  }, [enqueueTerminalHttpOperation, interactiveTerminal, sessionId, transportMode]);

  const detectFocusedSurface = useCallback((): PreferredFocusTarget => {
    if (typeof document === "undefined") {
      return preferredFocusTargetRef.current;
    }

    const activeElement = document.activeElement;
    if (!activeElement) {
      return "none";
    }

    if (liveInputRef.current && activeElement === liveInputRef.current) {
      return "live-input";
    }
    if (resumeTextareaRef.current && activeElement === resumeTextareaRef.current) {
      return "resume";
    }
    if (containerRef.current && containerRef.current.contains(activeElement)) {
      return "terminal";
    }

    return "none";
  }, []);

  const rememberFocusedSurface = useCallback(() => {
    const nextTarget = detectFocusedSurface();
    if (nextTarget === "none") {
      restoreFocusOnRecoveryRef.current = false;
      return nextTarget;
    }

    preferredFocusTargetRef.current = nextTarget;
    restoreFocusOnRecoveryRef.current = true;
    return nextTarget;
  }, [detectFocusedSurface]);

  const restorePreferredFocus = useCallback(() => {
    if (
      typeof document === "undefined"
      || document.hidden
      || !activeRef.current
      || !restoreFocusOnRecoveryRef.current
    ) {
      return;
    }

    const target = preferredFocusTargetRef.current;
    if (target === "resume") {
      resumeTextareaRef.current?.focus();
      return;
    }

    if (showLiveInputRail) {
      if (target === "terminal" || target === "live-input") {
        liveInputRef.current?.focus();
      }
      return;
    }

    if (target === "terminal" || target === "live-input") {
      try {
        termRef.current?.focus();
      } catch {
        // The xterm textarea can disappear during teardown or reconnect.
      }
    }
  }, [showLiveInputRail]);

  const updateScrollState = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      setShowScrollToBottom(false);
      return;
    }
    setShowScrollToBottom(!captureTerminalViewport(term).followOutput);
  }, []);

  const syncTerminalDimensions = useCallback((forceSync: boolean) => {
    const term = termRef.current;
    if (!term) {
      return;
    }

    const cols = Math.max(1, term.cols);
    const rows = Math.max(1, term.rows);
    const sizeKey = `${cols}x${rows}`;
    const previousKey = lastSyncedTerminalSizeRef.current;
    if (!forceSync && !pendingResizeSyncRef.current && previousKey === sizeKey) {
      return;
    }

    void sendResize(cols, rows)
      .then((sent) => {
        if (!sent) {
          pendingResizeSyncRef.current = true;
          return;
        }
        pendingResizeSyncRef.current = false;
        lastSyncedTerminalSizeRef.current = sizeKey;
      })
      .catch((error: unknown) => {
        pendingResizeSyncRef.current = true;
        if (lastSyncedTerminalSizeRef.current === sizeKey) {
          lastSyncedTerminalSizeRef.current = previousKey;
        }
        setTransportError(error instanceof Error ? error.message : "Failed to resize terminal");
      });
  }, [sendResize]);

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

    const viewport = captureTerminalViewport(term);
    const previousCols = term.cols;
    const previousRows = term.rows;

    try {
      fit.fit();
    } catch {
      return;
    }

    if (forceResize) {
      term.refresh(0, Math.max(0, term.rows - 1));
    }

    if (forceResize || term.cols !== previousCols || term.rows !== previousRows || pendingResizeSyncRef.current) {
      syncTerminalDimensions(forceResize || pendingResizeSyncRef.current);
    }

    restoreTerminalViewport(term, viewport);
    updateScrollState();
    restorePreferredFocus();
  }, [restorePreferredFocus, syncTerminalDimensions, updateScrollState]);

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
    const uploadedPaths = await uploadProjectAttachments({
      files,
      projectId,
      preferAbsolute: true,
    });
    if (!uploadedPaths.length) return;
    const escaped = shellEscapePaths(uploadedPaths);
    await sendTerminalKeys(`${escaped} `);
  }, [projectId, sendTerminalKeys]);

  const handleIncomingFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setSendError(null);
    try {
      if (expectsLiveTerminal && !interactiveTerminal) {
        throw new Error(transportNotice ?? "Operator access is required for live terminal input");
      }
      if (canSendLiveInput) {
        await injectFilesIntoTerminal(files);
        return;
      }
      queueResumeAttachments(files);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to process files");
    }
  }, [canSendLiveInput, expectsLiveTerminal, injectFilesIntoTerminal, interactiveTerminal, queueResumeAttachments, transportNotice]);

  const applyFetchedSnapshot = useCallback((snapshot: TerminalSnapshot) => {
    snapshotAppliedRef.current = null;
    lastLiveSnapshotRef.current = snapshot.snapshot;
    setSnapshotAnsi(snapshot.snapshot);
    setSnapshotReady(true);
    if (snapshot.live) {
      setConnectionState("live");
      setTransportError(null);
    }
  }, []);

  useEffect(() => {
    const wasLiveTerminal = previousLiveTerminalRef.current;
    previousLiveTerminalRef.current = expectsLiveTerminal;
    if (wasLiveTerminal && !expectsLiveTerminal) {
      snapshotAppliedRef.current = null;
      liveOutputStartedRef.current = false;
    }
  }, [expectsLiveTerminal]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)")
      : null;
    const syncTerminalAccessoryBar = () => {
      setShowTerminalAccessoryBar(shouldShowTerminalAccessoryBar());
    };

    syncTerminalAccessoryBar();
    window.addEventListener("resize", syncTerminalAccessoryBar);
    mediaQuery?.addEventListener?.("change", syncTerminalAccessoryBar);

    return () => {
      window.removeEventListener("resize", syncTerminalAccessoryBar);
      mediaQuery?.removeEventListener?.("change", syncTerminalAccessoryBar);
    };
  }, []);

  useEffect(() => {
    hasConnectedOnceRef.current = false;
    reconnectNoticeWrittenRef.current = false;
    snapshotAppliedRef.current = null;
    lastLiveSnapshotRef.current = "";
    liveOutputStartedRef.current = false;
    reconnectCountRef.current = 0;
    connectAttemptRef.current = 0;
    lastAppliedInsertNonceRef.current = 0;
    lastSyncedTerminalSizeRef.current = null;
    pendingResizeSyncRef.current = true;
    preferredFocusTargetRef.current = "none";
    restoreFocusOnRecoveryRef.current = false;
    pendingSocketBinaryModeRef.current = "stream";
    clearReconnectTimer();
    clearScheduledRecovery();
    socketRef.current?.close();
    socketRef.current = null;
    terminalHttpQueueRef.current = Promise.resolve();
    setTransportMode("websocket");
    setSocketBaseUrl(null);
    setConnectionState("connecting");
    setTransportError(null);
    setPollIntervalMs(DEFAULT_REMOTE_POLL_INTERVAL_MS);
    setInteractiveTerminal(true);
    setTransportNotice(null);
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
    setSessionStatusOverride(null);
    termRef.current?.reset();
    updateScrollState();
  }, [clearReconnectTimer, clearScheduledRecovery, sessionId, updateScrollState]);

  useEffect(() => {
    setSessionStatusOverride(null);
  }, [sessionState]);

  useEffect(() => {
    let mounted = true;
    setSnapshotReady(false);

    if (expectsLiveTerminal) {
      if (!shouldStreamLiveTerminal) {
        setSnapshotAnsi("");
        return () => {
          mounted = false;
        };
      }

      liveOutputStartedRef.current = false;
      snapshotAppliedRef.current = null;
      void (async () => {
        try {
          const snapshot = await fetchLiveTerminalSnapshot(sessionId, LIVE_TERMINAL_SNAPSHOT_LINES);
          if (!mounted) return;
          applyFetchedSnapshot(snapshot);
        } catch {
          try {
            const fallbackSnapshot = await fetchTerminalSnapshot(sessionId, READ_ONLY_TERMINAL_SNAPSHOT_LINES);
            if (!mounted) return;
            applyFetchedSnapshot(fallbackSnapshot);
          } catch {
            if (!mounted) return;
            setSnapshotAnsi("");
          }
        } finally {
          if (mounted) {
            setSnapshotReady(true);
          }
        }
      })();

      return () => {
        mounted = false;
      };
    }

    setSnapshotAnsi("");
    void (async () => {
      try {
        const snapshot = await fetchTerminalSnapshot(sessionId, READ_ONLY_TERMINAL_SNAPSHOT_LINES);
        if (!mounted) return;
        applyFetchedSnapshot(snapshot);
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
  }, [applyFetchedSnapshot, expectsLiveTerminal, sessionId, shouldStreamLiveTerminal]);

  useEffect(() => {
    let mounted = true;

    if (expectsLiveTerminal && !shouldStreamLiveTerminal) {
      setSocketBaseUrl(null);
      setConnectionState("closed");
      setTransportError(null);
      return () => {
        mounted = false;
      };
    }

    void (async () => {
      try {
        setSocketBaseUrl(null);
        const connection = await fetchTerminalConnection(sessionId);
        if (!mounted) return;
        setTransportMode(connection.transport);
        setPollIntervalMs(connection.pollIntervalMs);
        setSocketBaseUrl(connection.wsUrl);
        setInteractiveTerminal(connection.interactive);
        setTransportNotice(connection.fallbackReason);
        setTransportError(null);
        setConnectionState("connecting");
      } catch (err) {
        if (!mounted) return;
        setTransportError(err instanceof Error ? err.message : "Failed to resolve terminal connection");
        setTransportNotice(null);
        setConnectionState("error");
      }
    })();

    return () => {
      mounted = false;
    };
  }, [expectsLiveTerminal, reconnectToken, sessionId, shouldStreamLiveTerminal]);

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
        disableStdin: !expectsLiveTerminal,
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
      lastSyncedTerminalSizeRef.current = null;
      pendingResizeSyncRef.current = true;
      term.options.disableStdin = !expectsLiveTerminal || !interactiveTerminal || transportMode === "snapshot";
      setTerminalReady(true);
      updateScrollState();

      inputDisposableRef.current = term.onData((data) => {
        void sendTerminalKeys(data).catch(() => {
          // Ignore transient disconnects while xterm is still flushing local input.
        });
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
      lastSyncedTerminalSizeRef.current = null;
      pendingResizeSyncRef.current = true;
      setTerminalReady(false);
    };
  }, [expectsLiveTerminal, scheduleRendererRecovery, sendTerminalKeys, updateScrollState, interactiveTerminal, transportMode]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.disableStdin = !expectsLiveTerminal || !interactiveTerminal || transportMode === "snapshot";
  }, [expectsLiveTerminal, interactiveTerminal, transportMode]);

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
    if (!term) {
      return;
    }

    const viewport = captureTerminalViewport(term);
    if (transportMode === "snapshot" && expectsLiveTerminal) {
      term.reset();
      if (snapshotAnsi.length > 0) {
        term.write(normalizeTerminalSnapshot(snapshotAnsi), () => {
          if (termRef.current !== term) {
            return;
          }
          restoreTerminalViewport(term, viewport);
          updateScrollState();
          restorePreferredFocus();
        });
        return;
      }

      restoreTerminalViewport(term, viewport);
      updateScrollState();
      return;
    }

    if (snapshotAppliedRef.current === sessionId) {
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
        restoreTerminalViewport(term, viewport);
        updateScrollState();
        restorePreferredFocus();
      });
      return;
    }

    restoreTerminalViewport(term, viewport);
    updateScrollState();
  }, [
    expectsLiveTerminal,
    restorePreferredFocus,
    sessionId,
    snapshotAnsi,
    snapshotReady,
    terminalReady,
    transportMode,
    updateScrollState,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setPageVisible(visible);
      if (document.hidden) {
        rememberFocusedSurface();
        return;
      }
      normalizeWhitespaceOnlyDraft();
      scheduleRendererRecovery(false);
    };

    const handleWindowFocus = () => {
      setPageVisible(!document.hidden);
      normalizeWhitespaceOnlyDraft();
      scheduleRendererRecovery(false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [normalizeWhitespaceOnlyDraft, rememberFocusedSurface, scheduleRendererRecovery]);

  useEffect(() => {
    const handleDocumentFocusIn = () => {
      rememberFocusedSurface();
    };

    document.addEventListener("focusin", handleDocumentFocusIn);
    return () => {
      document.removeEventListener("focusin", handleDocumentFocusIn);
    };
  }, [rememberFocusedSurface]);

  useEffect(() => {
    if (shouldStreamLiveTerminal) {
      return;
    }

    clearReconnectTimer();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.close();
    }
  }, [clearReconnectTimer, shouldStreamLiveTerminal]);

  useEffect(() => {
    if (
      !snapshotReady
      || !shouldStreamLiveTerminal
      || transportMode !== "snapshot"
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const snapshot = await fetchLiveTerminalSnapshot(sessionId, LIVE_TERMINAL_SNAPSHOT_LINES);
        if (cancelled) return;
        setConnectionState("live");
        setTransportError(null);
        if (snapshot.snapshot !== lastLiveSnapshotRef.current) {
          applyFetchedSnapshot(snapshot);
        }
      } catch (error) {
        if (cancelled) return;
        setTransportError(error instanceof Error ? error.message : "Terminal polling failed");
        setConnectionState("error");
      } finally {
        inFlight = false;
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void poll();
          }, pollIntervalMs);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    applyFetchedSnapshot,
    lastLiveSnapshotRef,
    pollIntervalMs,
    sessionId,
    shouldStreamLiveTerminal,
    snapshotReady,
    transportMode,
  ]);

  useEffect(() => {
    if (
      !terminalReady
      || !snapshotReady
      || !socketBaseUrl
      || !termRef.current
      || !shouldStreamLiveTerminal
      || transportMode !== "websocket"
    ) return;

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
      pendingResizeSyncRef.current = true;
      pendingSocketBinaryModeRef.current = "stream";
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
          if (payload.type === "snapshot") {
            pendingSocketBinaryModeRef.current = "snapshot";
          } else if (payload.type === "error") {
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
        const nextMode = pendingSocketBinaryModeRef.current;
        pendingSocketBinaryModeRef.current = "stream";
        liveOutputStartedRef.current = true;
        const viewport = captureTerminalViewport(term);
        if (nextMode === "snapshot") {
          snapshotAppliedRef.current = sessionId;
          term.reset();
        }
        term.write(new Uint8Array(event.data), () => {
          if (termRef.current !== term) {
            return;
          }
          restoreTerminalViewport(term, viewport);
          if (nextMode === "snapshot") {
            restorePreferredFocus();
          }
          updateScrollState();
        });
      }
    };

    socket.onclose = () => {
      if (connectAttemptRef.current !== attemptId) return;
      socketRef.current = null;
      pendingSocketBinaryModeRef.current = "stream";
      const shouldRetry = LIVE_TERMINAL_STATUSES.has(latestStatusRef.current);
      if (shouldRetry) {
        pendingResizeSyncRef.current = true;
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
      pendingResizeSyncRef.current = true;
      setTransportError("Terminal connection failed");
      setConnectionState("error");
    };

    return () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      pendingSocketBinaryModeRef.current = "stream";
      socket.close();
    };
  }, [
    clearReconnectTimer,
    reconnectToken,
    restorePreferredFocus,
    scheduleReconnect,
    scheduleRendererRecovery,
    sessionId,
    shouldStreamLiveTerminal,
    snapshotReady,
    socketBaseUrl,
    terminalReady,
    transportMode,
    updateScrollState,
  ]);

  useEffect(() => {
    if (!terminalReady || !snapshotReady || !shouldStreamLiveTerminal || transportMode !== "websocket") {
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
  }, [connectionState, scheduleReconnect, shouldStreamLiveTerminal, snapshotReady, terminalReady, transportMode]);

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
      if (files.length > 0) {
        event.preventDefault();
        void handleIncomingFiles(files);
        return;
      }

      const localFilePath = extractLocalFileTransferPath(clipboard.getData("text/plain") ?? "");
      if (!localFilePath) {
        return;
      }

      event.preventDefault();
      setSendError(localFileTransferError(localFilePath));
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
      const attachmentPaths = await uploadProjectAttachments({
        files: attachments.map((attachment) => attachment.file),
        projectId,
        preferAbsolute: true,
      });

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
      try {
        const nextStatus = await fetchSessionStatus(sessionId);
        setSessionStatusOverride(nextStatus);
      } catch {
        // The session page hook will still reconcile status through the shared session stream.
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to resume session");
    } finally {
      setSending(false);
    }
  }, [attachments, message, projectId, router, sessionId, sessionModel, sessionReasoningEffort]);

  useEffect(() => {
    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    setSendError(null);

    if (canSendLiveInput) {
      const inlineText = pendingInsert.inlineText.trim();
      if (inlineText.length > 0) {
        void sendTerminalKeys(`${inlineText} `).catch((err: unknown) => {
          setSendError(err instanceof Error ? err.message : "Failed to insert preview context into terminal");
        });
      }
      return;
    }

    if (expectsLiveTerminal && !interactiveTerminal) {
      setSendError(transportNotice ?? "Operator access is required for live terminal input");
      return;
    }

    const draftText = pendingInsert.draftText.trim();
    if (draftText.length === 0) {
      return;
    }

    setMessage((current) => (current.trim().length > 0 ? `${current}\n\n${draftText}` : draftText));
  }, [canSendLiveInput, expectsLiveTerminal, interactiveTerminal, pendingInsert, sendTerminalKeys, transportNotice]);

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
    preferredFocusTargetRef.current = showLiveInputRail ? "live-input" : "terminal";
    restoreFocusOnRecoveryRef.current = true;
    term.scrollToBottom();
    updateScrollState();
    if (activeRef.current) {
      try {
        term.focus();
      } catch {
        return;
      }
    }
  }, [updateScrollState]);

  const focusTerminal = useCallback(() => {
    preferredFocusTargetRef.current = showLiveInputRail ? "live-input" : "terminal";
    restoreFocusOnRecoveryRef.current = true;
    if (showLiveInputRail) {
      liveInputRef.current?.focus();
      return;
    }
    if (!expectsLiveTerminal) {
      return;
    }
    const term = termRef.current;
    if (!term) {
      return;
    }
    try {
      term.focus();
    } catch {
      return;
    }
    scheduleRendererRecovery(false);
  }, [expectsLiveTerminal, scheduleRendererRecovery]);

  const handleTerminalPointerDown = useCallback((_event: ReactPointerEvent<HTMLDivElement>) => {
    focusTerminal();
  }, [focusTerminal]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    restorePreferredFocus();
  }, [restorePreferredFocus]);

  const handleRemoteInputSubmit = useCallback(async (withEnter: boolean) => {
    const value = liveInputDraft;
    if (!value.trim()) {
      if (withEnter) {
        try {
          await sendTerminalSpecial("Enter");
          setSendError(null);
        } catch (err) {
          setSendError(err instanceof Error ? err.message : "Failed to send terminal input");
        }
      }
      return;
    }

    try {
      await sendTerminalKeys(value);
      if (withEnter) {
        await sendTerminalSpecial("Enter");
      }
      setLiveInputDraft("");
      setSendError(null);
      requestAnimationFrame(() => {
        focusTerminal();
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send terminal input");
    }
  }, [focusTerminal, liveInputDraft, sendTerminalKeys, sendTerminalSpecial]);

  const handleLiveHelperKey = useCallback((special: string) => {
    void sendTerminalSpecial(special)
      .then(() => {
        setSendError(null);
      })
      .catch((err: unknown) => {
        setSendError(err instanceof Error ? err.message : "Failed to send terminal input");
      })
      .finally(() => {
        requestAnimationFrame(() => {
          focusTerminal();
        });
      });
  }, [focusTerminal, sendTerminalSpecial]);

  const handleFileSelection = useCallback((files: File[]) => {
    if (!files.length) {
      return;
    }

    if (expectsLiveTerminal) {
      void handleIncomingFiles(files);
      return;
    }

    queueResumeAttachments(files);
  }, [expectsLiveTerminal, handleIncomingFiles, queueResumeAttachments]);

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
      onDrop={async (event) => {
        event.preventDefault();
        setDragActive(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        const plainText = event.dataTransfer.getData("text/plain").trim();
        if (files.length > 0) {
          void handleIncomingFiles(files);
          return;
        }
        const localFilePath = extractLocalFileTransferPath(plainText);
        if (localFilePath) {
          setSendError(localFileTransferError(localFilePath));
          return;
        }
        if (!plainText) {
          return;
        }
        try {
          if (canSendLiveInput) {
            const payload = plainText.startsWith("/") ? shellEscapePath(plainText) : plainText;
            await sendTerminalKeys(payload);
            return;
          }
          if (expectsLiveTerminal && !interactiveTerminal) {
            setSendError(transportNotice ?? "Operator access is required for live terminal input");
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
          connectionState === "live" && transportMode === "websocket"
            ? "opacity-0 group-hover/terminal:opacity-100 focus-within:opacity-100"
            : "opacity-100"
        }`}>
          {connectionState !== "live" || transportMode === "snapshot" ? (
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
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden touch-pan-y"
          onClick={focusTerminal}
          onPointerDown={handleTerminalPointerDown}
        />
      </div>

      {showScrollToBottom ? (
        <div className={`pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 ${showResumeRail ? "bottom-24" : showLiveHelperBar ? "bottom-20" : "bottom-4"}`}>
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
            {expectsLiveTerminal && interactiveTerminal
              ? "Drop files or screenshots to insert uploaded paths into the terminal"
              : expectsLiveTerminal
                ? "Live terminal input is read-only in snapshot recovery mode"
              : "Drop files or screenshots to attach them before resuming"}
          </span>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={(event) => {
          handleFileSelection(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {transportNotice && !showSnapshotFallbackRail ? (
        <div className={`pointer-events-none absolute left-3 right-3 z-10 ${showResumeRail ? "bottom-24" : "bottom-4"}`}>
          <div className="rounded-[12px] border border-white/8 bg-[#0f0a0a]/92 px-3 py-2 text-[12px] text-[#b8aea6] shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            {transportNotice}
          </div>
        </div>
      ) : null}

      {showSnapshotFallbackRail ? (
        <div className="border-t border-white/8 bg-[#0b0808]/98 px-3 py-3">
          <div className="flex items-center gap-2">
            <input
              ref={liveInputRef}
              value={liveInputDraft}
              onChange={(event) => setLiveInputDraft(event.target.value)}
              onFocus={() => {
                preferredFocusTargetRef.current = "live-input";
                restoreFocusOnRecoveryRef.current = true;
                setSendError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleRemoteInputSubmit(true);
                }
              }}
              placeholder="Type into terminal..."
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              enterKeyHint="send"
              inputMode="text"
              spellCheck={false}
              className="h-10 flex-1 rounded-[12px] border border-white/10 bg-black/35 px-3 text-[14px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] focus:border-white/20"
            />
            <button
              type="button"
              className="shrink-0 rounded-full border border-[#f3f0ea]/12 bg-[#f3f0ea] px-3 py-2 text-[11px] font-medium text-[#0d0909] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleRemoteInputSubmit(true)}
              disabled={connectionState !== "live"}
            >
              Send
            </button>
          </div>
          <p className="mt-2 text-[11px] text-[#8e847d]">
            {transportNotice ?? "Live terminal websocket unavailable. Recovery mode keeps the terminal refreshed from server snapshots."}
          </p>
          {sendError ? (
            <p className="mt-1 text-[12px] text-[#ff8f7a]">{sendError}</p>
          ) : null}
        </div>
      ) : null}

      {showLiveHelperBar ? (
        <div className="border-t border-white/8 bg-[#0b0808]/96 px-3 py-2">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              className="shrink-0 rounded-full border border-[#f3f0ea]/12 bg-[#f3f0ea] px-3 py-2 text-[11px] font-medium text-[#0d0909] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={focusTerminal}
              disabled={connectionState !== "live"}
            >
              Type in terminal
            </button>
            <button
              type="button"
              className="shrink-0 rounded-full border border-white/12 bg-white/6 px-3 py-2 text-[11px] text-[#d7cec7] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={connectionState !== "live"}
            >
              Attach
            </button>
            {LIVE_TERMINAL_HELPER_KEYS.map(({ label, special }) => (
              <button
                key={special}
                type="button"
                className="shrink-0 rounded-full border border-white/12 bg-white/6 px-3 py-2 text-[11px] text-[#d7cec7] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={connectionState !== "live"}
                onClick={() => handleLiveHelperKey(special)}
              >
                {label}
              </button>
            ))}
          </div>
          {sendError ? (
            <p className="mt-1 text-[12px] text-[#ff8f7a]">{sendError}</p>
          ) : null}
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
                preferredFocusTargetRef.current = "resume";
                restoreFocusOnRecoveryRef.current = true;
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
      ) : !showLiveHelperBar && sendError ? (
        <div className="absolute bottom-3 left-3 rounded-full border border-[#ff8f7a]/30 bg-[#1d1111]/90 px-3 py-1.5 text-[12px] text-[#ff8f7a] backdrop-blur-sm">
          {sendError}
        </div>
      ) : null}
    </div>
  );
}

export default SessionTerminal;
