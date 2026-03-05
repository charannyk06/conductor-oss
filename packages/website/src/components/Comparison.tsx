"use client";

import { FadeIn } from "./FadeIn";
import { Check, X, Minus } from "lucide-react";

const rows = [
  { label: "Task format", manual: "Jira / Linear", other: "Proprietary UI", conductor: "Plain markdown" },
  { label: "Where tasks live", manual: "Cloud app", other: "Cloud app", conductor: "Your own files" },
  { label: "Agent execution", manual: "Manual", other: "Managed cloud", conductor: "Local — your machine" },
  { label: "Multiple agents", manual: "Copy-paste", other: "Vendor lock-in", conductor: "10 agents, swap freely" },
  { label: "Context isolation", manual: "Manual branches", other: "Varies", conductor: "Git worktree per task" },
  { label: "PR lifecycle", manual: "Manual", other: "Partial", conductor: "Full: open → merge" },
  { label: "Database required", manual: "—", other: "Often", conductor: "Never — flat files" },
  { label: "Cost", manual: "Subscription", other: "Subscription", conductor: "Free + your API keys" },
];

function CellIcon({ type }: { type: "good" | "bad" | "mid" }) {
  if (type === "good") return <Check className="inline-block h-4 w-4 text-emerald-400" />;
  if (type === "bad") return <X className="inline-block h-4 w-4 text-zinc-600" />;
  return <Minus className="inline-block h-4 w-4 text-zinc-600" />;
}

export function Comparison() {
  return (
    <section className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-5xl px-6">
        <FadeIn>
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-cyan-400">
              Comparison
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              How Conductor stacks up
            </h2>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="mt-12 overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/60">
                  <th className="px-4 py-3 text-left font-medium text-zinc-400" />
                  <th className="px-4 py-3 text-center font-medium text-zinc-500">Manual</th>
                  <th className="px-4 py-3 text-center font-medium text-zinc-500">Other tools</th>
                  <th className="px-4 py-3 text-center font-semibold text-violet-400">Conductor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={row.label}
                    className={`border-b border-zinc-800/50 ${i % 2 === 0 ? "bg-zinc-950/30" : ""}`}
                  >
                    <td className="px-4 py-3 font-medium text-zinc-300">{row.label}</td>
                    <td className="px-4 py-3 text-center text-zinc-500">
                      <CellIcon type="bad" />{" "}
                      <span className="ml-1">{row.manual}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-zinc-500">
                      <CellIcon type="mid" />{" "}
                      <span className="ml-1">{row.other}</span>
                    </td>
                    <td className="px-4 py-3 text-center font-medium text-zinc-200">
                      <CellIcon type="good" />{" "}
                      <span className="ml-1">{row.conductor}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
