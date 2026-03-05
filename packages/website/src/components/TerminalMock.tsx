"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface TerminalLine {
  type: "command" | "output" | "success" | "info" | "blank";
  text: string;
  delay: number;
}

const TERMINAL_LINES: TerminalLine[] = [
  { type: "command", text: "conductor start", delay: 600 },
  { type: "blank", text: "", delay: 200 },
  { type: "info", text: "  Conductor OSS v0.4.2 — starting up...", delay: 400 },
  { type: "output", text: "  → Watching ~/.kanban/my-app/", delay: 300 },
  { type: "output", text: "  → Scanning READY column...", delay: 500 },
  { type: "output", text: "  → Found 2 tasks ready for dispatch", delay: 300 },
  { type: "blank", text: "", delay: 200 },
  { type: "success", text: "  ✓ Spawning agent: claude-code", delay: 400 },
  { type: "output", text: "      task: Add dark mode to settings page", delay: 200 },
  { type: "output", text: "      worktree: feature/dark-mode  [created]", delay: 300 },
  { type: "output", text: "      status: IN_PROGRESS", delay: 200 },
  { type: "blank", text: "", delay: 200 },
  { type: "success", text: "  ✓ Spawning agent: openai/codex", delay: 400 },
  { type: "output", text: "      task: Fix auth token refresh bug", delay: 200 },
  { type: "output", text: "      worktree: fix/auth-refresh  [created]", delay: 300 },
  { type: "output", text: "      status: IN_PROGRESS", delay: 200 },
  { type: "blank", text: "", delay: 300 },
  { type: "info", text: "  → 2 agents running in parallel", delay: 400 },
  { type: "info", text: "  → Dashboard at http://localhost:4747", delay: 200 },
];

function useTypewriter(text: string, speed = 40) {
  const [displayed, setDisplayed] = useState("");

  useEffect(() => {
    setDisplayed("");
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        setDisplayed(text.slice(0, i + 1));
        i++;
      } else {
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed]);

  return displayed;
}

function CommandLine({ text }: { text: string }) {
  const displayed = useTypewriter(text, 38);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[#7C3AED] select-none">$</span>
      <span className="text-zinc-100">{displayed}</span>
      {displayed.length < text.length && (
        <span className="inline-block w-[7px] h-[14px] bg-zinc-300 animate-cursor" />
      )}
    </div>
  );
}

function OutputLine({
  text,
  type,
}: {
  text: string;
  type: TerminalLine["type"];
}) {
  const colorMap: Record<string, string> = {
    output: "text-zinc-400",
    success: "text-emerald-400",
    info: "text-cyan-400",
    blank: "",
    command: "text-zinc-100",
  };

  return (
    <div className={colorMap[type] ?? "text-zinc-400"}>
      <span className="font-[var(--font-jetbrains-mono)]">{text}</span>
    </div>
  );
}

export function TerminalMock() {
  const [visibleLines, setVisibleLines] = useState<TerminalLine[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const [looping, setLooping] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), 800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!started) return;
    if (currentIndex >= TERMINAL_LINES.length) {
      // Pause then restart
      const restartTimer = setTimeout(() => {
        setVisibleLines([]);
        setCurrentIndex(0);
        setLooping(true);
      }, 3000);
      return () => clearTimeout(restartTimer);
    }

    const line = TERMINAL_LINES[currentIndex];
    const timer = setTimeout(() => {
      setVisibleLines((prev) => [...prev, line]);
      setCurrentIndex((prev) => prev + 1);
    }, line.delay);

    return () => clearTimeout(timer);
  }, [started, currentIndex, looping]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleLines]);

  const currentCommandLine =
    currentIndex < TERMINAL_LINES.length &&
    TERMINAL_LINES[currentIndex]?.type === "command" &&
    visibleLines.length === currentIndex
      ? TERMINAL_LINES[currentIndex]
      : null;

  return (
    <div
      className="w-full max-w-2xl mx-auto rounded-xl overflow-hidden border border-zinc-800 shadow-2xl"
      style={{ background: "#0d0d10" }}
      role="presentation"
      aria-label="Terminal demonstration of Conductor OSS"
    >
      {/* Terminal chrome */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-950">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#FF5F57]" />
          <div className="w-3 h-3 rounded-full bg-[#FEBC2E]" />
          <div className="w-3 h-3 rounded-full bg-[#28C840]" />
        </div>
        <div className="flex-1 flex justify-center">
          <span
            className="text-xs text-zinc-500"
            style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
          >
            conductor — zsh — 120×32
          </span>
        </div>
      </div>

      {/* Terminal body */}
      <div
        ref={containerRef}
        className="p-5 min-h-[280px] max-h-[340px] overflow-y-auto"
        style={{ fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: "13px", lineHeight: "1.7" }}
      >
        <AnimatePresence>
          {visibleLines.map((line, i) => (
            <motion.div
              key={`${i}-${line.text}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
            >
              {line.type === "command" ? (
                <div className="flex items-center gap-2">
                  <span className="text-[#7C3AED] select-none">$</span>
                  <span className="text-zinc-100">{line.text}</span>
                </div>
              ) : (
                <OutputLine text={line.text} type={line.type} />
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Live typing for current command */}
        {currentCommandLine && (
          <CommandLine text={currentCommandLine.text} />
        )}

        {/* Idle cursor when all lines shown */}
        {currentIndex >= TERMINAL_LINES.length && (
          <div className="flex items-center gap-2">
            <span className="text-[#7C3AED] select-none">$</span>
            <span className="inline-block w-[7px] h-[14px] bg-zinc-300 animate-cursor" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
