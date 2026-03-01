"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Terminal as XTerminal } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";

interface TerminalViewProps {
  sessionId: string;
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const lastOutputRef = useRef<string>("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOutput = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/output?lines=500`);
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { output: string };
      setConnected(true);
      setError(null);

      if (data.output !== lastOutputRef.current && termRef.current) {
        lastOutputRef.current = data.output;
        const term = termRef.current;
        term.reset();
        // Write all output at once — xterm handles ANSI codes, \r\n for line breaks
        const normalized = data.output.replace(/\r?\n/g, "\r\n");
        term.write(normalized, () => {
          // Scroll after write completes (xterm callback)
          term.scrollToBottom();
          fitRef.current?.fit();
        });
      }
    } catch (err) {
      setConnected(false);
      setError(err instanceof Error ? err.message : "Connection lost");
    }
  }, [sessionId]);

  useEffect(() => {
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mounted = true;

    async function init() {
      if (!containerRef.current || !mounted) return;

      // Dynamic import to avoid SSR issues
      const [xtermMod, fitMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (!mounted || !containerRef.current) return;

      const isMobile = window.innerWidth < 640;
      term = new xtermMod.Terminal({
        cursorBlink: false,
        cursorStyle: "underline",
        disableStdin: true,
        scrollback: 5000,
        fontSize: isMobile ? 11 : 13,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', monospace",
        lineHeight: 1.2,
        convertEol: true,
        theme: {
          background: "#0d1117",
          foreground: "#c9d1d9",
          cursor: "#58a6ff",
          selectionBackground: "rgba(88,166,255,0.3)",
          black: "#484f58",
          red: "#f85149",
          green: "#3fb950",
          yellow: "#d29922",
          blue: "#58a6ff",
          magenta: "#a371f7",
          cyan: "#56d4dd",
          white: "#c9d1d9",
          brightBlack: "#6e7681",
          brightRed: "#ffa198",
          brightGreen: "#56d364",
          brightYellow: "#e3b341",
          brightBlue: "#79c0ff",
          brightMagenta: "#d2a8ff",
          brightCyan: "#76e3ea",
          brightWhite: "#f0f6fc",
        },
      });

      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      // Handle resize
      resizeObserver = new ResizeObserver(() => {
        if (fit && mounted) {
          try {
            fit.fit();
          } catch {
            // Container might not be visible
          }
        }
      });
      resizeObserver.observe(containerRef.current);

      // Initial fetch
      await fetchOutput();

      // Poll every 1s
      interval = setInterval(() => {
        if (mounted) void fetchOutput();
      }, 1000);
    }

    void init();

    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
      if (resizeObserver) resizeObserver.disconnect();
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, fetchOutput]);

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border-default)] bg-[var(--color-bg-subtle)]">
        <div
          className={`w-2 h-2 rounded-full ${
            connected
              ? "bg-[var(--color-status-ready)]"
              : error
                ? "bg-[var(--color-status-error)] animate-pulse"
                : "bg-[var(--color-text-muted)]"
          }`}
        />
        <span className={`text-xs ${connected ? "text-[var(--color-status-ready)]" : error ? "text-[var(--color-status-error)]" : "text-[var(--color-text-muted)]"}`}>
          {connected ? "Live" : error?.includes("not found") || error?.includes("404") ? "No terminal — session ended" : error ?? "Connecting..."}
        </span>
        <span className="text-xs text-[var(--color-text-muted)] ml-auto font-mono">
          {sessionId}
        </span>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{ padding: "8px 4px", minHeight: 0, height: "100%" }}
      />
    </div>
  );
}
