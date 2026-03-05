"use client";

import { FadeIn } from "./FadeIn";
import {
  FileText,
  Blocks,
  GitBranch,
  LayoutDashboard,
  GitPullRequest,
  ShieldOff,
} from "lucide-react";

const features = [
  {
    icon: FileText,
    title: "Markdown Native",
    description:
      "Write tasks in Obsidian, VS Code, or any editor. Your kanban board is a plain .md file — no proprietary UI, no vendor lock-in.",
    color: "text-violet-400",
    glow: "from-violet-500/20",
  },
  {
    icon: Blocks,
    title: "10 Agent Plugins",
    description:
      "Claude Code, Codex, Gemini, Amp, Cursor CLI, OpenCode, Droid, Qwen Code, CCR, GitHub Copilot. Swap agents per task.",
    color: "text-cyan-400",
    glow: "from-cyan-500/20",
  },
  {
    icon: GitBranch,
    title: "Git Worktree Isolation",
    description:
      "Every task gets its own git worktree. No branch conflicts, no stash juggling. Agents work in parallel without stepping on each other.",
    color: "text-emerald-400",
    glow: "from-emerald-500/20",
  },
  {
    icon: LayoutDashboard,
    title: "Live Dashboard",
    description:
      "Real-time session status, code diffs, chat with agents, and terminal output. See everything your agents are doing at a glance.",
    color: "text-amber-400",
    glow: "from-amber-500/20",
  },
  {
    icon: GitPullRequest,
    title: "Full PR Lifecycle",
    description:
      "Open → CI → Review → Merge. Conductor watches the entire pull request lifecycle and updates your board card automatically.",
    color: "text-rose-400",
    glow: "from-rose-500/20",
  },
  {
    icon: ShieldOff,
    title: "Zero Cloud",
    description:
      "No database. No SaaS subscription. No data leaving your machine. Runs entirely local with flat files and your own API keys.",
    color: "text-sky-400",
    glow: "from-sky-500/20",
  },
];

export function Features() {
  return (
    <section id="features" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <FadeIn>
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-violet-400">
              Features
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Everything you need to{" "}
              <span className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
                ship faster
              </span>
            </h2>
          </div>
        </FadeIn>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, i) => (
            <FadeIn key={feature.title} delay={i * 0.1}>
              <div className="group relative rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-6 backdrop-blur transition-all duration-300 hover:border-zinc-700/80 hover:bg-zinc-900/60 hover:-translate-y-0.5">
                {/* Glow */}
                <div
                  className={`pointer-events-none absolute inset-0 -z-10 rounded-xl bg-gradient-to-br ${feature.glow} to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100`}
                />
                <div className="mb-4">
                  <feature.icon className={`h-6 w-6 ${feature.color}`} />
                </div>
                <h3 className="text-lg font-semibold text-zinc-100">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  {feature.description}
                </p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
