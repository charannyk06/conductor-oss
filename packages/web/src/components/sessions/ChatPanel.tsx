"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  Eraser,
  FilePenLine,
  FilePlus2,
  Hammer,
  LoaderCircle,
  MessageCircleDashed,
  Paperclip,
  Play,
  ScanSearch,
  Send,
  SlidersHorizontal,
  TerminalSquare,
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

type StreamItemKind = "text" | "thinking" | "command";
type ToolAction = "search" | "read" | "edit" | "create" | "run";

interface StreamItem {
  kind: StreamItemKind;
  text: string;
  action?: ToolAction;
}

const COMMAND_PREFIXES = [
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "node",
  "python",
  "pip",
  "uv",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "helm",
  "ls",
  "cd",
  "cat",
  "sed",
  "awk",
  "rg",
  "grep",
  "find",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "echo",
  "pwd",
  "whoami",
  "curl",
  "wget",
  "tail",
  "head",
  "wc",
  "sort",
  "uniq",
  "tr",
  "xargs",
  "make",
  "just",
  "bun",
  "deno",
  "tmux",
] as const;

const TOOL_LINE_PREFIXES: Array<{ prefix: string; action: ToolAction }> = [
  { prefix: "searched for ", action: "search" },
  { prefix: "searching for ", action: "search" },
  { prefix: "read ", action: "read" },
  { prefix: "opened ", action: "read" },
  { prefix: "edited ", action: "edit" },
  { prefix: "updated ", action: "edit" },
  { prefix: "created ", action: "create" },
  { prefix: "applied patch", action: "edit" },
  { prefix: "ran ", action: "run" },
  { prefix: "running ", action: "run" },
  { prefix: "wrote ", action: "edit" },
];

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function normalizeOutputLine(rawLine: string): string {
  return stripAnsi(rawLine).replace(/\t/g, "  ").trim();
}

function stripPromptPrefix(line: string): string {
  return line.replace(/^\s*(?:[^$>#%\n]{0,120}\s+)?(?:[$>#%]\s+)+/, "").trim();
}

function stripLeadingDecorators(line: string): string {
  return line.replace(/^[^a-zA-Z0-9]+/, "").trim();
}

function isThinkingLine(line: string): boolean {
  const normalized = stripLeadingDecorators(line).trim().toLowerCase();
  return (
    normalized === "thinking"
    || normalized === "thinking..."
    || normalized === "analyzing"
    || normalized === "analyzing..."
  );
}

function parseToolLine(line: string): { action: ToolAction; text: string } | null {
  const stripped = stripLeadingDecorators(stripPromptPrefix(line));
  const normalized = stripped.toLowerCase();
  const match = TOOL_LINE_PREFIXES.find((item) => normalized.startsWith(item.prefix));
  if (!match) return null;
  return {
    action: match.action,
    text: stripped,
  };
}

function isCommandLine(line: string): boolean {
  const normalized = stripLeadingDecorators(stripPromptPrefix(line)).toLowerCase();
  if (!normalized) return false;
  return COMMAND_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

function parseStreamItems(raw: string): StreamItem[] {
  const lines = raw.split(/\r?\n/).slice(-1400);
  const items: StreamItem[] = [];
  const textBuffer: string[] = [];

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) return;
    const text = textBuffer.join("\n").trim();
    textBuffer.length = 0;
    if (!text) return;
    items.push({ kind: "text", text });
  };

  for (const rawLine of lines) {
    const line = normalizeOutputLine(rawLine);
    if (!line) {
      flushTextBuffer();
      continue;
    }

    if (isThinkingLine(line)) {
      flushTextBuffer();
      items.push({ kind: "thinking", text: "Thinking" });
      continue;
    }

    const toolLine = parseToolLine(line);
    if (toolLine) {
      flushTextBuffer();
      items.push({ kind: "command", text: toolLine.text, action: toolLine.action });
      continue;
    }

    if (isCommandLine(line)) {
      flushTextBuffer();
      items.push({ kind: "command", text: stripLeadingDecorators(stripPromptPrefix(line)) });
      continue;
    }

    textBuffer.push(line);
  }

  flushTextBuffer();
  return items.slice(-180);
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
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const mountedRef = useRef(true);

  const {
    output,
    connected,
    error: streamError,
    refresh,
  } = useSessionOutputStream(sessionId, { lines: 900, pollIntervalMs: 2000 });

  const streamItems = useMemo(() => parseStreamItems(output), [output]);

  const isNearBottom = useCallback((element: HTMLDivElement, threshold = 44) => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distance <= threshold;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setIsPinnedToLatest(true);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      setIsPinnedToLatest(isNearBottom(el));
    };

    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
    };
  }, [isNearBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPinnedToLatest) return;
    el.scrollTop = el.scrollHeight;
  }, [isPinnedToLatest, streamItems]);

  useEffect(() => {
    setIsPinnedToLatest(true);
  }, [sessionId]);

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
  const controlButtonClass = "inline-flex h-[29px] min-w-[29px] items-center justify-center rounded-[3px] border border-[var(--vk-border)] bg-[#1c1c1c] px-2 text-[var(--vk-text-muted)] transition-colors hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto px-3 py-3 sm:px-4 sm:py-4"
        >
          {streamItems.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <MessageCircleDashed className="h-6 w-6 text-[var(--text-faint)]" />
              <p className="text-[13px] text-[var(--text-muted)]">No output yet</p>
            </div>
          )}

          {streamItems.length > 0 && (
            <div className="space-y-3">
              {streamItems.map((item, index) => {
                if (item.kind === "thinking") {
                  return (
                    <article
                      key={`${index}-${item.kind}-${item.text.slice(0, 24)}`}
                      className="flex items-center gap-2 text-[14px] leading-[21px] text-[#8f8f8f]"
                    >
                      <LoaderCircle className="h-[15px] w-[15px]" />
                      <span>{item.text}</span>
                    </article>
                  );
                }

                if (item.kind === "command") {
                  const iconClass = "h-[15px] w-[15px]";
                  const CommandIcon = item.action === "search"
                    ? ScanSearch
                    : item.action === "read"
                      ? BookOpen
                      : item.action === "edit"
                        ? FilePenLine
                        : item.action === "create"
                          ? FilePlus2
                          : item.action === "run"
                            ? Hammer
                            : TerminalSquare;
                  return (
                    <article
                      key={`${index}-${item.kind}-${item.text.slice(0, 24)}`}
                      className="flex items-center gap-2 text-[14px] leading-[21px] text-[#8f8f8f]"
                    >
                      <span className="relative inline-flex h-[20px] w-[20px] items-center justify-center text-[var(--vk-text-muted)]">
                        <CommandIcon className={iconClass} />
                        <span className="absolute -bottom-[2px] -left-[1px] h-[6px] w-[6px] rounded-full bg-[var(--vk-green)]" />
                      </span>
                      <span className="whitespace-pre-wrap break-words">{item.text}</span>
                    </article>
                  );
                }

                return (
                  <article key={`${index}-${item.kind}-${item.text.slice(0, 24)}`}>
                    <pre className="whitespace-pre-wrap break-words font-sans text-[16px] leading-[24px] text-[#c4c4c4]">
                      {item.text}
                    </pre>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {!isPinnedToLatest && streamItems.length > 0 && (
          <div className="pointer-events-none absolute bottom-3 right-3 z-10">
            <button
              type="button"
              className="pointer-events-auto inline-flex h-8 items-center gap-1 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2.5 text-[11px] text-[var(--vk-text-normal)] shadow-[0_8px_24px_rgba(0,0,0,0.4)] hover:bg-[var(--vk-bg-hover)]"
              onClick={scrollToBottom}
            >
              <ArrowUp className="h-3.5 w-3.5" />
              Latest
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-[var(--vk-border)] px-3 pb-3 pt-2">
        <div className="rounded-[3px] border border-[var(--vk-border)] bg-[#1c1c1c]">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--vk-border)] px-2 py-2 sm:flex-nowrap">
            <div className="flex min-h-[29px] flex-1 items-center gap-2 overflow-hidden">
              {diffSummary.hasDiff ? (
                <div className="inline-flex min-h-[29px] items-center gap-1.5 rounded-[3px] bg-[#292929] px-2 text-[14px] leading-[21px] text-[#c4c4c4]">
                  <span>{diffSummary.filesChanged} files changed</span>
                  <span className="text-[var(--vk-green)]">+{diffSummary.additions}</span>
                  <span className="text-[var(--vk-red)]">-{diffSummary.deletions}</span>
                </div>
              ) : agentName ? (
                <div className="inline-flex min-h-[29px] items-center gap-1.5 rounded-[3px] border border-[var(--vk-border)] px-2 text-[13px] text-[var(--vk-text-normal)]">
                  <AgentTileIcon seed={{ label: agentName }} className="h-6 w-6" />
                  <span className="max-w-[180px] truncate">{agentName}</span>
                </div>
              ) : (
                <span className="text-[13px] text-[var(--vk-text-muted)]">No file changes yet</span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${connected ? "bg-[var(--vk-green)]" : "bg-[var(--vk-text-muted)]"}`}
                title={connected ? "Live output streaming" : "Reconnecting to output stream"}
              />

              <button
                type="button"
                className={controlButtonClass}
                aria-label="Jump to latest output"
                onClick={scrollToBottom}
              >
                <ArrowUp className="h-[15px] w-[15px]" />
              </button>

              {agentName && (
                <span className="hidden h-[25px] w-[25px] items-center justify-center overflow-hidden rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] sm:inline-flex">
                  <AgentTileIcon seed={{ label: agentName }} className="h-8 w-8" />
                </span>
              )}

              <button type="button" className={controlButtonClass} aria-label="Chat settings">
                <SlidersHorizontal className="h-[15px] w-[15px]" />
              </button>

              <button type="button" className={`${controlButtonClass} gap-1 text-[14px] leading-[21px]`}>
                <span>Latest</span>
                <ChevronDown className="h-[10px] w-[10px]" />
              </button>
            </div>
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
              className="min-h-[24px] max-h-40 w-full resize-none bg-transparent text-[16px] leading-[24px] text-[var(--vk-text-normal)] outline-none placeholder:text-[#8f8f8f]"
            />
          </div>

          <div className="flex items-end justify-between gap-2 px-2 pb-2 pt-3">
            <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
              <button
                type="button"
                className={controlButtonClass}
                aria-label="Clear message draft"
                onClick={() => setInput("")}
              >
                <Eraser className="h-[15px] w-[15px]" />
              </button>
              <button type="button" className={controlButtonClass} aria-label="Playback tools">
                <Play className="h-[15px] w-[15px]" />
              </button>
              <button type="button" className={controlButtonClass} aria-label="Attach files">
                <Paperclip className="h-[15px] w-[15px]" />
              </button>
              <button type="button" className={controlButtonClass} aria-label="Additional options">
                <SlidersHorizontal className="h-[15px] w-[15px]" />
              </button>
            </div>

            <Button
              variant="primary"
              onClick={() => void handleSend()}
              disabled={sending || !input.trim()}
              className="min-h-[29px] rounded-[3px] border border-[var(--vk-border)] bg-[#292929] px-2 py-1 text-[16px] font-normal text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
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
      </div>
    </div>
  );
}
