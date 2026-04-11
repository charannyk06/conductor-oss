"use client";

import {
  AlertCircle,
  Clipboard,
  ExternalLink,
  FileUp,
  Loader2,
  RefreshCw,
  SquareStop,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Button } from "@/components/ui/Button";
import { uploadProjectAttachments } from "@/components/sessions/attachmentUploads";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";
import { LIVE_TERMINAL_STATUSES } from "@/components/sessions/terminal/terminalConstants";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { buildSessionHref } from "@/lib/dashboardHref";

const TERMINAL_IFRAME_LOAD_TIMEOUT_MS = 15_000;
const TERMINAL_CLOSED_STATUSES = new Set(["archived", "killed", "terminated", "restored"]);

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

function SessionTerminalView({
  sessionId,
  projectId,
  bridgeId,
  sessionState,
  runtimeMode,
  pendingInsert,
  immersiveMobileMode = false,
  panelVisible = true,
  onPendingInsertConsumed,
}: SessionTerminalProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const loadTimerRef = useRef<number | null>(null);
  const lastAppliedInsertNonceRef = useRef(0);
  const pendingInsertNonceRef = useRef<number | null>(null);

  const [frameLoaded, setFrameLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [queuedInsertError, setQueuedInsertError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const iframeSrc = useMemo(
    () => withBridgeQuery(`/embed/terminal/${encodeURIComponent(sessionId)}`, bridgeId),
    [bridgeId, sessionId],
  );

  const normalizedSessionStatus = useMemo(
    () => sessionState.trim().toLowerCase(),
    [sessionState],
  );
  const normalizedRuntimeMode = runtimeMode?.trim().toLowerCase() ?? null;
  const sessionClosed = TERMINAL_CLOSED_STATUSES.has(normalizedSessionStatus);
  const liveRuntimeExpected = normalizedRuntimeMode === "direct"
    ? !sessionClosed
    : LIVE_TERMINAL_STATUSES.has(normalizedSessionStatus);
  const terminalSessionHref = buildSessionHref(sessionId, { bridgeId, tab: "terminal" });

  useEffect(() => {
    setFrameLoaded(false);
    setConnectionError(null);
    if (loadTimerRef.current !== null) {
      window.clearTimeout(loadTimerRef.current);
    }
    loadTimerRef.current = window.setTimeout(() => {
      setConnectionError("The embedded terminal did not finish loading in time.");
    }, TERMINAL_IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      if (loadTimerRef.current !== null) {
        window.clearTimeout(loadTimerRef.current);
        loadTimerRef.current = null;
      }
    };
  }, [iframeSrc, reloadNonce]);

  useEffect(() => {
    if (!pendingInsert) {
      return;
    }
    if (pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }
    if (pendingInsertNonceRef.current === pendingInsert.nonce) {
      return;
    }

    const inlineText = pendingInsert.inlineText.trim();
    if (inlineText.length === 0) {
      lastAppliedInsertNonceRef.current = pendingInsert.nonce;
      onPendingInsertConsumed?.();
      return;
    }

    pendingInsertNonceRef.current = pendingInsert.nonce;
    let cancelled = false;
    void sendTerminalKeys(sessionId, `${inlineText} `, bridgeId)
      .then(() => {
        if (cancelled) {
          return;
        }
        lastAppliedInsertNonceRef.current = pendingInsert.nonce;
        pendingInsertNonceRef.current = null;
        setQueuedInsertError(null);
        onPendingInsertConsumed?.();
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        pendingInsertNonceRef.current = null;
        setQueuedInsertError(
          error instanceof Error ? error.message : "Failed to queue terminal input.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeId, onPendingInsertConsumed, pendingInsert, sessionId]);

  const handleRetry = useCallback(() => {
    setConnectionError(null);
    setFrameLoaded(false);
    setReloadNonce((value) => value + 1);
  }, []);

  const handleAttachmentPick = useCallback(() => {
    attachmentInputRef.current?.click();
  }, []);

  const handleAttachmentFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    event.target.value = "";
    if (!files || files.length === 0) {
      return;
    }

    setAttachmentUploading(true);
    setAttachmentError(null);
    try {
      const uploadedPaths = await uploadProjectAttachments({
        files: Array.from(files),
        projectId,
        taskRef: sessionId,
        bridgeId,
      });
      for (const path of uploadedPaths) {
        await sendTerminalKeys(sessionId, `\r\n[attached file: ${path}]\r\n`, bridgeId);
      }
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Failed to upload attachment.",
      );
    } finally {
      setAttachmentUploading(false);
    }
  }, [bridgeId, projectId, sessionId]);

  const handleMobilePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        await sendTerminalKeys(sessionId, text, bridgeId);
        setQueuedInsertError(null);
      }
    } catch {
      setQueuedInsertError("Clipboard paste failed.");
    }
  }, [bridgeId, sessionId]);

  const handleSoftStop = useCallback(async () => {
    try {
      await sendTerminalKeys(sessionId, "\x03", bridgeId);
      setQueuedInsertError(null);
    } catch (error) {
      setQueuedInsertError(
        error instanceof Error ? error.message : "Failed to send Ctrl+C.",
      );
    }
  }, [bridgeId, sessionId]);

  return (
    <div
      className={immersiveMobileMode
        ? "group/terminal relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      <div className="absolute right-2 top-2 z-20 flex items-center gap-2 sm:right-3 sm:top-3">
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          accept="*/*"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => void handleAttachmentFiles(event)}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] disabled:opacity-40 sm:h-7 sm:w-7"
          onClick={handleAttachmentPick}
          aria-label="Attach files"
          disabled={attachmentUploading}
        >
          {attachmentUploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileUp className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          asChild
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
        >
          <a
            href={terminalSessionHref}
            target="_blank"
            rel="noreferrer"
            aria-label="Open terminal in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={() => void handleMobilePaste()}
          aria-label="Paste from clipboard"
        >
          <Clipboard className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={() => void handleSoftStop()}
          aria-label="Soft stop terminal"
        >
          <SquareStop className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={handleRetry}
          aria-label="Reload terminal"
        >
          {!frameLoaded ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div
        className={immersiveMobileMode
          ? "min-h-0 min-w-0 h-0 flex-1 overflow-hidden px-0 pb-[env(safe-area-inset-bottom)] pt-0 w-full"
          : "min-h-0 min-w-0 h-0 flex-1 overflow-hidden px-0.5 pb-0 pt-0.5 lg:px-1.5 lg:pb-1 lg:pt-3 w-full"}
      >
        <div className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[10px] bg-[#060404] pb-[env(safe-area-inset-bottom)]">
          {!frameLoaded ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#060404]">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#141010]/92 px-3 py-2 text-[12px] text-[#c9c0b7] backdrop-blur-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Loading terminal…</span>
              </div>
            </div>
          ) : null}
          {connectionError ? (
            <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[12px] text-red-200">
              {connectionError}
            </div>
          ) : null}
          <iframe
            key={`${sessionId}:${reloadNonce}`}
            ref={iframeRef}
            src={iframeSrc}
            title={`Conductor terminal ${sessionId}`}
            className="block h-full min-h-0 w-full flex-1 border-0 bg-[#060404]"
            allow="clipboard-read; clipboard-write"
            loading="eager"
            onError={() => {
              setConnectionError("Failed to load the terminal frame.");
            }}
            onLoad={() => {
              setFrameLoaded(true);
              setConnectionError(null);
              if (loadTimerRef.current !== null) {
                window.clearTimeout(loadTimerRef.current);
                loadTimerRef.current = null;
              }
            }}
          />
          {!panelVisible && !frameLoaded ? (
            <div className="pointer-events-none absolute inset-0 bg-[#060404]" />
          ) : null}
        </div>
      </div>

      {queuedInsertError || attachmentError ? (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/12 bg-[#161212] px-3 py-2 text-[11px] text-[#ffb39e] backdrop-blur-sm [padding-bottom:env(safe-area-inset-bottom)]">
          {queuedInsertError ? (
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
          ) : null}
          {attachmentError ? (
            <div className={`flex items-center gap-1.5 ${queuedInsertError ? "mt-2" : ""}`}>
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{attachmentError}</span>
              <button
                type="button"
                className="ml-auto shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
                onClick={() => setAttachmentError(null)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const SessionTerminal = memo(SessionTerminalView);
