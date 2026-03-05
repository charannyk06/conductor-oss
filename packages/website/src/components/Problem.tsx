"use client";

import { FadeIn } from "./FadeIn";
import { Brain, GitFork, Eye, Zap } from "lucide-react";

export function Problem() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <FadeIn>
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Your Bottleneck Has{" "}
              <span className="bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
                Shifted
              </span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-zinc-400">
              Coding agents write code in parallel at superhuman speed. But you
              still need to plan and review that work. The bottleneck is now{" "}
              <em className="text-zinc-200">you</em>.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.2}>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Brain,
                title: "Plan Once",
                desc: "Write a task in plain English in your kanban board.",
                color: "text-violet-400",
                bg: "bg-violet-500/10",
              },
              {
                icon: GitFork,
                title: "Parallel Agents",
                desc: "Conductor spawns multiple agents across isolated worktrees.",
                color: "text-cyan-400",
                bg: "bg-cyan-500/10",
              },
              {
                icon: Eye,
                title: "Review Fast",
                desc: "Dashboard shows diffs, chat, terminal output — all in one place.",
                color: "text-amber-400",
                bg: "bg-amber-500/10",
              },
              {
                icon: Zap,
                title: "Ship Faster",
                desc: "Go from idea to merged PR in minutes, not hours.",
                color: "text-emerald-400",
                bg: "bg-emerald-500/10",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-6 backdrop-blur transition hover:border-zinc-700/80 hover:bg-zinc-900/60"
              >
                <div className={`mb-4 inline-flex rounded-lg p-2.5 ${item.bg}`}>
                  <item.icon className={`h-5 w-5 ${item.color}`} />
                </div>
                <h3 className="text-lg font-semibold text-zinc-100">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{item.desc}</p>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
