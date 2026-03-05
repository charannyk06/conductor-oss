"use client";

import { ArrowRight, Github } from "lucide-react";
import { TerminalMock } from "./TerminalMock";
import { FadeIn } from "./FadeIn";

const agents = [
  "Claude Code", "Codex", "Gemini", "Amp", "Cursor CLI",
  "OpenCode", "Droid", "Qwen Code", "CCR", "GitHub Copilot",
];

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
      {/* Background gradient */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-violet-600/10 blur-[120px]" />
        <div className="absolute right-0 top-1/3 h-[400px] w-[400px] rounded-full bg-cyan-500/8 blur-[100px]" />
      </div>

      <div className="mx-auto max-w-6xl px-6">
        <FadeIn>
          <div className="text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-4 py-1.5 text-sm text-zinc-400 backdrop-blur">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Open source &middot; MIT Licensed
            </div>

            <h1 className="mx-auto max-w-4xl text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
              <span className="bg-gradient-to-r from-violet-400 via-violet-300 to-cyan-400 bg-clip-text text-transparent">
                Orchestrate
              </span>{" "}
              AI Coding Agents
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400 sm:text-xl">
              Write tasks in markdown. Conductor spawns agents, manages worktrees,
              tracks PRs, and updates your board — all locally on your machine.
            </p>

            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <a
                href="#install"
                className="group inline-flex items-center gap-2 rounded-lg bg-violet-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-600/25 transition hover:bg-violet-500 hover:shadow-violet-500/30"
              >
                Get Started
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </a>
              <a
                href="https://github.com/charannyk06/conductor-oss"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/50 px-6 py-3 text-sm font-semibold text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800/80 hover:text-white"
              >
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.3}>
          <div className="mt-16">
            <TerminalMock />
          </div>
        </FadeIn>

        <FadeIn delay={0.5}>
          <div className="mt-14 text-center">
            <p className="mb-4 text-xs font-medium uppercase tracking-widest text-zinc-500">
              Works with
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {agents.map((name) => (
                <span
                  key={name}
                  className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-300"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
