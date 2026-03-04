"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MessageCircleDashed,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { useSessionOutputStream } from "@/hooks/useSessionOutputStream";

interface ChatPanelProps {
  sessionId: string;
  agentName?: string;
}

interface DiffFile {
  additions: number;
  deletions: number;
}

interface DiffPayload {
  hasDiff?: boolean;
  files?: DiffFile[];
  untracked?: string[];
}

interface DiffSummary {
  hasDiff: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
}

const EMPTY_SUMMARY: DiffSummary = {
  hasDiff: false,
  filesChanged: 0,
  additions: 0,
  deletions: 0,
};

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function parseBlocks(raw: string): string[] {
  return raw
    .split(/\n{2,}/)
    .map((block) => stripAnsi(block).trim())
    .filter((block) => block.length > 0)
    .slice(-120);
}

function summarizeDiff(payload: DiffPayload): DiffSummary {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const untracked = Array.isArray(payload.untracked) ? payload.untracked : [];
  const filesChanged = files.length + untracked.length;
  const additions = files.reduce((sum, file) => sum + Math.max(0, file.additions), 0);
  const deletions = files.reduce((sum, file) => sum + Math.max(0, file.deletions), 0);
  const hasDiff = Boolean(payload.hasDiff) || filesChanged > 0;

  return {
    hasDiff,
    filesChanged,
    additions,
    deletions,
  };
}

export function ChatPanel({ sessionId, agentName }: ChatPanelProps) {
  const encodedSessionId = encodeURIComponent(sessionId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [diffSummary, setDiffSummary] = useState<DiffSummary>(EMPTY_SUMMARY);
  const [diffError, setDiffError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const {
    output,
    connected,
    error: streamError,
    refresh,
  } = useSessionOutputStream(sessionId, { lines: 900, pollIntervalMs: 2000 });

  const blocks = useMemo(() => parseBlocks(output), [output]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const fetchDiffSummary = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodedSessionId}/diff`);
      if (!res.ok) {
        if (res.status === 404) {
          if (!mountedRef.current) return;
          setDiffSummary(EMPTY_SUMMARY);
          setDiffError(null);
          return;
        }
        throw new Error(`Failed to fetch diff: ${res.status}`);
      }

      const payload = (await res.json()) as DiffPayload;
      if (!mountedRef.current) return;
      setDiffSummary(summarizeDiff(payload));
      setDiffError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setDiffSummary(EMPTY_SUMMARY);
      setDiffError(err instanceof Error ? err.message : "Failed to load diff summary");
    }
  }, [encodedSessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchDiffSummary();
    const interval = window.setInterval(() => {
      if (mountedRef.current) void fetchDiffSummary();
    }, 4000);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, [fetchDiffSummary]);

  async function handleSend() {
    const message = input.trim();
    if (!message) return;

    setSending(true);
    setSendError(null);

    try {
      const res = await fetch(`/api/sessions/${encodedSessionId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) {
        throw new Error(`Send failed: ${res.status}`);
      }

      setInput("");
      window.setTimeout(() => {
        void refresh();
      }, 300);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  const placeholderText = useMemo(() => {
    if (sending) return "Sending message...";
    return "Continue working on this task...";
  }, [sending]);

  const combinedError = sendError ?? streamError ?? diffError;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {blocks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageCircleDashed className="h-6 w-6 text-[var(--text-faint)]" />
            <p className="text-[13px] text-[var(--text-muted)]">No output yet</p>
          </div>
        )}

        {blocks.map((block, index) => (
          <article
            key={`${index}-${block.slice(0, 24)}`}
            className="surface-panel animate-rise-in rounded-[var(--radius-sm)] border px-3 py-2"
          >
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--text-normal)]">
              {block}
            </pre>
          </article>
        ))}
      </div>

      <div className="border-t border-[var(--vk-border)] p-1">
        <div className="rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)]">
          <div className="flex items-center gap-2 border-b border-[var(--vk-border)] px-2 py-2">
            <div className="flex min-h-[29px] flex-1 items-center gap-2">
              {agentName && (
                <div className="inline-flex min-h-[29px] items-center gap-1.5 rounded-[3px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)]">
                  <AgentTileIcon seed={{ label: agentName }} className="h-4 w-4" />
                  <span className="max-w-[180px] truncate">{agentName}</span>
                </div>
              )}
              {diffSummary.hasDiff && (
                <div className="inline-flex min-h-[29px] items-center gap-1.5 rounded-[3px] bg-[var(--vk-bg-active)] px-2 text-[14px] text-[var(--vk-text-normal)]">
                  <span>{diffSummary.filesChanged} files changed</span>
                  <span className="text-[var(--vk-green)]">+{diffSummary.additions}</span>
                  <span className="text-[var(--vk-red)]">-{diffSummary.deletions}</span>
                </div>
              )}
            </div>
            <span className="text-[11px] text-[var(--vk-text-muted)]">
              {connected ? "Live" : "Offline"}
            </span>
          </div>

          <div className="px-2 pt-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={sending}
              rows={1}
              placeholder={placeholderText}
              className="min-h-[24px] max-h-40 w-full resize-none bg-transparent text-[16px] leading-[24px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
            />
          </div>

          <div className="flex items-end justify-between gap-2 px-2 pb-2 pt-3">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                className="inline-flex min-h-[29px] items-center rounded-[3px] border border-[var(--vk-border)] px-2 text-[13px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                aria-label="Clear draft"
                onClick={() => setInput("")}
              >
                Clear draft
              </button>
            </div>

            <Button
              variant="primary"
              onClick={() => void handleSend()}
              disabled={sending || !input.trim()}
              className="min-h-[29px] rounded-[3px] bg-[var(--vk-bg-active)] px-2 py-1 text-[16px] font-normal text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            >
              <span>Send</span>
              <Send className="ml-1 h-[15px] w-[15px]" />
            </Button>
          </div>
        </div>

        {combinedError && (
          <p className="mt-2 rounded-[3px] border border-[color:color-mix(in_srgb,var(--status-error)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--status-error)_12%,transparent)] px-2 py-1 text-[11px] text-[var(--status-error)]">
            {combinedError}
          </p>
        )}

        <p className="pt-1 text-[11px] text-[var(--vk-text-muted)]">
          {connected ? "Streaming live output" : "Reconnecting to output stream"}
        </p>
      </div>
    </div>
  );
}
