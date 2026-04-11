"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";
import { withBridgeQuery } from "@/lib/bridgeQuery";

const TERMINAL_IFRAME_LOAD_TIMEOUT_MS = 15_000;

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
  bridgeId,
  pendingInsert,
  panelVisible = true,
  onPendingInsertConsumed,
}: SessionTerminalProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadTimerRef = useRef<number | null>(null);
  const lastAppliedInsertNonceRef = useRef(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [queuedInsertError, setQueuedInsertError] = useState<string | null>(null);

  const iframeSrc = useMemo(
    () => withBridgeQuery(`/embed/terminal/${encodeURIComponent(sessionId)}`, bridgeId),
    [bridgeId, sessionId],
  );

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
  }, [iframeSrc]);

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
          onPendingInsertConsumed?.();
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
  }, [bridgeId, onPendingInsertConsumed, pendingInsert, sessionId]);

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      {connectionError ? (
        <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[12px] text-red-200">
          {connectionError}
        </div>
      ) : null}
      {queuedInsertError ? (
        <div className="absolute inset-x-0 top-12 z-10 mx-auto w-fit rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[12px] text-amber-100">
          {queuedInsertError}
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title={`Conductor terminal ${sessionId}`}
        className="h-full w-full border-0 bg-[#060404]"
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
  );
}

export const SessionTerminal = memo(SessionTerminalView);
