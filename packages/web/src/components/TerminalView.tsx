"use client";

import { useEffect, useRef } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, Terminal as XTerminal } from "@xterm/xterm";
import { useSessionOutputStream } from "@/hooks/useSessionOutputStream";

interface TerminalViewProps {
  sessionId: string;
}

function getTerminalTheme(): NonNullable<ITerminalOptions["theme"]> {
  const isLight = document.documentElement.classList.contains("light");

  if (isLight) {
    return {
      background: "#f8fbff",
      foreground: "#1f2a3a",
      cursor: "#ea580c",
      selectionBackground: "rgba(234,88,12,0.25)",
      black: "#4b5563",
      red: "#dc2626",
      green: "#15803d",
      yellow: "#b45309",
      blue: "#2563eb",
      magenta: "#7e22ce",
      cyan: "#0e7490",
      white: "#334155",
      brightBlack: "#64748b",
      brightRed: "#ef4444",
      brightGreen: "#22c55e",
      brightYellow: "#f59e0b",
      brightBlue: "#3b82f6",
      brightMagenta: "#a855f7",
      brightCyan: "#06b6d4",
      brightWhite: "#0f172a",
    };
  }

  return {
    background: "#0a0f16",
    foreground: "#d0d8e5",
    cursor: "#f97316",
    selectionBackground: "rgba(249,115,22,0.26)",
    black: "#1f2937",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#38bdf8",
    magenta: "#c084fc",
    cyan: "#06b6d4",
    white: "#cbd5e1",
    brightBlack: "#475569",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#7dd3fc",
    brightMagenta: "#e9d5ff",
    brightCyan: "#67e8f9",
    brightWhite: "#f8fafc",
  };
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const lastRenderedOutputRef = useRef<string>("");

  const { output, connected, error } = useSessionOutputStream(sessionId, {
    lines: 1200,
    pollIntervalMs: 1300,
  });

  useEffect(() => {
    let term: XTerminal | null = null;
    let fit: XFitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mounted = true;

    async function init() {
      if (!containerRef.current || !mounted) return;

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
        fontSize: isMobile ? 11 : 12,
        fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'SF Mono', monospace",
        lineHeight: 1.25,
        convertEol: true,
        theme: getTerminalTheme(),
      });

      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      resizeObserver = new ResizeObserver(() => {
        if (!fit || !mounted) return;
        try {
          fit.fit();
        } catch {
          // Container may be hidden while switching tabs.
        }
      });

      resizeObserver.observe(containerRef.current);
    }

    void init();

    return () => {
      mounted = false;
      if (resizeObserver) resizeObserver.disconnect();
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
      lastRenderedOutputRef.current = "";
    };
  }, [sessionId]);

  useEffect(() => {
    if (!termRef.current) return;
    if (output === lastRenderedOutputRef.current) return;

    lastRenderedOutputRef.current = output;
    const term = termRef.current;
    term.reset();

    const normalized = output.replace(/\r?\n/g, "\r\n");
    term.write(normalized, () => {
      term.scrollToBottom();
      fitRef.current?.fit();
    });
  }, [output]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border-soft)] bg-[var(--bg-panel)] px-3 py-1.5">
        <div
          className={`h-2 w-2 rounded-full ${
            connected
              ? "bg-[var(--status-ready)]"
              : error
                ? "bg-[var(--status-error)] animate-pulse"
                : "bg-[var(--text-faint)]"
          }`}
        />
        <span
          className={`text-[11px] ${
            connected
              ? "text-[var(--status-ready)]"
              : error
                ? "text-[var(--status-error)]"
                : "text-[var(--text-faint)]"
          }`}
        >
          {connected
            ? "Live"
            : error?.includes("not found") || error?.includes("404")
              ? "No terminal (session ended)"
              : error ?? "Connecting"}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-[var(--text-faint)]">{sessionId}</span>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-1 py-2" />
    </div>
  );
}
