"use client";

import React, { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, Paperclip, RefreshCw, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getTerminalTheme } from "@/components/terminal/xtermTheme";
import { extractLocalFileTransferPath, uploadProjectAttachments } from "./attachmentUploads";
import { captureTerminalViewport, restoreTerminalViewport, type TerminalViewportState } from "./terminalViewport";
import {
  buildTerminalSnapshotPayload,
  buildTerminalWriteBatch,
  buildTerminalSocketUrl,
  calculateMobileTerminalViewportMetrics,
  coalesceTerminalHttpControlOperations,
  decodeTerminalBase64Payload,
  detectMobileTerminalInputRail,
  getSessionTerminalViewportOptions,
  prependTerminalModes,
  sanitizeRemoteTerminalSnapshot,
  stripBrowserTerminalResponses,
  type TerminalModeState,
  type TerminalHttpControlOperation,
  type TerminalWriteChunk,
} from "./sessionTerminalUtils";
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
  immersiveMobileMode?: boolean;
}

declare global {
  interface Window {
    __conductorSessionTerminalDebug?: {
      sessionId: string;
      getState: () => Record<string, unknown>;
    };
  }
}

type TerminalConnectionInfo = {
  stream: {
    transport: "eventstream";
    wsUrl: string | null;
  };
  control: {
    transport: "http";
    interactive: boolean;
    fallbackReason: string | null;
  };
};

type TerminalSnapshot = {
  snapshot: string;
  transcript: string;
  source: string;
  live: boolean;
  restored: boolean;
  sequence: number | null;
  modes?: TerminalModeState;
};

type TerminalServerEvent =
  | { type: "control"; event: "ready" | "ack" | "pong" | "exit"; sessionId: string; action?: string; exitCode?: number }
  | {
      type: "recovery";
      sessionId: string;
      reason: "lagged";
      skipped: number;
      sequence: number;
      snapshotVersion: number;
      cols: number;
      rows: number;
      modes?: TerminalSnapshot["modes"];
    }
  | { type: "error"; sessionId: string; error: string };

type TerminalStreamEventMessage =
  | TerminalServerEvent
  | {
      type: "restore";
      sessionId: string;
      sequence: number;
      snapshotVersion: number;
      reason: "attach" | "lagged" | "unknown";
      cols: number;
      rows: number;
      modes?: TerminalSnapshot["modes"];
      payload: string;
    }
  | {
      type: "stream";
      sessionId: string;
      sequence: number;
      payload: string;
    };

const LIVE_TERMINAL_STATUSES = new Set(["queued", "spawning", "running", "working", "needs_input", "stuck"]);
const RESUMABLE_STATUSES = new Set(["done", "needs_input", "stuck", "errored", "terminated", "killed"]);
const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 1600;
const RENDERER_RECOVERY_THROTTLE_MS = 120;
const TERMINAL_WRITE_BATCH_MAX_DELAY_MS = 16;
const TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS = 10;
// Keep enough scrollback so users can scroll through recent output without
// losing context on tab switch or mobile scroll. The backend owns the full
// durable capture (2 MB / 10 000 lines); the browser scrollback is sized per
// device class to avoid excessive memory on mobile.
const DESKTOP_TERMINAL_SCROLLBACK = 10_000;
const MOBILE_TERMINAL_SCROLLBACK = 2_000;
const LIVE_TERMINAL_SCROLLBACK =
  typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? MOBILE_TERMINAL_SCROLLBACK
    : DESKTOP_TERMINAL_SCROLLBACK;
const READ_ONLY_TERMINAL_SNAPSHOT_LINES = 10_000;
const TERMINAL_CONNECTION_CACHE_MAX_TTL_MS = 5_000;
const TERMINAL_CONNECTION_CACHE_MAX_ENTRIES = 2;
const TERMINAL_SNAPSHOT_CACHE_MAX_ENTRIES = 8;
const TERMINAL_UI_STATE_CACHE_MAX_ENTRIES = 4;
const TERMINAL_SNAPSHOT_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const TERMINAL_UI_STATE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
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

type PreferredFocusTarget = "none" | "terminal" | "resume";
type PendingTerminalHttpControlOperation = TerminalHttpControlOperation & {
  reject: (error: unknown) => void;
  resolve: () => void;
};

type CachedTerminalConnection = {
  value: TerminalConnectionInfo;
  expiresAt: number;
};

type CachedTerminalSnapshot = TerminalSnapshot & {
  updatedAt: number;
};

type CachedTerminalUiState = {
  message: string;
  searchOpen: boolean;
  searchQuery: string;
  helperPanelOpen: boolean;
  viewport: TerminalViewportState | null;
  updatedAt: number;
};

type TerminalCoreClientModules = [
  typeof import("@xterm/xterm"),
  typeof import("@xterm/addon-fit"),
];

const IS_MOBILE_DEVICE =
  typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

const terminalConnectionCache = new Map<string, CachedTerminalConnection>();
const terminalSnapshotCache = new Map<string, CachedTerminalSnapshot>();
const terminalUiStateCache = new Map<string, CachedTerminalUiState>();
let terminalCoreClientModulesPromise: Promise<TerminalCoreClientModules> | null = null;
let terminalSearchAddonModulePromise: Promise<typeof import("@xterm/addon-search")> | null = null;
let terminalWebglAddonModulePromise: Promise<typeof import("@xterm/addon-webgl")> | null = null;
let terminalUnicode11AddonModulePromise: Promise<typeof import("@xterm/addon-unicode11")> | null = null;
let terminalWebLinksAddonModulePromise: Promise<typeof import("@xterm/addon-web-links")> | null = null;

function trimTerminalCache(cache: Map<string, unknown>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function readCachedTerminalConnection(sessionId: string): TerminalConnectionInfo | null {
  const cached = terminalConnectionCache.get(sessionId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    terminalConnectionCache.delete(sessionId);
    return null;
  }
  return cached.value;
}

function storeCachedTerminalConnection(sessionId: string, value: TerminalConnectionInfo): void {
  terminalConnectionCache.delete(sessionId);
  terminalConnectionCache.set(sessionId, {
    value,
    expiresAt: Date.now() + TERMINAL_CONNECTION_CACHE_MAX_TTL_MS,
  });
  trimTerminalCache(terminalConnectionCache, TERMINAL_CONNECTION_CACHE_MAX_ENTRIES);
}

function clearCachedTerminalConnection(sessionId: string): void {
  terminalConnectionCache.delete(sessionId);
}

function readCachedTerminalSnapshot(sessionId: string): TerminalSnapshot | null {
  const cached = terminalSnapshotCache.get(sessionId);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.updatedAt > TERMINAL_SNAPSHOT_CACHE_MAX_AGE_MS) {
    terminalSnapshotCache.delete(sessionId);
    return null;
  }
  return {
    snapshot: cached.snapshot,
    transcript: cached.transcript,
    source: cached.source,
    live: cached.live,
    restored: cached.restored,
    sequence: cached.sequence,
    modes: cached.modes,
  };
}

function storeCachedTerminalSnapshot(sessionId: string, snapshot: TerminalSnapshot): void {
  terminalSnapshotCache.delete(sessionId);
  terminalSnapshotCache.set(sessionId, {
    ...snapshot,
    updatedAt: Date.now(),
  });
  trimTerminalCache(terminalSnapshotCache, TERMINAL_SNAPSHOT_CACHE_MAX_ENTRIES);
}

function clearCachedTerminalSnapshot(sessionId: string): void {
  terminalSnapshotCache.delete(sessionId);
}

function readCachedTerminalUiState(sessionId: string): CachedTerminalUiState | null {
  const cached = terminalUiStateCache.get(sessionId);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.updatedAt > TERMINAL_UI_STATE_CACHE_MAX_AGE_MS) {
    terminalUiStateCache.delete(sessionId);
    return null;
  }
  return cached;
}

function storeCachedTerminalUiState(
  sessionId: string,
  value: Omit<CachedTerminalUiState, "updatedAt">,
): void {
  terminalUiStateCache.delete(sessionId);
  terminalUiStateCache.set(sessionId, {
    ...value,
    updatedAt: Date.now(),
  });
  trimTerminalCache(terminalUiStateCache, TERMINAL_UI_STATE_CACHE_MAX_ENTRIES);
}

function decodeTerminalPayloadToString(payload: Uint8Array): string {
  if (payload.length === 0) {
    return "";
  }
  if (typeof TextDecoder === "undefined") {
    return String.fromCharCode(...payload);
  }
  return new TextDecoder().decode(payload);
}

function loadTerminalCoreClientModules(): Promise<TerminalCoreClientModules> {
  if (!terminalCoreClientModulesPromise) {
    terminalCoreClientModulesPromise = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).catch((error) => {
      terminalCoreClientModulesPromise = null;
      throw error;
    }) as Promise<TerminalCoreClientModules>;
  }
  return terminalCoreClientModulesPromise;
}

function loadTerminalSearchAddonModule(): Promise<typeof import("@xterm/addon-search")> {
  if (!terminalSearchAddonModulePromise) {
    terminalSearchAddonModulePromise = import("@xterm/addon-search").catch((error) => {
      terminalSearchAddonModulePromise = null;
      throw error;
    });
  }
  return terminalSearchAddonModulePromise;
}

function loadTerminalWebglAddonModule(): Promise<typeof import("@xterm/addon-webgl")> {
  if (!terminalWebglAddonModulePromise) {
    terminalWebglAddonModulePromise = import("@xterm/addon-webgl").catch((error) => {
      terminalWebglAddonModulePromise = null;
      throw error;
    });
  }
  return terminalWebglAddonModulePromise;
}

function loadTerminalUnicode11AddonModule(): Promise<typeof import("@xterm/addon-unicode11")> {
  if (!terminalUnicode11AddonModulePromise) {
    terminalUnicode11AddonModulePromise = import("@xterm/addon-unicode11").catch((error) => {
      terminalUnicode11AddonModulePromise = null;
      throw error;
    });
  }
  return terminalUnicode11AddonModulePromise;
}

function loadTerminalWebLinksAddonModule(): Promise<typeof import("@xterm/addon-web-links")> {
  if (!terminalWebLinksAddonModulePromise) {
    terminalWebLinksAddonModulePromise = import("@xterm/addon-web-links").catch((error) => {
      terminalWebLinksAddonModulePromise = null;
      throw error;
    });
  }
  return terminalWebLinksAddonModulePromise;
}

function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

function extractClipboardFiles(clipboard: DataTransfer): File[] {
  const files = Array.from(clipboard.files ?? []);
  const seen = new Set(files.map((file) => `${file.name}:${file.size}:${file.type}:${file.lastModified}`));

  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(file);
  }

  return files;
}

async function fetchTerminalConnection(sessionId: string): Promise<TerminalConnectionInfo> {
  const cached = readCachedTerminalConnection(sessionId);
  if (cached) {
    return cached;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/connection`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | {
        transport?: string;
        wsUrl?: string | null;
        interactive?: boolean;
        fallbackReason?: string | null;
        stream?: {
          transport?: string;
          wsUrl?: string | null;
        } | null;
        control?: {
          transport?: "http";
          interactive?: boolean;
          fallbackReason?: string | null;
        } | null;
        error?: string;
      }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal connection: ${response.status}`);
  }
  const rawStreamWsUrl = data?.stream?.wsUrl;
  const rawStreamTransport = data?.stream?.transport ?? data?.transport;
  if (typeof rawStreamTransport === "string" && rawStreamTransport !== "eventstream") {
    throw new Error(`Unsupported terminal transport: ${rawStreamTransport}`);
  }
  const interactive = data?.control?.interactive === true || data?.interactive === true;
  const fallbackReason = typeof data?.control?.fallbackReason === "string" && data.control.fallbackReason.trim().length > 0
    ? data.control.fallbackReason.trim()
    : (typeof data?.fallbackReason === "string" && data.fallbackReason.trim().length > 0
      ? data.fallbackReason.trim()
      : null);

  const streamWsUrl = typeof rawStreamWsUrl === "string" && rawStreamWsUrl.trim().length > 0
    ? rawStreamWsUrl.trim()
    : (typeof data?.wsUrl === "string" && data.wsUrl.trim().length > 0 ? data.wsUrl.trim() : null);

  if (streamWsUrl === null) {
    throw new Error("Terminal connection did not include a live stream URL");
  }

  const connection: TerminalConnectionInfo = {
    stream: {
      transport: "eventstream",
      wsUrl: streamWsUrl,
    },
    control: {
      transport: "http",
      interactive,
      fallbackReason,
    },
  };
  storeCachedTerminalConnection(sessionId, connection);
  return connection;
}

function parseTerminalModes(value: unknown): TerminalModeState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mouseProtocolMode = typeof candidate["mouseProtocolMode"] === "string"
    ? candidate["mouseProtocolMode"]
    : "None";
  const mouseProtocolEncoding = typeof candidate["mouseProtocolEncoding"] === "string"
    ? candidate["mouseProtocolEncoding"]
    : "Default";

  return {
    alternateScreen: candidate["alternateScreen"] === true,
    applicationKeypad: candidate["applicationKeypad"] === true,
    applicationCursor: candidate["applicationCursor"] === true,
    hideCursor: candidate["hideCursor"] === true,
    bracketedPaste: candidate["bracketedPaste"] === true,
    mouseProtocolMode,
    mouseProtocolEncoding,
  };
}

async function fetchTerminalSnapshot(sessionId: string, lines: number): Promise<TerminalSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?lines=${lines}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { snapshot?: string; transcript?: string; source?: string; live?: boolean; restored?: boolean; sequence?: number; modes?: unknown; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal snapshot: ${response.status}`);
  }
  const rawSnapshot = typeof data?.snapshot === "string" ? data.snapshot : "";
  const transcript = typeof data?.transcript === "string" ? data.transcript : "";
  const compactedSnapshot = transcript.trim().length > 0 ? transcript : rawSnapshot;
  return {
    // Keep only one readable payload in the browser for archived/read-only sessions.
    snapshot: compactedSnapshot,
    transcript: "",
    source: typeof data?.source === "string" ? data.source : "empty",
    live: data?.live === true,
    restored: data?.restored === true,
    sequence: typeof data?.sequence === "number" && Number.isSafeInteger(data.sequence)
      ? data.sequence
      : null,
    modes: parseTerminalModes(data?.modes),
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


function localFileTransferError(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.includes("/temporaryitems/") || normalized.includes("nsird_screencaptureui")) {
    return "macOS exposed only a temporary screenshot path. Paste the screenshot or drop the saved file from Finder so Conductor can upload it cleanly.";
  }

  return "The browser exposed only a local file path for this drop. Use paste or the attach button so Conductor can upload the file instead of injecting raw path text.";
}

function buildReadableSnapshotPayload(snapshot: string, transcript: string): Uint8Array {
  const normalized = (transcript.trim().length > 0 ? transcript : sanitizeRemoteTerminalSnapshot(snapshot))
    .replace(/\r?\n/g, "\r\n")
    .replace(/\u0000/g, "");
  return new TextEncoder().encode(normalized);
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

function shouldShowTerminalAccessoryBar(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return detectMobileTerminalInputRail(window.innerWidth, coarsePointer, navigator.maxTouchPoints);
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
  immersiveMobileMode = false,
}: SessionTerminalProps) {
  const router = useRouter();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const searchRef = useRef<XSearchAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const terminalHttpControlQueueRef = useRef<PendingTerminalHttpControlOperation[]>([]);
  const terminalHttpControlInFlightRef = useRef(false);
  const terminalHttpControlFrameRef = useRef<number | null>(null);
  const terminalHttpControlTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectAttemptRef = useRef(0);
  const inputDisposableRef = useRef<IDisposable | null>(null);
  const scrollDisposableRef = useRef<IDisposable | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const latestStatusRef = useRef(sessionState);
  const activeRef = useRef(active);
  const pageVisibleRef = useRef(typeof document === "undefined" ? true : !document.hidden);
  const hasConnectedOnceRef = useRef(false);
  const reconnectNoticeWrittenRef = useRef(false);
  const snapshotAppliedRef = useRef<string | null>(null);
  const snapshotAnsiRef = useRef("");
  const snapshotTranscriptRef = useRef("");
  const snapshotModesRef = useRef<TerminalModeState | undefined>(undefined);
  const lastTerminalSequenceRef = useRef<number | null>(null);
  const liveOutputStartedRef = useRef(false);
  const previousLiveTerminalRef = useRef(false);
  const recoveryFrameRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryLastRunRef = useRef(0);
  const recoveryPendingResizeRef = useRef(false);
  const visibilityRecoveryTimersRef = useRef<number[]>([]);
  const terminalWriteFrameRef = useRef<number | null>(null);
  const terminalWriteTimerRef = useRef<number | null>(null);
  const terminalWriteQueueRef = useRef<TerminalWriteChunk[]>([]);
  const terminalWriteInFlightRef = useRef(false);
  const terminalWriteRestoreFocusRef = useRef(false);
  const terminalWriteDecoderRef = useRef<TextDecoder | null>(
    typeof TextDecoder === "undefined" ? null : new TextDecoder(),
  );
  const lastObservedContainerSizeRef = useRef<string | null>(null);
  const lastViewportOptionKeyRef = useRef<string | null>(null);
  const lastAppliedInsertNonceRef = useRef<number>(0);
  const lastSyncedTerminalSizeRef = useRef<string | null>(null);
  const pendingResizeSyncRef = useRef(true);
  const preferredFocusTargetRef = useRef<PreferredFocusTarget>("none");
  const restoreFocusOnRecoveryRef = useRef(false);
  const expectsLiveTerminalRef = useRef(false);
  const interactiveTerminalRef = useRef(true);
  const initialUiState = readCachedTerminalUiState(sessionId);
  const pendingViewportRestoreRef = useRef<TerminalViewportState | null>(initialUiState?.viewport ?? null);

  const [terminalReady, setTerminalReady] = useState(false);
  const [socketBaseUrl, setSocketBaseUrl] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [transportError, setTransportError] = useState<string | null>(null);
  const [interactiveTerminal, setInteractiveTerminal] = useState(true);
  const [transportNotice, setTransportNotice] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [message, setMessage] = useState(() => initialUiState?.message ?? "");
  const [attachments, setAttachments] = useState<Array<{ file: File }>>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [searchOpen, setSearchOpen] = useState(() => initialUiState?.searchOpen ?? false);
  const [searchQuery, setSearchQuery] = useState(() => initialUiState?.searchQuery ?? "");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [snapshotAnsi, setSnapshotAnsi] = useState("");
  const [snapshotTranscript, setSnapshotTranscript] = useState("");
  const [snapshotModes, setSnapshotModes] = useState<TerminalModeState | undefined>(undefined);
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const [sessionStatusOverride, setSessionStatusOverride] = useState<string | null>(null);
  const [showTerminalAccessoryBar, setShowTerminalAccessoryBar] = useState(() => shouldShowTerminalAccessoryBar());
  const [helperPanelOpen, setHelperPanelOpen] = useState(() => initialUiState?.helperPanelOpen ?? false);
  const [mobileViewportHeight, setMobileViewportHeight] = useState<number | null>(null);
  const [mobileKeyboardVisible, setMobileKeyboardVisible] = useState(false);

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
  const shouldAttachTerminalSurface = active && pageVisible;
  // Detach the browser terminal when the pane or page is hidden and rely on
  // the daemon-owned restore snapshot when the user comes back.
  const shouldStreamLiveTerminal = expectsLiveTerminal && shouldAttachTerminalSurface;
  const showResumeRail = RESUMABLE_STATUSES.has(normalizedSessionStatus) && !expectsLiveTerminal;
  const showLiveHelperBar = expectsLiveTerminal && interactiveTerminal && showTerminalAccessoryBar;
  const showPersistentTopControls = immersiveMobileMode || showTerminalAccessoryBar;
  const railPlaceholder = normalizedSessionStatus === "done"
    ? "Continue the session..."
    : normalizedSessionStatus === "needs_input" || normalizedSessionStatus === "stuck"
      ? "Answer the agent and resume..."
      : "Restart this session with a follow-up...";
  const terminalContextLabel = [
    sessionModel || agentName || "session",
    sessionReasoningEffort || null,
    expectsLiveTerminal
      ? (connectionState === "live" ? "streaming" : connectionState)
      : showResumeRail
        ? "resume"
        : normalizedSessionStatus,
    projectId || null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" · ");
  const resumeComposerHint = attachments.length > 0
    ? "Press Enter to resume. Shift+Enter adds a newline. Attachments upload before the next run starts."
    : "Press Enter to resume. Shift+Enter adds a newline.";
  const canSendLiveInput = expectsLiveTerminal && interactiveTerminal && connectionState === "live";
  const canRenderTerminal = shouldAttachTerminalSurface;
  expectsLiveTerminalRef.current = expectsLiveTerminal;
  interactiveTerminalRef.current = interactiveTerminal;
  pageVisibleRef.current = pageVisible;
  snapshotAnsiRef.current = snapshotAnsi;
  snapshotTranscriptRef.current = snapshotTranscript;
  snapshotModesRef.current = snapshotModes;

  const floatingOverlayBottomPx = showResumeRail
    ? 132
    : showLiveHelperBar
      ? helperPanelOpen ? 112 : 64
      : 12;
  const terminalSurfaceStyle = useMemo<CSSProperties | undefined>(() => {
    if (!immersiveMobileMode || !mobileViewportHeight || mobileViewportHeight <= 0) {
      return undefined;
    }

    return {
      height: `${mobileViewportHeight}px`,
      minHeight: `${mobileViewportHeight}px`,
    };
  }, [immersiveMobileMode, mobileViewportHeight]);

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
    clearCachedTerminalConnection(sessionId);
    pendingResizeSyncRef.current = true;
    setTransportError(null);
    setTransportNotice(null);
    setConnectionState("connecting");
    setSocketBaseUrl(null);
    setReconnectToken((value) => value + 1);
  }, [clearReconnectTimer, sessionId]);

  const clearScheduledTerminalHttpControlFlush = useCallback(() => {
    if (terminalHttpControlFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalHttpControlFrameRef.current);
      terminalHttpControlFrameRef.current = null;
    }
    if (terminalHttpControlTimerRef.current !== null) {
      window.clearTimeout(terminalHttpControlTimerRef.current);
      terminalHttpControlTimerRef.current = null;
    }
  }, []);

  const flushTerminalHttpControlOperations = useCallback(async () => {
    clearScheduledTerminalHttpControlFlush();
    if (terminalHttpControlInFlightRef.current) {
      return;
    }

    const pendingOperations = terminalHttpControlQueueRef.current.splice(0);
    if (pendingOperations.length === 0) {
      return;
    }

    terminalHttpControlInFlightRef.current = true;
    try {
      const operations = coalesceTerminalHttpControlOperations(pendingOperations.map((operation) => {
        if (operation.kind === "keys") {
          return { kind: "keys", keys: operation.keys } satisfies TerminalHttpControlOperation;
        }
        if (operation.kind === "resize") {
          return {
            kind: "resize",
            cols: operation.cols,
            rows: operation.rows,
          } satisfies TerminalHttpControlOperation;
        }
        return { kind: "special", special: operation.special } satisfies TerminalHttpControlOperation;
      }));

      for (const operation of operations) {
        if (operation.kind === "keys") {
          await postSessionTerminalKeys(sessionId, { keys: operation.keys });
          continue;
        }
        if (operation.kind === "resize") {
          await postTerminalResize(sessionId, operation.cols, operation.rows);
          continue;
        }
        await postSessionTerminalKeys(sessionId, { special: operation.special });
      }

      for (const operation of pendingOperations) {
        operation.resolve();
      }
    } catch (error) {
      for (const operation of pendingOperations) {
        operation.reject(error);
      }
    } finally {
      terminalHttpControlInFlightRef.current = false;
      if (terminalHttpControlQueueRef.current.length > 0) {
        if (typeof window === "undefined") {
          void flushTerminalHttpControlOperations();
          return;
        }
        terminalHttpControlFrameRef.current = window.requestAnimationFrame(() => {
          void flushTerminalHttpControlOperations();
        });
        terminalHttpControlTimerRef.current = window.setTimeout(() => {
          void flushTerminalHttpControlOperations();
        }, TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS);
      }
    }
  }, [clearScheduledTerminalHttpControlFlush, sessionId]);

  const scheduleTerminalHttpControlFlush = useCallback(() => {
    if (terminalHttpControlInFlightRef.current || terminalHttpControlQueueRef.current.length === 0) {
      return;
    }

    if (typeof window === "undefined") {
      void flushTerminalHttpControlOperations();
      return;
    }

    if (terminalHttpControlFrameRef.current !== null || terminalHttpControlTimerRef.current !== null) {
      return;
    }

    terminalHttpControlFrameRef.current = window.requestAnimationFrame(() => {
      void flushTerminalHttpControlOperations();
    });
    terminalHttpControlTimerRef.current = window.setTimeout(() => {
      void flushTerminalHttpControlOperations();
    }, TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS);
  }, [flushTerminalHttpControlOperations]);

  const enqueueTerminalHttpControlOperation = useCallback((
    operation: TerminalHttpControlOperation,
    flushNow = false,
  ): Promise<void> => new Promise<void>((resolve, reject) => {
    terminalHttpControlQueueRef.current.push({
      ...operation,
      resolve,
      reject,
    });

    if (flushNow) {
      void flushTerminalHttpControlOperations();
      return;
    }

    scheduleTerminalHttpControlFlush();
  }), [flushTerminalHttpControlOperations, scheduleTerminalHttpControlFlush]);

  const sendResize = useCallback(async (cols: number, rows: number): Promise<boolean> => {
    await enqueueTerminalHttpControlOperation({
      kind: "resize",
      cols,
      rows,
    });
    return true;
  }, [enqueueTerminalHttpControlOperation]);

  const sendTerminalKeys = useCallback(async (data: string) => {
    if (!interactiveTerminal) {
      throw new Error("Operator access is required for live terminal input");
    }
    const keys = stripBrowserTerminalResponses(data);
    if (keys.length === 0) {
      return;
    }

    await enqueueTerminalHttpControlOperation({ kind: "keys", keys });
  }, [enqueueTerminalHttpControlOperation, interactiveTerminal]);

  const sendTerminalSpecial = useCallback(async (special: string) => {
    if (!interactiveTerminal) {
      throw new Error("Operator access is required for live terminal input");
    }

    await enqueueTerminalHttpControlOperation({ kind: "special", special }, true);
  }, [enqueueTerminalHttpControlOperation, interactiveTerminal]);

  const detectFocusedSurface = useCallback((): PreferredFocusTarget => {
    if (typeof document === "undefined") {
      return preferredFocusTargetRef.current;
    }

    const activeElement = document.activeElement;
    if (!activeElement) {
      return "none";
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

    if (target === "terminal") {
      try {
        termRef.current?.focus();
      } catch {
        // The xterm textarea can disappear during teardown or reconnect.
      }
    }
  }, []);

  const rememberTerminalViewport = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    if (pendingViewportRestoreRef.current && snapshotAppliedRef.current !== sessionId) {
      return;
    }
    pendingViewportRestoreRef.current = captureTerminalViewport(term);
  }, [sessionId]);

  const applyViewportRestore = useCallback((term: XTerminal, fallbackViewport: TerminalViewportState) => {
    const cachedViewport = pendingViewportRestoreRef.current;
    if (cachedViewport) {
      restoreTerminalViewport(term, cachedViewport);
      pendingViewportRestoreRef.current = captureTerminalViewport(term);
      return;
    }
    restoreTerminalViewport(term, fallbackViewport);
    pendingViewportRestoreRef.current = captureTerminalViewport(term);
  }, []);

  const updateScrollState = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      setShowScrollToBottom(false);
      return;
    }
    setShowScrollToBottom(!captureTerminalViewport(term).followOutput);
  }, []);

  const clearScheduledTerminalFlush = useCallback(() => {
    if (terminalWriteTimerRef.current !== null) {
      window.clearTimeout(terminalWriteTimerRef.current);
      terminalWriteTimerRef.current = null;
    }
    if (terminalWriteFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalWriteFrameRef.current);
      terminalWriteFrameRef.current = null;
    }
  }, []);

  const flushTerminalWrites = useCallback(() => {
    clearScheduledTerminalFlush();
    if (terminalWriteInFlightRef.current) {
      return;
    }

    const term = termRef.current;
    if (!term) {
      terminalWriteQueueRef.current = [];
      terminalWriteRestoreFocusRef.current = false;
      return;
    }

    const batch = buildTerminalWriteBatch(terminalWriteQueueRef.current);
    terminalWriteQueueRef.current = [];
    const shouldRestoreFocus = terminalWriteRestoreFocusRef.current;
    terminalWriteRestoreFocusRef.current = false;

    if (!batch.payload) {
      if (batch.replace) {
        const viewport = captureTerminalViewport(term);
        snapshotAppliedRef.current = sessionId;
        term.reset();
        applyViewportRestore(term, viewport);
      }
      updateScrollState();
      if (shouldRestoreFocus) {
        restorePreferredFocus();
      }
      return;
    }

    const viewport = captureTerminalViewport(term);
    terminalWriteInFlightRef.current = true;
    if (batch.replace) {
      snapshotAppliedRef.current = sessionId;
      term.reset();
      terminalWriteDecoderRef.current = typeof TextDecoder === "undefined" ? null : new TextDecoder();
    }

    const decodedPayload = terminalWriteDecoderRef.current
      ? terminalWriteDecoderRef.current.decode(batch.payload, { stream: true })
      : String.fromCharCode(...batch.payload);

    term.write(decodedPayload, () => {
      terminalWriteInFlightRef.current = false;
      if (termRef.current !== term) {
        return;
      }
      applyViewportRestore(term, viewport);
      updateScrollState();
      if (shouldRestoreFocus) {
        restorePreferredFocus();
      }
      if (terminalWriteQueueRef.current.length > 0) {
        if (typeof window === "undefined") {
          flushTerminalWrites();
          return;
        }
        terminalWriteTimerRef.current = window.setTimeout(() => {
          flushTerminalWrites();
        }, 0);
      }
    });
  }, [applyViewportRestore, clearScheduledTerminalFlush, restorePreferredFocus, sessionId, updateScrollState]);

  const scheduleTerminalFlush = useCallback(() => {
    if (terminalWriteInFlightRef.current || terminalWriteQueueRef.current.length === 0) {
      return;
    }

    if (typeof window === "undefined") {
      flushTerminalWrites();
      return;
    }

    if (terminalWriteFrameRef.current !== null || terminalWriteTimerRef.current !== null) {
      return;
    }

    // Align flushes to the next animation frame (~16ms cadence) so batched
    // writes land once per paint instead of thrashing the renderer.
    terminalWriteFrameRef.current = window.requestAnimationFrame(() => {
      terminalWriteFrameRef.current = null;
      flushTerminalWrites();
    });
    // Fallback timer ensures writes still land if rAF is throttled (e.g.
    // background tabs on some browsers).
    terminalWriteTimerRef.current = window.setTimeout(() => {
      terminalWriteTimerRef.current = null;
      if (terminalWriteFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalWriteFrameRef.current);
        terminalWriteFrameRef.current = null;
      }
      flushTerminalWrites();
    }, TERMINAL_WRITE_BATCH_MAX_DELAY_MS);
  }, [flushTerminalWrites]);

  const queueTerminalWrite = useCallback((chunk: TerminalWriteChunk, restoreFocus = false) => {
    terminalWriteQueueRef.current.push(chunk);
    terminalWriteRestoreFocusRef.current ||= restoreFocus;
    scheduleTerminalFlush();
  }, [scheduleTerminalFlush]);

  const requestSnapshotRender = useCallback(() => {
    const term = termRef.current;
    const currentSnapshot = snapshotAnsiRef.current;
    if (!term || currentSnapshot.length === 0) {
      return false;
    }

    snapshotAppliedRef.current = sessionId;
    const payload = liveOutputStartedRef.current
      ? buildTerminalSnapshotPayload(currentSnapshot, snapshotModesRef.current)
      : buildReadableSnapshotPayload(currentSnapshot, snapshotTranscriptRef.current);
    queueTerminalWrite({
      kind: "snapshot",
      payload,
    });
    return true;
  }, [queueTerminalWrite, sessionId]);

  const requestSnapshotRenderRef = useRef(requestSnapshotRender);
  const updateScrollStateRef = useRef(updateScrollState);
  const clearScheduledTerminalFlushRef = useRef(clearScheduledTerminalFlush);
  const scheduleRendererRecoveryRef = useRef<(forceResize: boolean) => void>(() => {});

  useEffect(() => {
    requestSnapshotRenderRef.current = requestSnapshotRender;
  }, [requestSnapshotRender]);

  useEffect(() => {
    updateScrollStateRef.current = updateScrollState;
  }, [updateScrollState]);

  useEffect(() => {
    clearScheduledTerminalFlushRef.current = clearScheduledTerminalFlush;
  }, [clearScheduledTerminalFlush]);


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

    applyViewportRestore(term, viewport);
    updateScrollState();
    restorePreferredFocus();
  }, [applyViewportRestore, restorePreferredFocus, syncTerminalDimensions, updateScrollState]);

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
      if (expectsLiveTerminal) {
        if (!canSendLiveInput) {
          throw new Error("Wait for the live terminal to reconnect before sending files.");
        }
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
    lastTerminalSequenceRef.current = snapshot.sequence;
    snapshotAnsiRef.current = snapshot.snapshot;
    snapshotTranscriptRef.current = snapshot.transcript;
    snapshotModesRef.current = snapshot.modes;
    storeCachedTerminalSnapshot(sessionId, snapshot);
    setSnapshotAnsi(snapshot.snapshot);
    setSnapshotTranscript(snapshot.transcript);
    setSnapshotModes(snapshot.modes);
    setSnapshotReady(true);
    if (typeof window !== "undefined" && termRef.current) {
      window.requestAnimationFrame(() => {
        requestSnapshotRender();
      });
    }
    if (snapshot.live) {
      setConnectionState("live");
      setTransportError(null);
    }
  }, [requestSnapshotRender, sessionId]);

  const persistCachedUiState = useEffectEvent(() => {
    const term = termRef.current;
    const viewport = term && (snapshotAppliedRef.current === sessionId || terminalHasRenderedContent(term))
      ? captureTerminalViewport(term)
      : pendingViewportRestoreRef.current;
    pendingViewportRestoreRef.current = viewport;
    storeCachedTerminalUiState(sessionId, {
      message,
      searchOpen,
      searchQuery,
      helperPanelOpen,
      viewport,
    });
  });

  useEffect(() => {
    persistCachedUiState();
  }, [helperPanelOpen, message, persistCachedUiState, searchOpen, searchQuery]);

  useEffect(() => () => {
    persistCachedUiState();
  }, [persistCachedUiState]);

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
    if (!immersiveMobileMode || typeof window === "undefined" || !window.visualViewport) {
      setMobileViewportHeight(null);
      setMobileKeyboardVisible(false);
      return;
    }

    const visualViewport = window.visualViewport;
    let frameHandle: number | null = null;
    const syncMobileViewport = () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      frameHandle = window.requestAnimationFrame(() => {
        frameHandle = null;
        const surface = surfaceRef.current;
        if (!surface) {
          return;
        }
        const metrics = calculateMobileTerminalViewportMetrics(
          window.innerHeight,
          visualViewport.height,
          visualViewport.offsetTop,
          surface.getBoundingClientRect().top,
        );
        setMobileViewportHeight((current) => (current === metrics.usableHeight ? current : metrics.usableHeight));
        setMobileKeyboardVisible((current) => (current === metrics.keyboardVisible ? current : metrics.keyboardVisible));
        if (activeRef.current) {
          scheduleRendererRecovery(true);
        }
      });
    };

    syncMobileViewport();
    visualViewport.addEventListener("resize", syncMobileViewport);
    visualViewport.addEventListener("scroll", syncMobileViewport);
    window.addEventListener("resize", syncMobileViewport);

    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      visualViewport.removeEventListener("resize", syncMobileViewport);
      visualViewport.removeEventListener("scroll", syncMobileViewport);
      window.removeEventListener("resize", syncMobileViewport);
    };
  }, [immersiveMobileMode, scheduleRendererRecovery]);

  useEffect(() => {
    if (!mobileKeyboardVisible) {
      return;
    }
    setHelperPanelOpen(false);
  }, [mobileKeyboardVisible]);

  useEffect(() => {
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const cachedUiState = readCachedTerminalUiState(sessionId);
    hasConnectedOnceRef.current = false;
    reconnectNoticeWrittenRef.current = false;
    snapshotAppliedRef.current = null;
    lastTerminalSequenceRef.current = cachedSnapshot?.sequence ?? null;
    liveOutputStartedRef.current = false;
    reconnectCountRef.current = 0;
    connectAttemptRef.current = 0;
    lastAppliedInsertNonceRef.current = 0;
    lastSyncedTerminalSizeRef.current = null;
    pendingResizeSyncRef.current = true;
    preferredFocusTargetRef.current = "none";
    restoreFocusOnRecoveryRef.current = false;
    clearReconnectTimer();
    clearScheduledRecovery();
    clearScheduledTerminalFlush();
    clearScheduledTerminalHttpControlFlush();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    terminalHttpControlQueueRef.current = [];
    terminalHttpControlInFlightRef.current = false;
    lastObservedContainerSizeRef.current = null;
    lastViewportOptionKeyRef.current = null;
    pendingViewportRestoreRef.current = cachedUiState?.viewport ?? null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setSocketBaseUrl(null);
    setConnectionState("connecting");
    setTransportError(null);
    setInteractiveTerminal(true);
    setTransportNotice(null);
    setMessage(cachedUiState?.message ?? "");
    setAttachments([]);
    setSending(false);
    setSendError(null);
    setDragActive(false);
    setSearchOpen(cachedUiState?.searchOpen ?? false);
    setSearchQuery(cachedUiState?.searchQuery ?? "");
    setHelperPanelOpen(cachedUiState?.helperPanelOpen ?? false);
    setShowScrollToBottom(false);
    setSnapshotReady(cachedSnapshot !== null);
    setSnapshotAnsi(cachedSnapshot?.snapshot ?? "");
    setSnapshotTranscript(cachedSnapshot?.transcript ?? "");
    setSnapshotModes(cachedSnapshot?.modes);
    setSessionStatusOverride(null);
    setMobileViewportHeight(null);
    setMobileKeyboardVisible(false);
    termRef.current?.reset();
    updateScrollState();
  }, [clearReconnectTimer, clearScheduledRecovery, clearScheduledTerminalFlush, clearScheduledTerminalHttpControlFlush, sessionId, updateScrollState]);

  useEffect(() => {
    setSessionStatusOverride(null);
  }, [sessionState]);

  useEffect(() => {
    let mounted = true;
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const hasCachedSnapshot = cachedSnapshot !== null;
    setSnapshotReady(hasCachedSnapshot);

    if (!active) {
      return () => {
        mounted = false;
      };
    }

    if (expectsLiveTerminal) {
      if (!shouldStreamLiveTerminal) {
        return () => {
          mounted = false;
        };
      }

      // Direct live transports deliver their own restore payloads. Avoid
      // racing them with an eager HTTP snapshot fetch, which adds latency and
      // can double-apply initial terminal state.
      liveOutputStartedRef.current = false;
      lastTerminalSequenceRef.current = null;
      snapshotAppliedRef.current = null;
      snapshotAnsiRef.current = "";
      snapshotTranscriptRef.current = "";
      snapshotModesRef.current = undefined;
      setSnapshotAnsi("");
      setSnapshotTranscript("");
      setSnapshotModes(undefined);
      setSnapshotReady(true);

      return () => {
        mounted = false;
      };
    }

    if (hasCachedSnapshot) {
      setSnapshotAnsi(cachedSnapshot.snapshot);
      setSnapshotTranscript(cachedSnapshot.transcript);
      setSnapshotModes(cachedSnapshot.modes);
    } else {
      setSnapshotAnsi("");
      setSnapshotTranscript("");
      setSnapshotModes(undefined);
    }
    void (async () => {
      try {
        const snapshot = await fetchTerminalSnapshot(sessionId, READ_ONLY_TERMINAL_SNAPSHOT_LINES);
        if (!mounted) return;
        applyFetchedSnapshot(snapshot);
      } catch {
        if (!mounted) return;
        setSnapshotAnsi("");
        setSnapshotTranscript("");
      } finally {
        if (mounted) {
          setSnapshotReady(true);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [active, applyFetchedSnapshot, expectsLiveTerminal, sessionId, shouldStreamLiveTerminal]);

  useEffect(() => {
    let mounted = true;

    if (!expectsLiveTerminal || !shouldStreamLiveTerminal) {
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
        setSocketBaseUrl(connection.stream.wsUrl);
        setInteractiveTerminal(connection.control.interactive);
        setTransportNotice(connection.control.fallbackReason);
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

  const handleTerminalServerEvent = useEffectEvent((payload: TerminalServerEvent) => {
    if (payload.type === "error") {
      setTransportError(payload.error);
      setConnectionState("error");
      return;
    }

    if (payload.type === "control") {
      if (payload.event === "exit") {
        setConnectionState("closed");
      } else {
        setTransportError(null);
        setConnectionState("live");
      }
      return;
    }

    setTransportError(null);
    setConnectionState("live");
  });

  const handleTerminalPayloadFrame = useEffectEvent((
    kind: "restore" | "stream",
    sequence: number,
    payload: Uint8Array,
    modes?: TerminalModeState,
  ) => {
    const previousSequence = lastTerminalSequenceRef.current;
    if (typeof previousSequence === "number") {
      if (kind === "stream" && sequence <= previousSequence) {
        return;
      }
      if (kind === "restore" && liveOutputStartedRef.current && sequence <= previousSequence) {
        return;
      }
    }

    liveOutputStartedRef.current = true;
    lastTerminalSequenceRef.current = sequence;
    setTransportError(null);
    setConnectionState("live");
    if (kind === "restore") {
      const snapshot = decodeTerminalPayloadToString(payload);
      const transcript = sanitizeRemoteTerminalSnapshot(snapshot);
      snapshotAnsiRef.current = snapshot;
      snapshotTranscriptRef.current = transcript;
      snapshotModesRef.current = modes;
      clearCachedTerminalSnapshot(sessionId);
    }
    const nextPayload = kind === "restore"
      ? prependTerminalModes(payload, modes)
      : payload;
    queueTerminalWrite(
      {
        kind: kind === "restore" ? "snapshot" : "stream",
        payload: nextPayload,
      },
      kind === "restore",
    );
    if (kind === "restore") {
      snapshotAppliedRef.current = sessionId;
    }
  });

  useEffect(() => {
    scheduleRendererRecoveryRef.current = scheduleRendererRecovery;
  }, [scheduleRendererRecovery]);

  const handleTerminalEventStreamMessage = useEffectEvent((payload: TerminalStreamEventMessage) => {
    if (payload.type === "stream" || payload.type === "restore") {
      try {
        handleTerminalPayloadFrame(
          payload.type,
          payload.sequence,
          decodeTerminalBase64Payload(payload.payload),
          payload.type === "restore" ? payload.modes : undefined,
        );
      } catch {
        setTransportError("Received an invalid terminal frame");
        setConnectionState("error");
      }
      return;
    }

    handleTerminalServerEvent(payload);
  });

  const handleTerminalData = useEffectEvent((data: string) => {
    void sendTerminalKeys(data).catch(() => {
      // Ignore transient disconnects while xterm is still flushing local input.
    });
  });

  const handleTerminalScroll = useEffectEvent(() => {
    rememberTerminalViewport();
    updateScrollState();
  });

  const handleTerminalResizeObserved = useEffectEvent((term: XTerminal, entry: ResizeObserverEntry) => {
    if (!activeRef.current) {
      return;
    }

    const nextViewportOptions = getSessionTerminalViewportOptions(window.innerWidth);
    const viewportKey = `${nextViewportOptions.fontFamily}:${nextViewportOptions.fontSize}:${nextViewportOptions.lineHeight}`;
    const sizeKey = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
    if (lastObservedContainerSizeRef.current === sizeKey && lastViewportOptionKeyRef.current === viewportKey) {
      return;
    }

    lastObservedContainerSizeRef.current = sizeKey;
    lastViewportOptionKeyRef.current = viewportKey;

    try {
      if (term.options.fontFamily !== nextViewportOptions.fontFamily) {
        term.options.fontFamily = nextViewportOptions.fontFamily;
      }
      if (term.options.fontSize !== nextViewportOptions.fontSize) {
        term.options.fontSize = nextViewportOptions.fontSize;
      }
      if (term.options.lineHeight !== nextViewportOptions.lineHeight) {
        term.options.lineHeight = nextViewportOptions.lineHeight;
      }
    } catch {
      return;
    }

    scheduleRendererRecovery(true);
  });

  useEffect(() => {
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let mounted = true;

    async function init() {
      if (!shouldAttachTerminalSurface || !containerRef.current || !mounted) return;

      const [xtermMod, fitMod] = await loadTerminalCoreClientModules();

      if (!mounted || !containerRef.current) return;

      const isLight = document.documentElement.classList.contains("light");
      const viewportOptions = getSessionTerminalViewportOptions(window.innerWidth);
      const terminalOptions: ITerminalOptions & { scrollbar?: { showScrollbar: boolean } } = {
        allowTransparency: false,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: "block",
        cursorWidth: 2,
        cursorInactiveStyle: "outline",
        disableStdin: !expectsLiveTerminalRef.current,
        drawBoldTextInBrightColors: true,
        fontFamily: viewportOptions.fontFamily,
        fontSize: viewportOptions.fontSize,
        fontWeight: "400",
        fontWeightBold: "700",
        fastScrollSensitivity: 4,
        lineHeight: viewportOptions.lineHeight,
        scrollSensitivity: 1.1,
        scrollback: LIVE_TERMINAL_SCROLLBACK,
        theme: getTerminalTheme(isLight),
        scrollbar: {
          showScrollbar: !IS_MOBILE_DEVICE,
        },
      };
      term = new xtermMod.Terminal(terminalOptions);
      fit = new fitMod.FitAddon();
      term.loadAddon(fit);

      term.open(containerRef.current);
      fit.fit();

      // Load WebGL renderer for significantly better rendering performance.
      // Falls back to the default canvas renderer if WebGL is unavailable.
      void loadTerminalWebglAddonModule()
        .then((webglMod) => {
          if (!mounted || termRef.current !== term) return;
          const webglAddon = new webglMod.WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
          });
          term!.loadAddon(webglAddon);
        })
        .catch(() => {
          // WebGL unavailable — canvas renderer continues to work.
        });

      // Load Unicode11 addon for proper CJK and emoji rendering.
      void loadTerminalUnicode11AddonModule()
        .then((unicode11Mod) => {
          if (!mounted || termRef.current !== term) return;
          const unicode11Addon = new unicode11Mod.Unicode11Addon();
          term!.loadAddon(unicode11Addon);
          term!.unicode.activeVersion = "11";
        })
        .catch(() => {
          // Unicode11 unavailable — default unicode handling continues.
        });

      // Load Web Links addon so URLs in terminal output are clickable.
      void loadTerminalWebLinksAddonModule()
        .then((webLinksMod) => {
          if (!mounted || termRef.current !== term) return;
          const webLinksAddon = new webLinksMod.WebLinksAddon();
          term!.loadAddon(webLinksAddon);
        })
        .catch(() => {
          // Web links unavailable — URLs remain plain text.
        });

      termRef.current = term;
      fitRef.current = fit;
      lastSyncedTerminalSizeRef.current = null;
      pendingResizeSyncRef.current = true;
      lastObservedContainerSizeRef.current = `${Math.round(containerRef.current.clientWidth)}x${Math.round(containerRef.current.clientHeight)}`;
      lastViewportOptionKeyRef.current = `${viewportOptions.fontFamily}:${viewportOptions.fontSize}:${viewportOptions.lineHeight}`;
      term.options.disableStdin = !expectsLiveTerminalRef.current || !interactiveTerminalRef.current;
      setTerminalReady(true);
      updateScrollStateRef.current();
      window.requestAnimationFrame(() => {
        if (!mounted) {
          return;
        }
        requestSnapshotRenderRef.current();
      });

      inputDisposableRef.current = term.onData((data) => {
        handleTerminalData(data);
      });
      scrollDisposableRef.current = term.onScroll(() => {
        handleTerminalScroll();
      });

      resizeObserverRef.current = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || !term) {
          return;
        }
        handleTerminalResizeObserved(term, entry);
      });
      resizeObserverRef.current.observe(containerRef.current);
    }

    if (!shouldAttachTerminalSurface) {
      setTerminalReady(false);
      return () => {
        mounted = false;
      };
    }

    void init();

    return () => {
      mounted = false;
      if (term) {
        pendingViewportRestoreRef.current = captureTerminalViewport(term);
      }
      clearScheduledTerminalFlushRef.current();
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
      snapshotAppliedRef.current = null;
      liveOutputStartedRef.current = false;
      lastSyncedTerminalSizeRef.current = null;
      lastObservedContainerSizeRef.current = null;
      lastViewportOptionKeyRef.current = null;
      terminalWriteQueueRef.current = [];
      terminalWriteInFlightRef.current = false;
      terminalWriteRestoreFocusRef.current = false;
      terminalWriteDecoderRef.current = typeof TextDecoder === "undefined" ? null : new TextDecoder();
      pendingResizeSyncRef.current = true;
      setTerminalReady(false);
    };
  }, [sessionId, shouldAttachTerminalSurface]);

  useEffect(() => {
    if (!searchOpen || !termRef.current || searchRef.current) {
      return;
    }

    let cancelled = false;
    void loadTerminalSearchAddonModule()
      .then((searchMod) => {
        if (cancelled || !termRef.current || searchRef.current) {
          return;
        }
        const searchAddon = new searchMod.SearchAddon();
        termRef.current.loadAddon(searchAddon);
        searchRef.current = searchAddon;
      })
      .catch(() => {
        // Search stays optional; terminal rendering should not fail if the
        // addon bundle cannot load.
      });

    return () => {
      cancelled = true;
    };
  }, [searchOpen]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.disableStdin = !expectsLiveTerminal || !interactiveTerminal;
  }, [expectsLiveTerminal, interactiveTerminal]);

  useEffect(() => {
    if (!active) {
      return;
    }

    if (expectsLiveTerminal && (connectionState === "closed" || connectionState === "error")) {
      requestReconnect();
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
  }, [active, clearVisibilityRecoveryTimers, connectionState, expectsLiveTerminal, requestReconnect, scheduleRendererRecovery]);

  useEffect(() => {
    if (!terminalReady || !snapshotReady || !canRenderTerminal) {
      return;
    }

    const term = termRef.current;
    if (!term) {
      return;
    }

    const hasRenderedContent = terminalHasRenderedContent(term);

    if (snapshotAppliedRef.current === sessionId && hasRenderedContent) {
      updateScrollState();
      return;
    }

    if (expectsLiveTerminal && liveOutputStartedRef.current && hasRenderedContent) {
      snapshotAppliedRef.current = sessionId;
      updateScrollState();
      return;
    }

    snapshotAppliedRef.current = sessionId;
    if (snapshotAnsi.length > 0) {
      queueTerminalWrite({
        kind: "snapshot",
        payload: liveOutputStartedRef.current
          ? buildTerminalSnapshotPayload(snapshotAnsi, snapshotModes)
          : buildReadableSnapshotPayload(snapshotAnsi, snapshotTranscript),
      });
      return;
    }

    updateScrollState();
  }, [
    expectsLiveTerminal,
    sessionId,
    snapshotAnsi,
    snapshotTranscript,
    snapshotModes,
    snapshotReady,
    terminalReady,
    queueTerminalWrite,
    updateScrollState,
    canRenderTerminal,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || process.env.NODE_ENV === "production") {
      return;
    }

    window.__conductorSessionTerminalDebug = {
      sessionId,
      getState: () => ({
        sessionId,
        active,
        terminalReady,
        snapshotReady,
        snapshotLength: snapshotAnsi.length,
        snapshotTranscriptLength: snapshotTranscript.length,
        snapshotPreview: snapshotAnsi.slice(0, 120),
        connectionState,
        interactiveTerminal,
        liveOutputStarted: liveOutputStartedRef.current,
        snapshotApplied: snapshotAppliedRef.current,
        hasRenderedContent: termRef.current ? terminalHasRenderedContent(termRef.current) : false,
        termRows: termRef.current?.rows ?? null,
        termCols: termRef.current?.cols ?? null,
        bufferBaseY: termRef.current?.buffer.active.baseY ?? null,
        bufferViewportY: termRef.current?.buffer.active.viewportY ?? null,
      }),
    };

    return () => {
      if (window.__conductorSessionTerminalDebug?.sessionId === sessionId) {
        delete window.__conductorSessionTerminalDebug;
      }
    };
  }, [
    active,
    connectionState,
    interactiveTerminal,
    sessionId,
    snapshotAnsi,
    snapshotTranscript,
    snapshotReady,
    terminalReady,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setPageVisible(!document.hidden);
      if (document.hidden) {
        rememberFocusedSurface();
        return;
      }
      normalizeWhitespaceOnlyDraft();
      if (expectsLiveTerminal && (connectionState === "closed" || connectionState === "error")) {
        requestReconnect();
      }
      scheduleRendererRecovery(false);
    };

    const handleWindowFocus = () => {
      setPageVisible(!document.hidden);
      normalizeWhitespaceOnlyDraft();
      if (!document.hidden && expectsLiveTerminal && (connectionState === "closed" || connectionState === "error")) {
        requestReconnect();
      }
      scheduleRendererRecovery(false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [connectionState, expectsLiveTerminal, normalizeWhitespaceOnlyDraft, rememberFocusedSurface, requestReconnect, scheduleRendererRecovery]);

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
    clearScheduledTerminalFlush();
    clearScheduledTerminalHttpControlFlush();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    terminalHttpControlQueueRef.current = [];
    terminalHttpControlInFlightRef.current = false;
    const eventSource = eventSourceRef.current;
    eventSourceRef.current = null;
    if (eventSource) {
      eventSource.close();
    }
    if (expectsLiveTerminal) {
      clearCachedTerminalSnapshot(sessionId);
      snapshotAppliedRef.current = null;
      snapshotAnsiRef.current = "";
      snapshotTranscriptRef.current = "";
      snapshotModesRef.current = undefined;
      lastTerminalSequenceRef.current = null;
      liveOutputStartedRef.current = false;
      setSnapshotAnsi("");
      setSnapshotTranscript("");
      setSnapshotModes(undefined);
      setSnapshotReady(false);
    }
  }, [
    clearReconnectTimer,
    clearScheduledTerminalFlush,
    clearScheduledTerminalHttpControlFlush,
    expectsLiveTerminal,
    sessionId,
    shouldStreamLiveTerminal,
  ]);

  useEffect(() => {
    if (
      !terminalReady
      || !socketBaseUrl
      || !termRef.current
      || !shouldStreamLiveTerminal
    ) return;

    const term = termRef.current;
    const streamUrl = buildTerminalSocketUrl(
      socketBaseUrl,
      term.cols,
      term.rows,
      lastTerminalSequenceRef.current,
    );
    const attemptId = connectAttemptRef.current + 1;
    connectAttemptRef.current = attemptId;
    clearReconnectTimer();
    setConnectionState("connecting");

    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      if (connectAttemptRef.current !== attemptId) return;
      reconnectCountRef.current = 0;
      pendingResizeSyncRef.current = true;
      setTransportError(null);
      setConnectionState("live");
      hasConnectedOnceRef.current = true;
      reconnectNoticeWrittenRef.current = false;
      updateScrollStateRef.current();
      scheduleRendererRecoveryRef.current(true);
    };

    source.onmessage = (event) => {
      if (connectAttemptRef.current !== attemptId) return;
      try {
        handleTerminalEventStreamMessage(JSON.parse(event.data) as TerminalStreamEventMessage);
      } catch {
        setTransportError("Received an invalid terminal event");
        setConnectionState("error");
      }
    };

    source.onerror = () => {
      if (connectAttemptRef.current !== attemptId) return;
      const shouldRetry = LIVE_TERMINAL_STATUSES.has(latestStatusRef.current);
      if (shouldRetry) {
        pendingResizeSyncRef.current = true;
        const currentTerm = termRef.current;
        if (currentTerm && hasConnectedOnceRef.current && liveOutputStartedRef.current && !reconnectNoticeWrittenRef.current) {
          reconnectNoticeWrittenRef.current = true;
          currentTerm.writeln("\r\n\x1b[90m[Connection lost. Reconnecting...]\x1b[0m");
        }
        setConnectionState("connecting");
        setTransportError(null);
        return;
      }
      clearCachedTerminalConnection(sessionId);
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
      source.close();
      setTransportError("Terminal connection failed");
      setConnectionState("error");
    };

    return () => {
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
      source.close();
    };
  }, [
    clearReconnectTimer,
    sessionId,
    shouldStreamLiveTerminal,
    socketBaseUrl,
    terminalReady,
  ]);

  useEffect(() => {
    if (
      !terminalReady
      || !shouldStreamLiveTerminal
    ) {
      return;
    }

    const source = eventSourceRef.current;
    if (source && (source.readyState === EventSource.CONNECTING || source.readyState === EventSource.OPEN)) {
      return;
    }

    if (connectionState !== "closed" && connectionState !== "error") {
      return;
    }

    if (reconnectTimerRef.current !== null) {
      return;
    }

    scheduleReconnect();
  }, [connectionState, scheduleReconnect, shouldStreamLiveTerminal, terminalReady]);

  useEffect(() => () => {
    clearReconnectTimer();
    clearScheduledRecovery();
    clearScheduledTerminalFlush();
    clearScheduledTerminalHttpControlFlush();
    clearVisibilityRecoveryTimers();
    terminalWriteQueueRef.current = [];
    terminalWriteInFlightRef.current = false;
    terminalWriteRestoreFocusRef.current = false;
    terminalHttpControlQueueRef.current = [];
    terminalHttpControlInFlightRef.current = false;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [clearReconnectTimer, clearScheduledRecovery, clearScheduledTerminalFlush, clearScheduledTerminalHttpControlFlush, clearVisibilityRecoveryTimers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = extractClipboardFiles(clipboard);
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
      return;
    };

    const pasteListener = (event: ClipboardEvent) => {
      handlePaste(event);
    };

    container.addEventListener("paste", pasteListener, { capture: true });
    return () => {
      container.removeEventListener("paste", pasteListener, { capture: true });
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
    preferredFocusTargetRef.current = "terminal";
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
    preferredFocusTargetRef.current = "terminal";
    restoreFocusOnRecoveryRef.current = true;
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

  const handleTerminalPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // On touch devices, defer focus until we know the gesture is a tap and not
    // a scroll.  Immediate focus on pointerdown opens the virtual keyboard and
    // steals the touch from the native scroll handler.
    if (event.pointerType === "touch") {
      return;
    }
    focusTerminal();
  }, [focusTerminal]);

  const handleTerminalWheel = useCallback((event: WheelEvent) => {
    const term = termRef.current;
    if (!term || event.ctrlKey || event.metaKey || event.defaultPrevented) {
      return;
    }

    if (term.buffer.active.baseY <= 0) {
      return;
    }

    let deltaLines = event.deltaY;
    if (event.deltaMode === 0) {
      deltaLines = event.deltaY / 18;
    } else if (event.deltaMode === 2) {
      deltaLines = event.deltaY * Math.max(1, term.rows - 1);
    }

    const roundedDelta = deltaLines > 0 ? Math.ceil(deltaLines) : Math.floor(deltaLines);
    if (roundedDelta === 0) {
      return;
    }

    term.scrollLines(roundedDelta);
    updateScrollState();
    event.preventDefault();
  }, [updateScrollState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const wheelListener = (event: WheelEvent) => {
      handleTerminalWheel(event);
    };

    // --- Smooth touch-scroll with momentum for mobile ---
    // xterm.js line-by-line scrolling feels choppy on touch.  We accumulate
    // fractional pixel deltas so the terminal responds to the smallest finger
    // movement, and add momentum (inertia) on touchend so the scroll coasts
    // to a stop like a native list view.
    let touchLastY: number | null = null;
    let touchScrolled = false;
    let touchAccumY = 0;
    let touchVelocity = 0;
    let touchLastTime = 0;
    let momentumFrame: number | null = null;

    // Measured from xterm.js default cell height.  This value only converts
    // pixel deltas into line counts; a smaller value means more responsive
    // (sub-line) feel because we emit a scrollLines(1) sooner.
    const LINE_HEIGHT_PX = 16;
    // Momentum tuning
    const MOMENTUM_DECAY = 0.92;
    const MOMENTUM_MIN_VELOCITY = 0.3;
    const VELOCITY_WEIGHT = 0.6;

    const cancelMomentum = () => {
      if (momentumFrame !== null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
      }
    };

    const stepMomentum = () => {
      const term = termRef.current;
      if (!term || Math.abs(touchVelocity) < MOMENTUM_MIN_VELOCITY) {
        momentumFrame = null;
        updateScrollState();
        return;
      }
      touchAccumY += touchVelocity;
      const lines = Math.trunc(touchAccumY / LINE_HEIGHT_PX);
      if (lines !== 0) {
        touchAccumY -= lines * LINE_HEIGHT_PX;
        term.scrollLines(lines);
      }
      touchVelocity *= MOMENTUM_DECAY;
      momentumFrame = requestAnimationFrame(stepMomentum);
    };

    const onTouchStart = (event: TouchEvent) => {
      cancelMomentum();
      if (event.touches.length === 1) {
        touchLastY = event.touches[0]!.clientY;
        touchLastTime = event.timeStamp;
        touchScrolled = false;
        touchAccumY = 0;
        touchVelocity = 0;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      const term = termRef.current;
      if (!term || touchLastY === null || event.touches.length !== 1) {
        return;
      }
      const currentY = event.touches[0]!.clientY;
      const deltaY = touchLastY - currentY;
      const now = event.timeStamp;
      const dt = now - touchLastTime;

      // Only scroll when there is scrollback to scroll through.
      // When baseY === 0 the swipe is a no-op and we must NOT suppress
      // the subsequent tap-to-focus in onTouchEnd.
      if (term.buffer.active.baseY > 0) {
        touchScrolled = true;
        touchAccumY += deltaY;

        const lines = Math.trunc(touchAccumY / LINE_HEIGHT_PX);
        if (lines !== 0) {
          touchAccumY -= lines * LINE_HEIGHT_PX;
          term.scrollLines(lines);
        }

        // Exponential moving average for velocity (px per frame @ 16ms)
        if (dt > 0) {
          const instantVelocity = (deltaY / dt) * 16;
          touchVelocity = touchVelocity === 0
            ? instantVelocity
            : VELOCITY_WEIGHT * instantVelocity + (1 - VELOCITY_WEIGHT) * touchVelocity;
        }

        event.preventDefault();
      }
      touchLastY = currentY;
      touchLastTime = now;
    };

    const onTouchEnd = () => {
      if (!touchScrolled && touchLastY !== null) {
        // Short tap: focus the terminal (deferred from pointerdown)
        focusTerminal();
      } else if (touchScrolled && Math.abs(touchVelocity) >= MOMENTUM_MIN_VELOCITY) {
        // Kick off momentum scroll
        momentumFrame = requestAnimationFrame(stepMomentum);
      }
      touchLastY = null;
      touchScrolled = false;
      updateScrollState();
    };

    container.addEventListener("wheel", wheelListener, { passive: false });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      cancelMomentum();
      container.removeEventListener("wheel", wheelListener);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [handleTerminalWheel, focusTerminal, updateScrollState]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    restorePreferredFocus();
  }, [restorePreferredFocus]);

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
      ref={surfaceRef}
      style={terminalSurfaceStyle}
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-white/10 bg-[#060404] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
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
          if (expectsLiveTerminal) {
            setSendError("Wait for the live terminal to reconnect before sending input.");
            return;
          }
          setMessage((current) => current.length > 0 ? `${current}\n${plainText}` : plainText);
        } catch (err) {
          setSendError(err instanceof Error ? err.message : "Failed to write drop payload");
        }
      }}
    >
      {searchOpen ? (
        <div className={immersiveMobileMode
          ? "absolute right-3 top-14 z-10 flex max-w-[calc(100%-1.5rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur"
          : "absolute right-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center rounded bg-[#141010]/95 pl-2 pr-0.5 shadow-lg ring-1 ring-white/10 backdrop-blur sm:right-3 sm:top-3 sm:max-w-[calc(100%-1.5rem)]"}
        >
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
        <div className={`${immersiveMobileMode ? "absolute right-3 top-14" : "absolute right-2 top-2 sm:right-3 sm:top-3"} z-10 flex items-center gap-1.5 transition-opacity sm:gap-2 ${
          connectionState === "live" && !showPersistentTopControls
            ? "opacity-0 group-hover/terminal:opacity-100 focus-within:opacity-100"
            : "opacity-100"
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

      <div className={immersiveMobileMode ? "min-h-0 flex-1 overflow-hidden px-0 pb-0 pt-0" : "min-h-0 flex-1 overflow-hidden px-0.5 pb-0.5 pt-2 sm:px-1.5 sm:pb-1 sm:pt-3"}>
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden touch-pan-y"
          onClick={focusTerminal}
          onPointerDown={handleTerminalPointerDown}
        />
      </div>

      {showScrollToBottom ? (
        <div
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ bottom: `${floatingOverlayBottomPx}px` }}
        >
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
                ? "Live terminal input is read-only without operator access"
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

      {transportNotice && !showResumeRail ? (
        <div
          className="pointer-events-none absolute left-3 right-3 z-10"
          style={{ bottom: `${floatingOverlayBottomPx}px` }}
        >
          <div className="rounded-[12px] border border-white/8 bg-[#0f0a0a]/92 px-3 py-2 text-[12px] text-[#b8aea6] shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            {transportNotice}
          </div>
        </div>
      ) : null}

      {showLiveHelperBar ? (
        <div className="border-t border-white/8 bg-[#0b0808]/96 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="shrink-0 rounded-full border border-[#f3f0ea]/12 bg-[#f3f0ea] px-3 py-2 text-[11px] font-medium text-[#0d0909] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={focusTerminal}
              disabled={connectionState !== "live"}
            >
              Focus terminal
            </button>
            <button
              type="button"
              className="shrink-0 rounded-full border border-white/12 bg-white/6 px-3 py-2 text-[11px] text-[#d7cec7] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setHelperPanelOpen((current) => !current)}
              disabled={connectionState !== "live"}
              aria-expanded={helperPanelOpen}
            >
              {helperPanelOpen ? "Hide keys" : "Helper keys"}
            </button>
            <button
              type="button"
              className="shrink-0 rounded-full border border-white/12 bg-white/6 px-3 py-2 text-[11px] text-[#d7cec7] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={connectionState !== "live"}
            >
              Attach
            </button>
          </div>
          {helperPanelOpen ? (
            <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-1">
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
          ) : null}
          {sendError ? (
            <p className="mt-2 text-[12px] text-[#ff8f7a]">{sendError}</p>
          ) : null}
        </div>
      ) : null}

      {showResumeRail ? (
        <div className="border-t border-white/6 bg-[#080606]/98 px-3 py-3 sm:px-4 sm:pb-4">
          <div className="rounded-[20px] border border-[#2c221d] bg-[linear-gradient(180deg,rgba(29,22,20,0.98),rgba(18,14,13,0.98))] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_22px_44px_rgba(0,0,0,0.34)]">
            {attachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map(({ file }) => (
                  <button
                    key={`${file.name}-${file.lastModified}`}
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] text-[#d7cec7]"
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

            <div className="flex items-end gap-2.5">
              <div className="min-h-[38px] min-w-0 flex-1">
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
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={railPlaceholder}
                  className="min-h-[38px] w-full resize-none border-0 bg-transparent px-0.5 py-2.5 text-[14px] leading-7 text-[#efe8e1] outline-none placeholder:text-[#7d746e]"
                />
              </div>
              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#f3f0ea]/12 bg-[#f3f0ea] text-[#0d0909] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                disabled={sending || (!message.trim() && attachments.length === 0)}
                onClick={() => {
                  void handleSend();
                }}
                aria-label="Resume session"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-[#8c8078]">
              <span className="max-w-full truncate">{terminalContextLabel}</span>
              <span className="h-1 w-1 rounded-full bg-[#5f534d]" />
              <span>{attachments.length > 0 ? `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}` : "resume session"}</span>
            </div>
          </div>
          <p className="mt-2 px-1 text-[11px] text-[#8e847d]">{resumeComposerHint}</p>

          {sendError ? (
            <p className="mt-2 px-1 text-[12px] text-[#ff8f7a]">{sendError}</p>
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
