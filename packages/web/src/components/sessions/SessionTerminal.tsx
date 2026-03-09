"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import type { ITerminalOptions, IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { AlertCircle, ChevronDown, Loader2, Paperclip, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useSessionFeed } from "@/hooks/useSessionFeed";

interface SessionTerminalProps {
  sessionId: string;
  agentName: string;
  projectId: string;
  sessionModel: string;
  sessionReasoningEffort: string;
  sessionState: string;
  active: boolean;
}

type TerminalConnectionInfo = {
  wsUrl: string;
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

function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

function getTerminalTheme(): NonNullable<ITerminalOptions["theme"]> {
  return {
    background: "#0d0909",
    foreground: "#e8dfd7",
    cursor: "#f5f2ee",
    cursorAccent: "#0d0909",
    selectionBackground: "rgba(255,255,255,0.16)",
    black: "#181212",
    red: "#ff8f7a",
    green: "#a5d6a7",
    yellow: "#f6d58c",
    blue: "#89b4fa",
    magenta: "#d4a5ff",
    cyan: "#88d8d8",
    white: "#ede5de",
    brightBlack: "#6f6660",
    brightRed: "#ffb19d",
    brightGreen: "#bfe5c0",
    brightYellow: "#ffe2a8",
    brightBlue: "#b4ccff",
    brightMagenta: "#e1c2ff",
    brightCyan: "#a7ebeb",
    brightWhite: "#fff8f2",
  };
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

function buildTerminalSocketUrl(baseUrl: string, cols: number, rows: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("cols", String(Math.max(1, cols)));
  url.searchParams.set("rows", String(Math.max(1, rows)));
  return url.toString();
}

export function SessionTerminal({
  sessionId,
  agentName,
  projectId,
  sessionModel,
  sessionReasoningEffort,
  sessionState,
  active,
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
  const latestStatusRef = useRef(sessionState);
  const activeRef = useRef(active);
  const viewportRef = useRef<HTMLElement | null>(null);

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

  const connectionLabel = transportError
    ? transportError
    : connectionState === "live"
      ? "Live terminal"
      : expectsLiveTerminal
        ? "Connecting terminal..."
        : "Session terminal";

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

      const [xtermMod, fitMod, searchMod, webglMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-webgl"),
      ]);

      if (!mounted || !containerRef.current) return;

      term = new xtermMod.Terminal({
        allowTransparency: false,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: false,
        drawBoldTextInBrightColors: false,
        fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'SFMono-Regular', monospace",
        fontSize: window.innerWidth < 640 ? 13 : 14,
        fastScrollSensitivity: 4,
        lineHeight: 1.18,
        scrollSensitivity: 1.1,
        scrollback: 8000,
        theme: getTerminalTheme(),
      });

      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      const searchAddon = new searchMod.SearchAddon();
      term.loadAddon(searchAddon);
      term.open(containerRef.current);
      fit.fit();

      try {
        term.loadAddon(new webglMod.WebglAddon());
      } catch {
        // Fall back to the default DOM renderer when WebGL is unavailable.
      }

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

      const viewport = containerRef.current.querySelector<HTMLElement>(".xterm-viewport");
      viewportRef.current = viewport;
      const handleViewportWheel = (event: WheelEvent) => {
        event.stopPropagation();
        if (activeRef.current) {
          term?.focus();
        }
      };
      viewport?.addEventListener("wheel", handleViewportWheel, { passive: true });

      resizeObserverRef.current = new ResizeObserver(() => {
        if (!activeRef.current) {
          return;
        }
        try {
          fit?.fit();
        } catch {
          return;
        }
        sendResize();
        updateScrollState();
      });
      resizeObserverRef.current.observe(containerRef.current);

      return () => {
        viewport?.removeEventListener("wheel", handleViewportWheel);
      };
    }

    let cleanupViewport: (() => void) | undefined;
    void init().then((cleanup) => {
      cleanupViewport = cleanup;
    });

    return () => {
      mounted = false;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      cleanupViewport?.();
      viewportRef.current = null;
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      setTerminalReady(false);
    };
  }, [sendResize, updateScrollState]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sendResize();
      updateScrollState();
      term.focus();
    });

    return () => {
      window.cancelAnimationFrame(handle);
    };
  }, [active, sendResize, updateScrollState]);

  useEffect(() => {
    if (!terminalReady || !socketBaseUrl || !termRef.current) return;

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
      term.reset();
      updateScrollState();
      if (activeRef.current) {
        sendResize();
        term.focus();
      }
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
        term.write(new Uint8Array(event.data));
        updateScrollState();
      }
    };

    socket.onclose = () => {
      if (connectAttemptRef.current !== attemptId) return;
      socketRef.current = null;
      const shouldRetry = LIVE_TERMINAL_STATUSES.has(latestStatusRef.current);
      if (shouldRetry) {
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
  }, [clearReconnectTimer, reconnectToken, scheduleReconnect, sendResize, socketBaseUrl, terminalReady, updateScrollState]);

  useEffect(() => () => {
    clearReconnectTimer();
    socketRef.current?.close();
  }, [clearReconnectTimer]);

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

  const connectionToneClass = transportError
    ? "text-[#ff8f7a]"
    : connectionState === "live"
      ? "text-[#d4ccc4]"
      : "text-[#8e847d]";

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

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#0d0909]"
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
      <div className="flex items-center justify-between border-b border-white/8 bg-black/30 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <div className="pointer-events-none flex items-center gap-2 rounded-full border border-white/8 bg-black/45 px-2.5 py-1 text-[11px] backdrop-blur-sm">
            {connectionState === "connecting"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8e847d]" />
              : transportError
                ? <AlertCircle className="h-3.5 w-3.5 text-[#ff8f7a]" />
                : null}
            <span className={connectionToneClass}>{connectionLabel}</span>
            {agentName
              ? <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7d746e]">{agentName}</span>
              : null}
          </div>
          {searchOpen ? (
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-[#141010]/95 px-1.5 py-1">
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
                    setSearchOpen(false);
                  }
                }}
                placeholder="Search terminal"
                className="w-40 bg-transparent text-[12px] text-[#efe8e1] outline-none placeholder:text-[#7d746e]"
              />
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => runSearch("prev")} aria-label="Find previous">
                <span className="text-[11px]">↑</span>
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={() => runSearch("next")} aria-label="Find next">
                <span className="text-[11px]">↓</span>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                  if (activeRef.current) {
                    termRef.current?.focus();
                  }
                }}
                aria-label="Close search"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {!searchOpen ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-full border border-white/8 bg-black/30 text-[#c9c0b7]"
              onClick={() => setSearchOpen(true)}
              aria-label="Search terminal"
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {showScrollToBottom ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-full border border-white/8 bg-black/30 text-[#c9c0b7]"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-2 py-2" />

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
        <div className="border-t border-white/8 bg-[#141010]/96 px-3 py-3">
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
              value={message}
              onChange={(event) => setMessage(event.target.value)}
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
