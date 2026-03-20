"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useBridgeTunnel } from "@/hooks/useBridgeTunnel";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

interface BridgeSessionTerminalProps extends SessionTerminalProps {
  scope?: string;
  readOnly?: boolean;
}

function extractOutputText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }
  if (response && typeof response === "object") {
    const payload = response as { output?: unknown };
    if (typeof payload.output === "string") {
      return payload.output;
    }
  }
  return "";
}

function getTerminalColumns(): number {
  if (typeof window === "undefined") return 120;
  return window.innerWidth < 640 ? 80 : 120;
}

function getTerminalRows(): number {
  if (typeof window === "undefined") return 32;
  return window.innerWidth < 640 ? 24 : 36;
}

export function BridgeSessionTerminal({
  sessionId,
  sessionState,
  pendingInsert,
  immersiveMobileMode = false,
  scope = "conductor-bridge-control",
  readOnly = false,
}: BridgeSessionTerminalProps) {
  const {
    connected,
    bridgeStatus,
    error,
    terminalChunk,
    terminalSequence,
    requestApi,
    sendTerminalInput,
    sendTerminalResize,
  } = useBridgeTunnel(scope);
  const [output, setOutput] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [loadingOutput, setLoadingOutput] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const lastAppliedInsertNonceRef = useRef(0);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const sessionLabel = sessionState.trim().replace(/[_-]+/g, " ");

  useEffect(() => {
    lastAppliedInsertNonceRef.current = 0;
    setOutput("");
    setInputValue("");
    setLoadingOutput(true);
    setRequestError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!terminalChunk) return;
    setOutput((current) => {
      if (terminalChunk.startsWith("\u000c")) {
        return terminalChunk.slice(1);
      }
      return `${current}${terminalChunk}`;
    });
  }, [terminalChunk, terminalSequence]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    let cancelled = false;
    setLoadingOutput(true);
    setRequestError(null);

    void requestApi("GET", `/api/sessions/${encodeURIComponent(sessionId)}/output?lines=500`)
      .then((response) => {
        if (cancelled) return;
        setOutput(extractOutputText(response));
        setLoadingOutput(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadingOutput(false);
        setRequestError(err instanceof Error ? err.message : "Failed to load bridge terminal output.");
      });

    return () => {
      cancelled = true;
    };
  }, [connected, requestApi, sessionId]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    const emitResize = () => {
      sendTerminalResize(getTerminalColumns(), getTerminalRows());
    };

    emitResize();
    window.addEventListener("resize", emitResize);
    return () => {
      window.removeEventListener("resize", emitResize);
    };
  }, [connected, sendTerminalResize]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    if (!pendingInsert || pendingInsert.nonce <= lastAppliedInsertNonceRef.current) {
      return;
    }

    lastAppliedInsertNonceRef.current = pendingInsert.nonce;
    const inlineText = pendingInsert.inlineText.trim();
    if (inlineText.length === 0) {
      return;
    }

    sendTerminalInput(`${inlineText} `);
  }, [connected, pendingInsert, sendTerminalInput]);

  useEffect(() => {
    const viewport = outputScrollRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [output]);

  const statusLine = connected
    ? bridgeStatus?.connected === false
      ? "Bridge disconnected"
      : `Bridge ${bridgeStatus?.hostname ?? "connected"}`
    : `Bridge offline${sessionLabel ? ` · ${sessionLabel}` : ""}`;

  const emptyStateDescription = error
    ?? requestError
    ?? (connected
      ? "Loading live session output from the bridge."
      : `Waiting for the bridge relay to come online${sessionLabel ? ` for ${sessionLabel}` : ""}.`);

  return (
    <div
      className={immersiveMobileMode
        ? "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-[#060404]"
        : "group/terminal relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden rounded-none border-0 bg-[#060404] lg:rounded-[14px] lg:border lg:border-white/10 lg:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"}
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-2 sm:right-3 sm:top-3">
        <span className="inline-flex h-9 items-center rounded-full border border-white/10 bg-[#141010]/92 px-3 text-[11px] text-[#c9c0b7] backdrop-blur-sm sm:h-7">
          {statusLine}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-full border border-white/10 bg-[#141010]/92 text-[#c9c0b7] backdrop-blur-sm hover:bg-[#201818] sm:h-7 sm:w-7"
          onClick={() => {
            setLoadingOutput(true);
            void requestApi("GET", `/api/sessions/${encodeURIComponent(sessionId)}/output?lines=500`)
              .then((response) => {
                setOutput(extractOutputText(response));
                setLoadingOutput(false);
                setRequestError(null);
              })
              .catch((err) => {
                setLoadingOutput(false);
                setRequestError(err instanceof Error ? err.message : "Failed to refresh bridge terminal.");
              });
          }}
          aria-label="Reload bridge terminal"
        >
          {loadingOutput ? (
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
        <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#060404] text-[#efe8e1]">
          <div ref={outputScrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
            {output.length > 0 ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[#efe8e1]">
                {output}
              </pre>
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-lg rounded-[16px] border border-white/10 bg-[#141010]/92 p-5 text-[#efe8e1] shadow-[0_24px_48px_rgba(0,0,0,0.34)]">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-full border border-white/10 bg-[#201818] p-2 text-[#c9c0b7]">
                      {error || requestError ? (
                        <AlertCircle className="h-4 w-4" />
                      ) : (
                        <Loader2 className={`h-4 w-4 ${loadingOutput ? "animate-spin" : ""}`} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium">Connecting bridge terminal</div>
                      <div className="mt-1 text-[12px] leading-5 text-[#a79c94]">
                        {emptyStateDescription}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {readOnly ? (
            <div className="border-t border-white/10 bg-[#101010] px-3 py-2 text-[11px] text-[#a79c94]">
              Read-only share
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!connected) return;
                const value = inputValue.trim();
                if (value.length === 0) return;
                sendTerminalInput(`${value}\n`);
                setInputValue("");
              }}
              className="border-t border-white/10 bg-[#101010] px-2 py-2"
            >
              {error || requestError ? (
                <div className="mb-2 flex items-center gap-1.5 rounded-md border border-[rgba(255,143,122,0.22)] bg-[rgba(255,143,122,0.08)] px-2 py-1.5 text-[11px] text-[#ffb39e]">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  <span className="truncate">{error ?? requestError}</span>
                  <button
                    type="button"
                    className="ml-auto shrink-0 text-[#8e847d] hover:text-[#c9c0b7]"
                    onClick={() => {
                      setRequestError(null);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  placeholder="Type a command and press Enter…"
                  className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-[#0c0808] px-3 text-[12px] text-[#efe8e1] outline-none placeholder:text-[#7d746e] focus:border-white/20"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.currentTarget.blur();
                    }
                  }}
                />
                <Button
                  type="submit"
                  size="icon"
                  variant="ghost"
                  disabled={inputValue.trim().length === 0 || !connected}
                  className="h-9 w-9 shrink-0 rounded-md border border-white/10 bg-[#0c0808] text-[#c9c0b7] hover:bg-[#201818] disabled:opacity-30"
                  aria-label="Send terminal input"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
