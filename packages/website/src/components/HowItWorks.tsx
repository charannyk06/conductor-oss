"use client";

import { FadeIn } from "./FadeIn";
import { PenLine, Rocket, CheckCircle2 } from "lucide-react";

const steps = [
  {
    number: "01",
    icon: PenLine,
    title: "Plan",
    description: "Write a task in your kanban board — any markdown editor works.",
    code: `## Inbox

- [ ] Add dark mode toggle to settings page
      #agent/claude-code #project/shadower
      #type/feature #priority/high`,
    color: "text-violet-400",
    border: "border-violet-500/30",
    bg: "bg-violet-500/5",
  },
  {
    number: "02",
    icon: Rocket,
    title: "Dispatch",
    description: "Conductor auto-tags the task, spawns an agent in an isolated git worktree.",
    code: `[board-watcher] Inbox enhanced:
  "Add dark mode toggle"
[lifecycle] Spawning claude-code
  → worktree: ~/.worktrees/shadower/s1-dark-mode-1
  → branch:   feat/dark-mode-toggle
[lifecycle] Session s1-dark-mode-1: spawning → working`,
    color: "text-cyan-400",
    border: "border-cyan-500/30",
    bg: "bg-cyan-500/5",
  },
  {
    number: "03",
    icon: CheckCircle2,
    title: "Review",
    description: "Dashboard shows diffs, output, PR status. Approve and merge from one screen.",
    code: `Session: s1-dark-mode-1
Status:  done ✓
Agent:   claude-code
Cost:    $0.24
PR:      #142 — Add dark mode toggle
CI:      ✓ All checks passed
Files:   +87 -12 across 4 files`,
    color: "text-emerald-400",
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/5",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <FadeIn>
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-cyan-400">
              How it works
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Three steps to{" "}
              <span className="bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-transparent">
                autonomous shipping
              </span>
            </h2>
          </div>
        </FadeIn>

        <div className="mt-16 grid gap-8 lg:grid-cols-3">
          {steps.map((step, i) => (
            <FadeIn key={step.title} delay={i * 0.15}>
              <div
                className={`relative rounded-xl border ${step.border} ${step.bg} p-6 backdrop-blur`}
              >
                <div className="mb-4 flex items-center gap-3">
                  <span className="font-mono text-2xl font-bold text-zinc-600">
                    {step.number}
                  </span>
                  <step.icon className={`h-5 w-5 ${step.color}`} />
                  <h3 className="text-xl font-bold text-zinc-100">{step.title}</h3>
                </div>
                <p className="mb-5 text-sm text-zinc-400">{step.description}</p>
                <div className="rounded-lg border border-zinc-800 bg-[#0c0c0e] p-4">
                  <pre className="overflow-x-auto text-xs leading-relaxed text-zinc-400">
                    <code style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}>
                      {step.code}
                    </code>
                  </pre>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
