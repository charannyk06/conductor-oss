"use client";

import React, { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, Paperclip, RefreshCw, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getTerminalTheme } from "@/components/terminal/xtermTheme";
import { extractLocalFileTransferPath, uploadProjectAttachments } from "./attachmentUploads";
import { captureTerminalViewport, type TerminalViewportState } from "./terminalViewport";
import {
  buildTerminalSnapshotPayload,
  buildTerminalSocketUrl,
  calculateMobileTerminalViewportMetrics,
  decodeTerminalBase64Payload,
  getSessionTerminalViewportOptions,
  prependTerminalModes,
  sanitizeRemoteTerminalSnapshot,
  type TerminalModeState,
  type TerminalWriteChunk,
} from "./sessionTerminalUtils";
import type { TerminalInsertRequest } from "./terminalInsert";

// --- Extracted modules ---
import {
  LIVE_TERMINAL_STATUSES,
  RESUMABLE_STATUSES,
  LIVE_TERMINAL_SCROLLBACK,
  READ_ONLY_TERMINAL_SNAPSHOT_LINES,
  LIVE_TERMINAL_HELPER_KEYS,
} from "./terminal/terminalConstants";
import type {
  TerminalSnapshot,
  TerminalServerEvent,
  TerminalStreamEventMessage,
} from "./terminal/terminalTypes";
import {
  readCachedTerminalSnapshot,
  storeCachedTerminalSnapshot,
  clearCachedTerminalSnapshot,
  readCachedTerminalUiState,
  storeCachedTerminalUiState,
  clearCachedTerminalConnection,
} from "./terminal/terminalCache";
import {
  fetchTerminalConnection,
  fetchTerminalSnapshot,
  fetchSessionStatus,
} from "./terminal/terminalApi";
import {
  decodeTerminalPayloadToString,
  shellEscapePath,
  shellEscapePaths,
  extractClipboardFiles,
  localFileTransferError,
  buildReadableSnapshotPayload,
  terminalHasRenderedContent,
  shouldShowTerminalAccessoryBar,
} from "./terminal/terminalHelpers";
import {
  loadTerminalCoreClientModules,
  loadTerminalWebglAddonModule,
  loadTerminalUnicode11AddonModule,
  loadTerminalWebLinksAddonModule,
} from "./terminal/useTerminalAddons";
import { useTerminalSearch } from "./terminal/useTerminalSearch";
import { useTerminalInput } from "./terminal/useTerminalInput";
import { useTerminalConnection } from "./terminal/useTerminalConnection";
import { useTerminalResize } from "./terminal/useTerminalResize";
import { useTerminalSnapshot } from "./terminal/useTerminalSnapshot";

// ---------------------------------------------------------------------------

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
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const inputDisposableRef = useRef<IDisposable | null>(null);
  const scrollDisposableRef = useRef<IDisposable | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const latestStatusRef = useRef(sessionState);
  const activeRef = useRef(active);
  const pageVisibleRef = useRef(typeof document === "undefined" ? true : !document.hidden);
  const previousLiveTerminalRef = useRef(false);
  const lastAppliedInsertNonceRef = useRef<number>(0);
  const expectsLiveTerminalRef = useRef(false);

  const initialUiState = readCachedTerminalUiState(sessionId);

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

  // --- Derived state ---
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
  pageVisibleRef.current = pageVisible;

  // --- Extracted hooks ---
  const {
    sendResize,
    sendTerminalKeys,
    sendTerminalSpecial,
    clearScheduledTerminalHttpControlFlush,
    terminalHttpControlQueueRef,
    terminalHttpControlInFlightRef,
    interactiveTerminalRef: inputInteractiveRef,
  } = useTerminalInput(sessionId);

  // Keep the input hook's interactivity ref in sync
  inputInteractiveRef.current = interactiveTerminal;

  const {
    pendingResizeSyncRef,
    lastSyncedTerminalSizeRef,
    lastObservedContainerSizeRef,
    lastViewportOptionKeyRef,
    pendingViewportRestoreRef,
    preferredFocusTargetRef,
    restoreFocusOnRecoveryRef,
    showScrollToBottom,
    setShowScrollToBottom: _setShowScrollToBottom,
    syncTerminalDimensions,
    scheduleRendererRecovery,
    clearScheduledRecovery,
    clearVisibilityRecoveryTimers,
    applyViewportRestore,
    updateScrollState,
    rememberTerminalViewport,
    rememberFocusedSurface,
    restorePreferredFocus,
  } = useTerminalResize(
    sessionId,
    termRef,
    fitRef,
    containerRef,
    resumeTextareaRef,
    sendResize,
    setTransportError,
    initialUiState?.viewport ?? null,
  );

  const {
    terminalWriteQueueRef,
    terminalWriteInFlightRef,
    terminalWriteRestoreFocusRef,
    terminalWriteDecoderRef,
    snapshotAppliedRef,
    snapshotAnsiRef,
    snapshotTranscriptRef,
    snapshotModesRef,
    liveOutputStartedRef,
    lastTerminalSequenceRef,
    queueTerminalWrite,
    requestSnapshotRender,
    clearScheduledTerminalFlush,
  } = useTerminalSnapshot(
    sessionId,
    termRef,
    applyViewportRestore,
    updateScrollState,
    restorePreferredFocus,
  );

  const {
    eventSourceRef,
    reconnectCountRef,
    connectAttemptRef,
    hasConnectedOnceRef,
    reconnectNoticeWrittenRef,
    clearReconnectTimer,
    scheduleReconnect,
    requestReconnect,
  } = useTerminalConnection(
    sessionId,
    pendingResizeSyncRef,
    setTransportError,
    setTransportNotice,
    setConnectionState,
    setSocketBaseUrl,
    setReconnectToken,
  );

  const { searchRef, runSearch } = useTerminalSearch({
    searchOpen,
    searchQuery,
    termRef,
  });

  // Keep snapshot refs in sync with React state
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

  // --- Stable callback refs for use inside useEffects ---
  const requestSnapshotRenderRef = useRef(requestSnapshotRender);
  const updateScrollStateRef = useRef(updateScrollState);
  const clearScheduledTerminalFlushRef = useRef(clearScheduledTerminalFlush);
  const scheduleRendererRecoveryRef = useRef<(forceResize: boolean) => void>(scheduleRendererRecovery);

  useEffect(() => { requestSnapshotRenderRef.current = requestSnapshotRender; }, [requestSnapshotRender]);
  useEffect(() => { updateScrollStateRef.current = updateScrollState; }, [updateScrollState]);
  useEffect(() => { clearScheduledTerminalFlushRef.current = clearScheduledTerminalFlush; }, [clearScheduledTerminalFlush]);
  useEffect(() => { scheduleRendererRecoveryRef.current = scheduleRendererRecovery; }, [scheduleRendererRecovery]);

  // --- Callbacks ---
  const normalizeWhitespaceOnlyDraft = useCallback(() => {
    setMessage((current) => (current.trim().length === 0 ? "" : current));
  }, []);

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
  }, [lastTerminalSequenceRef, requestSnapshotRender, sessionId, snapshotAppliedRef, snapshotAnsiRef, snapshotModesRef, snapshotTranscriptRef]);

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

  // --- Effects ---

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
  }, [expectsLiveTerminal, liveOutputStartedRef, snapshotAppliedRef]);

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

  // Reset state when sessionId changes
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
    _setShowScrollToBottom(false);
    setSnapshotReady(cachedSnapshot !== null);
    setSnapshotAnsi(cachedSnapshot?.snapshot ?? "");
    setSnapshotTranscript(cachedSnapshot?.transcript ?? "");
    setSnapshotModes(cachedSnapshot?.modes);
    setSessionStatusOverride(null);
    setMobileViewportHeight(null);
    setMobileKeyboardVisible(false);
    termRef.current?.reset();
    updateScrollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    setSessionStatusOverride(null);
  }, [sessionState]);

  // Snapshot fetch effect
  useEffect(() => {
    let mounted = true;
    const cachedSnapshot = expectsLiveTerminal ? null : readCachedTerminalSnapshot(sessionId);
    const hasCachedSnapshot = cachedSnapshot !== null;
    setSnapshotReady(hasCachedSnapshot);

    if (!active) {
      return () => { mounted = false; };
    }

    if (expectsLiveTerminal) {
      if (!shouldStreamLiveTerminal) {
        return () => { mounted = false; };
      }

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

      return () => { mounted = false; };
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

    return () => { mounted = false; };
  }, [active, applyFetchedSnapshot, expectsLiveTerminal, lastTerminalSequenceRef, liveOutputStartedRef, sessionId, shouldStreamLiveTerminal, snapshotAppliedRef, snapshotAnsiRef, snapshotModesRef, snapshotTranscriptRef]);

  // Connection resolution effect
  useEffect(() => {
    let mounted = true;

    if (!expectsLiveTerminal || !shouldStreamLiveTerminal) {
      setSocketBaseUrl(null);
      setConnectionState("closed");
      setTransportError(null);
      return () => { mounted = false; };
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

    return () => { mounted = false; };
  }, [expectsLiveTerminal, reconnectToken, sessionId, shouldStreamLiveTerminal]);

  // --- Event handlers (useEffectEvent) ---
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

  // --- Terminal init effect ---
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
      const isMobileViewport = shouldShowTerminalAccessoryBar();
      const terminalOptions: ITerminalOptions & { scrollbar?: { showScrollbar: boolean } } = {
        allowTransparency: false,
        cursorBlink: true,
        cursorStyle: "block",
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
          showScrollbar: !isMobileViewport,
        },
      };
      term = new xtermMod.Terminal(terminalOptions);
      fit = new fitMod.FitAddon();
      term.loadAddon(fit);

      term.open(containerRef.current);
      fit.fit();

      void loadTerminalWebglAddonModule()
        .then((webglMod) => {
          if (!mounted || termRef.current !== term) return;
          const webglAddon = new webglMod.WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
          });
          term!.loadAddon(webglAddon);
        })
        .catch(() => {});

      void loadTerminalUnicode11AddonModule()
        .then((unicode11Mod) => {
          if (!mounted || termRef.current !== term) return;
          const unicode11Addon = new unicode11Mod.Unicode11Addon();
          term!.loadAddon(unicode11Addon);
          term!.unicode.activeVersion = "11";
        })
        .catch(() => {});

      void loadTerminalWebLinksAddonModule()
        .then((webLinksMod) => {
          if (!mounted || termRef.current !== term) return;
          const webLinksAddon = new webLinksMod.WebLinksAddon();
          term!.loadAddon(webLinksAddon);
        })
        .catch(() => {});

      termRef.current = term;
      fitRef.current = fit;
      lastSyncedTerminalSizeRef.current = null;
      pendingResizeSyncRef.current = true;
      lastObservedContainerSizeRef.current = `${Math.round(containerRef.current.clientWidth)}x${Math.round(containerRef.current.clientHeight)}`;
      lastViewportOptionKeyRef.current = `${viewportOptions.fontFamily}:${viewportOptions.fontSize}:${viewportOptions.lineHeight}`;
      term.options.disableStdin = !expectsLiveTerminalRef.current || !inputInteractiveRef.current;
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
      return () => { mounted = false; };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, shouldAttachTerminalSurface]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.disableStdin = !expectsLiveTerminal || !interactiveTerminal;
  }, [expectsLiveTerminal, interactiveTerminal]);

  // Active pane recovery effect
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
      const timers: number[] = [];
      timers.push(window.setTimeout(() => {
        scheduleRendererRecovery(true);
      }, 48));
      timers.push(window.setTimeout(() => {
        scheduleRendererRecovery(true);
      }, 140));
    });

    return () => {
      window.cancelAnimationFrame(frameHandle);
      clearVisibilityRecoveryTimers();
    };
  }, [active, clearVisibilityRecoveryTimers, connectionState, expectsLiveTerminal, requestReconnect, scheduleRendererRecovery]);

  // Snapshot render effect
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
    liveOutputStartedRef,
    sessionId,
    snapshotAnsi,
    snapshotAppliedRef,
    snapshotTranscript,
    snapshotModes,
    snapshotReady,
    terminalReady,
    queueTerminalWrite,
    updateScrollState,
    canRenderTerminal,
  ]);

  // Debug state effect
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
    liveOutputStartedRef,
    sessionId,
    snapshotAnsi,
    snapshotAppliedRef,
    snapshotTranscript,
    snapshotReady,
    terminalReady,
  ]);

  // Visibility/focus effect
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

  // Cleanup when not streaming
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldStreamLiveTerminal, sessionId, expectsLiveTerminal]);

  // EventSource connection effect
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clearReconnectTimer,
    sessionId,
    shouldStreamLiveTerminal,
    socketBaseUrl,
    terminalReady,
  ]);

  // Auto-reconnect scheduling effect
  useEffect(() => {
    if (!terminalReady || !shouldStreamLiveTerminal) {
      return;
    }

    const source = eventSourceRef.current;
    if (source && (source.readyState === EventSource.CONNECTING || source.readyState === EventSource.OPEN)) {
      return;
    }

    if (connectionState !== "closed" && connectionState !== "error") {
      return;
    }

    // Don't schedule if timer already pending
    // (reconnectTimerRef not exposed, but scheduleReconnect clears existing)
    scheduleReconnect();
  }, [connectionState, scheduleReconnect, shouldStreamLiveTerminal, terminalReady, eventSourceRef]);

  // Global cleanup effect
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paste handling effect
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

  // --- Send handler ---
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

  // Pending insert effect
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
  }, [preferredFocusTargetRef, restoreFocusOnRecoveryRef, updateScrollState]);

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
  }, [expectsLiveTerminal, preferredFocusTargetRef, restoreFocusOnRecoveryRef, scheduleRendererRecovery]);

  const handleTerminalPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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

  // Touch/wheel scroll effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const wheelListener = (event: WheelEvent) => {
      handleTerminalWheel(event);
    };

    let touchLastY: number | null = null;
    let touchScrolled = false;
    let touchAccumY = 0;
    let touchVelocity = 0;
    let touchLastTime = 0;
    let momentumFrame: number | null = null;

    const LINE_HEIGHT_PX = 16;
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

      if (term.buffer.active.baseY > 0) {
        touchScrolled = true;
        touchAccumY += deltaY;

        const lines = Math.trunc(touchAccumY / LINE_HEIGHT_PX);
        if (lines !== 0) {
          touchAccumY -= lines * LINE_HEIGHT_PX;
          term.scrollLines(lines);
        }

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
        focusTerminal();
      } else if (touchScrolled && Math.abs(touchVelocity) >= MOMENTUM_MIN_VELOCITY) {
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

  // --- Render ---
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
            <span className="text-[11px]">&#x2191;</span>
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6 text-[#c9c0b7]" onClick={() => runSearch("next")} aria-label="Find next">
            <span className="text-[11px]">&#x2193;</span>
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
