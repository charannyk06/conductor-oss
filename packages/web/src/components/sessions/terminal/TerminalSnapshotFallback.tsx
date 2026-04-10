"use client";

import { useEffect, useRef, useState } from "react";
import { resolveSessionTerminalViewportOptions } from "@/components/sessions/sessionTerminalUtils";

const TERMINAL_THEME = {
  background: "#060404",
  foreground: "#efe8e1",
  cursor: "#f4b37c",
  cursorAccent: "#060404",
  selectionBackground: "rgba(244, 179, 124, 0.24)",
  black: "#060404",
  red: "#ff8f7a",
  green: "#18c58f",
  yellow: "#f0b35d",
  blue: "#8ea6ff",
  magenta: "#d19be8",
  cyan: "#75d6d0",
  white: "#efe8e1",
  brightBlack: "#7d746e",
  brightRed: "#ffb39e",
  brightGreen: "#5be0b0",
  brightYellow: "#ffd089",
  brightBlue: "#b6c7ff",
  brightMagenta: "#e4c0f1",
  brightCyan: "#9fe8e2",
  brightWhite: "#fff8f2",
} as const;

type TerminalSnapshotFallbackProps = {
  snapshot: string | null;
  transcript?: string | null;
  className?: string;
};

export function TerminalSnapshotFallback({
  snapshot,
  transcript,
  className,
}: TerminalSnapshotFallbackProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [xtermReady, setXtermReady] = useState(false);
  const [xtermFailed, setXtermFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let cleanupFonts: (() => void) | null = null;

    const init = async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("xterm"),
          import("@xterm/addon-fit"),
          import("xterm/css/xterm.css"),
        ]);

        if (disposed || !hostRef.current) {
          return;
        }

        const host = hostRef.current;
        host.textContent = "";

        const viewport = resolveSessionTerminalViewportOptions(
          host.clientWidth || (typeof window === "undefined" ? undefined : window.innerWidth),
        );
        const terminal = new Terminal({
          allowTransparency: true,
          convertEol: true,
          cursorBlink: false,
          disableStdin: true,
          fontFamily: viewport.fontFamily,
          fontSize: viewport.fontSize,
          lineHeight: viewport.lineHeight,
          letterSpacing: 0.2,
          scrollback: 4_000,
          theme: TERMINAL_THEME,
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(host);

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        const applyViewport = () => {
          const nextHost = hostRef.current;
          const nextTerminal = terminalRef.current;
          const nextFitAddon = fitAddonRef.current;
          if (!nextHost || !nextTerminal || !nextFitAddon) {
            return;
          }
          const nextViewport = resolveSessionTerminalViewportOptions(
            nextHost.clientWidth || (typeof window === "undefined" ? undefined : window.innerWidth),
          );
          nextTerminal.options.fontFamily = nextViewport.fontFamily;
          nextTerminal.options.fontSize = nextViewport.fontSize;
          nextTerminal.options.lineHeight = nextViewport.lineHeight;
          nextFitAddon.fit();
        };

        resizeObserver = typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
            applyViewport();
          });
        resizeObserver?.observe(host);

        const fontSet = typeof document === "undefined" ? null : document.fonts;
        const handleFonts = () => applyViewport();
        fontSet?.addEventListener?.("loadingdone", handleFonts as EventListener);
        cleanupFonts = () => {
          fontSet?.removeEventListener?.("loadingdone", handleFonts as EventListener);
        };

        requestAnimationFrame(() => {
          if (!disposed) {
            applyViewport();
            setXtermReady(true);
          }
        });
      } catch {
        if (!disposed) {
          setXtermFailed(true);
        }
      }
    };

    void init();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      cleanupFonts?.();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !xtermReady) {
      return;
    }

    const nextValue = snapshot ?? transcript ?? "";
    terminal.reset();
    if (nextValue.length > 0) {
      terminal.write(nextValue, () => {
        terminal.scrollToBottom();
      });
    }
  }, [snapshot, transcript, xtermReady]);

  const plainFallback = transcript ?? snapshot ?? "";

  return (
    <div className={className}>
      <div
        ref={hostRef}
        className={xtermFailed
          ? "hidden"
          : "h-full w-full overflow-hidden px-2 py-2 text-left [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm]:px-1 [&_.xterm-screen]:h-full [&_.xterm-screen]:w-full [&_.xterm-viewport]:overflow-y-auto [&_.xterm-scrollable-element]:overflow-y-auto"}
      />
      {xtermFailed ? (
        <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[12px] leading-5 text-[#efe8e1]">
          {plainFallback}
        </pre>
      ) : null}
    </div>
  );
}
