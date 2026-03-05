"use client";

import { useState } from "react";
import { FadeIn } from "./FadeIn";
import { Copy, Check, Terminal, ExternalLink } from "lucide-react";

const commands = [
  { text: "npm install -g conductor-oss", comment: "# Install globally" },
  { text: "conductor init", comment: "# Configure your workspace" },
  { text: "conductor start", comment: "# Launch dashboard + watcher" },
];

export function Install() {
  const [copied, setCopied] = useState(false);

  const allCommands = commands.map((c) => c.text).join("\n");

  function handleCopy() {
    navigator.clipboard.writeText(allCommands).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section id="install" className="relative py-24 sm:py-32">
      {/* Glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 bottom-0 h-[500px] w-[700px] -translate-x-1/2 translate-y-1/4 rounded-full bg-violet-600/10 blur-[120px]" />
      </div>

      <div className="mx-auto max-w-3xl px-6">
        <FadeIn>
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">
              Get started
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Up and running in{" "}
              <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                60 seconds
              </span>
            </h2>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="relative mt-12 rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40">
            {/* Terminal header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-500">Terminal</span>
              </div>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/50 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy
                  </>
                )}
              </button>
            </div>

            {/* Commands */}
            <div className="p-5 space-y-3" style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}>
              {commands.map((cmd) => (
                <div key={cmd.text} className="flex items-start gap-2 text-sm">
                  <span className="select-none text-violet-400">$</span>
                  <span className="text-zinc-200">{cmd.text}</span>
                  <span className="ml-auto hidden text-zinc-600 sm:inline">{cmd.comment}</span>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.3}>
          <div className="mt-8 text-center">
            <p className="text-sm text-zinc-400">
              Open{" "}
              <code
                className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-cyan-400"
                style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
              >
                localhost:4747
              </code>{" "}
              and start orchestrating.
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="https://github.com/charannyk06/conductor-oss#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/50 px-5 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-white"
              >
                <ExternalLink className="h-4 w-4" />
                Read the docs
              </a>
              <a
                href="https://www.npmjs.com/package/conductor-oss"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-zinc-500 transition hover:text-zinc-300"
              >
                View on npm →
              </a>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
