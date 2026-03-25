"use client";

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
import { RemoteSessionTerminal } from "@/components/sessions/RemoteSessionTerminal";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { LIVE_TERMINAL_STATUSES, RESUMABLE_STATUSES } from "./terminal/terminalConstants";
import { resolveTerminalConnection } from "./terminal/terminalApi";
import { terminalUrlNeedsReload } from "./terminal/terminalUrl";
import { calculateMobileTerminalViewportMetrics } from "./sessionTerminalUtils";
import type { SessionTerminalProps } from "./terminal/terminalTypes";

const TERMINAL_CLOSED_STATUSES = new Set(["archived", "killed", "terminated", "restored"]);
const TOKEN_REFRESH_LEAD_SECONDS = 10;

function computeTokenRefreshDelayMs(expiresInSeconds: number | null | undefined): number | null {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return null;
  }
  const safeSeconds = Math.max(5, expiresInSeconds - TOKEN_REFRESH_LEAD_SECONDS);
  return safeSeconds * 1000;
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
  const lastAppliedInsertNonceRef = useRef(0);
  const retryAttemptRef = useRef(0);
  const terminalHostRef = useRef<HTMLDivElement>(null);

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

  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [terminalLinkUrl, setTerminalLinkUrl] = useState<string | null>(null);
  const [terminalFrameReloadNonce, setTerminalFrameReloadNonce] = useState(0);
  const [resolvingConnection, setResolvingConnection] = useState(expectsLiveTerminal);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [connectionRefreshTick, setConnectionRefreshTick] = useState(0);
  const [promptMessage, setPromptMessage] = useState("");
  const [promptSending, setPromptSending] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [queuedInsertError, setQueuedInsertError] = useState<string | null>(null);
  const terminalUrlRef = useRef<string | null>(null);
  const forceTerminalReloadRef = useRef(false);

  useEffect(() => {
    terminalUrlRef.current = terminalUrl;
  }, [terminalUrl]);

  useEffect(() => {
    lastAppliedInsertNonceRef.current = 0;
    retryAttemptRef.current = 0;
    setTerminalUrl(null);
    setTerminalLinkUrl(null);
    setTerminalFrameReloadNonce(0);
    setResolvingConnection(expectsLiveTerminal);
    setConnectionError(null);
    setFrameLoaded(false);
    setConnectionRefreshTick(0);
    setPromptMessage("");
    setPromptSending(false);
    setPromptError(null);
    setQueuedInsertError(null);
    forceTerminalReloadRef.current = false;
  }, [expectsLiveTerminal, sessionId]);

  useEffect(() => {
    if (!expectsLiveTerminal) {
      setResolvingConnection(false);
      setConnectionError(null);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let refreshTimer: number | null = null;
    const abortController = new AbortController();
    setResolvingConnection(true);
    setConnectionError(null);

    void resolveTerminalConnection(sessionId, {
      signal: abortController.signal,
      bridgeId,
    })
      .then((connection) => {
        if (cancelled) return;
        retryAttemptRef.current = 0;
        if (connection.interactive && connection.terminalUrl) {
          const shouldReloadTerminal =
            forceTerminalReloadRef.current ||
            terminalUrlNeedsReload(terminalUrlRef.current, connection.terminalUrl);
          forceTerminalReloadRef.current = false;

          setTerminalLinkUrl(connection.terminalUrl);
          if (shouldReloadTerminal || !terminalUrlRef.current) {
            setFrameLoaded(false);
            setTerminalUrl(connection.terminalUrl);
            if (shouldReloadTerminal && terminalUrlRef.current) {
              setTerminalFrameReloadNonce((current) => current + 1);
            }
          }
          setConnectionError(null);

          const delayMs = computeTokenRefreshDelayMs(connection.expiresInSeconds);
          if (delayMs !== null) {
            refreshTimer = window.setTimeout(() => {
              setConnectionRefreshTick((current) => current + 1);
            }, delayMs);
          }
          return;
        }

        if (!terminalUrlRef.current) {
          setTerminalUrl(null);
          setTerminalLinkUrl(null);
          setFrameLoaded(false);
        }
        setConnectionError(connection.reason ?? "Live ttyd terminal is unavailable.");
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        const hasTerminal = !!terminalUrlRef.current;
        if (!hasTerminal) {
          setTerminalUrl(null);
          setTerminalLinkUrl(null);
          setFrameLoaded(false);
        }
        setConnectionError(
          error instanceof Error ? error.message : "Failed to resolve ttyd terminal.",
        );
        const attempt = retryAttemptRef.current;
        const delay = hasTerminal ? 5000 : Math.min(4000, 500 * 2 ** attempt);
        retryAttemptRef.current = hasTerminal ? 0 : Math.min(attempt + 1, 3);
        retryTimer = window.setTimeout(() => {
          setConnectionRefreshTick((current) => current + 1);
        }, delay);
      })
      .finally(() => {
        if (!cancelled) {
          setResolvingConnection(false);
        }
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
  }, [bridgeId, connectionRefreshTick, expectsLiveTerminal, sessionId]);

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

  const handlePromptSend = useCallback(async () => {
    const message = promptMessage.trim();
    if (message.length === 0 || promptSending) return;

    setPromptSending(true);
    setPromptError(null);
    try {
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
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Failed to send message (${response.status})`);
      }
      setPromptMessage("");
      promptInputRef.current?.focus();
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setPromptSending(false);
    }
  }, [bridgeId, promptMessage, promptSending, sessionId]);

  const applyKeyboardAwareTerminalHeight = useCallback(() => {
    const host = terminalHostRef.current;
    if (typeof window === "undefined" || !host) {
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

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) {
      return;
    }

    const applyGeometry = () => {
      applyKeyboardAwareTerminalHeight();
    };

    applyGeometry();

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        applyGeometry();
      });
    const visualViewport = typeof window === "undefined" ? null : window.visualViewport;

    observer?.observe(host);
    window.addEventListener("resize", applyGeometry);
    visualViewport?.addEventListener("resize", applyGeometry);
    visualViewport?.addEventListener("scroll", applyGeometry);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", applyGeometry);
      visualViewport?.removeEventListener("resize", applyGeometry);
      visualViewport?.removeEventListener("scroll", applyGeometry);
      host.style.removeProperty("height");
    };
  }, [applyKeyboardAwareTerminalHeight, expectsLiveTerminal, terminalUrl]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    window.__conductorSessionTerminalDebug = {
      sessionId,
      getState: () => ({
        mode: "ttyd-iframe",
        expectsLiveTerminal,
        runtimeMode: normalizedRuntimeMode,
        ttydBacked,
        terminalUrl,
        terminalLinkUrl,
        frameLoaded,
        resolvingConnection,
        connectionError,
        promptError,
        queuedInsertError,
        terminalFrameReloadNonce,
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
    frameLoaded,
    normalizedRuntimeMode,
    promptError,
    queuedInsertError,
    resolvingConnection,
    sessionId,
    terminalUrl,
    terminalLinkUrl,
    ttydBacked,
    terminalFrameReloadNonce,
  ]);

  const handleRetry = useCallback(() => {
    setConnectionError(null);
    retryAttemptRef.current = 0;
    forceTerminalReloadRef.current = true;
    setConnectionRefreshTick((current) => current + 1);
  }, []);

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
        : `Session status is \`${normalizedSessionStatus}\`. Interactive ttyd terminals only run while the agent is active.`);
  const terminalHref = terminalLinkUrl ?? terminalUrl ?? undefined;

  return (
    <div
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 sm:right-3 sm:top-3">
        {terminalHref ? (
          <a
            href={terminalHref}
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
          {resolvingConnection ? (
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
        {expectsLiveTerminal && terminalUrl ? (
          <div
            ref={terminalHostRef}
            className="relative h-full w-full overflow-hidden rounded-[10px] bg-[#060404]"
          >
            {!frameLoaded ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#060404]">
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#141010]/92 px-3 py-2 text-[12px] text-[#c9c0b7] backdrop-blur-sm">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading ttyd terminal…</span>
                </div>
              </div>
            ) : null}
            <iframe
              key={`${sessionId}:${terminalFrameReloadNonce}`}
              title={`ttyd terminal for ${sessionId}`}
              src={terminalUrl}
              className="h-full w-full border-0 bg-[#060404]"
              allow="clipboard-read; clipboard-write"
              loading="eager"
              onLoad={() => {
                setFrameLoaded(true);
                setConnectionError(null);
                applyKeyboardAwareTerminalHeight();
              }}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-lg rounded-[16px] border border-white/10 bg-[#141010]/92 p-5 text-[#efe8e1] shadow-[0_24px_48px_rgba(0,0,0,0.34)]">
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
                  {terminalHref ? (
                    <div className="mt-3">
                      <a
                        href={terminalHref}
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
        )}
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
              value={promptMessage}
              onChange={(event) => setPromptMessage(event.target.value)}
              placeholder="Send a follow-up message…"
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

function SessionTerminalContainer(props: SessionTerminalProps) {
  if (props.bridgeId?.trim()) {
    return <RemoteSessionTerminal {...props} />;
  }

  return <SessionTerminalView {...props} />;
}

export const SessionTerminal = memo(SessionTerminalContainer, sessionTerminalPropsEqual);
