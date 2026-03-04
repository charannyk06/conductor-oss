"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Button } from "@/components/ui/Button";

interface ChatPanelProps {
  sessionId: string;
}

/** Strip ANSI escape sequences from terminal output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Split raw output into message-like blocks. */
function parseBlocks(raw: string): string[] {
  return raw
    .split(/\n{2,}/)
    .map((block) => stripAnsi(block).trim())
    .filter((block) => block.length > 0);
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const [blocks, setBlocks] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const fetchOutput = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/output`);
      if (!res.ok) return;
      const data = (await res.json()) as { output?: string };
      if (mountedRef.current && data.output) {
        setBlocks(parseBlocks(data.output));
      }
    } catch {
      // Silently retry on next interval
    }
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchOutput();
    const interval = setInterval(() => {
      if (mountedRef.current) void fetchOutput();
    }, 2000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchOutput]);

  // Auto-scroll to bottom on new blocks
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [blocks]);

  async function handleSend() {
    const message = input.trim();
    if (!message) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`Send failed: ${res.status}`);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div ref={scrollRef} className="flex flex-col gap-2 p-4">
          {blocks.length === 0 && (
            <p className="text-center text-[13px] text-[var(--color-text-muted)] py-8">
              No output yet
            </p>
          )}
          {blocks.map((block, i) => (
            <div
              key={i}
              className="rounded-md bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-[12px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words"
            >
              {block}
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-[var(--color-border-default)] p-3">
        {error && (
          <p className="mb-2 text-[11px] text-[var(--color-status-error)]">{error}</p>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            disabled={sending}
            className="flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[#58a6ff] focus:outline-none disabled:opacity-50"
          />
          <Button
            size="icon"
            variant="primary"
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
