"use client";

import { FadeIn } from "./FadeIn";

export function DashboardPreview() {
  return (
    <section className="relative py-24 sm:py-32 overflow-hidden">
      {/* Glow behind dashboard */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/2 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-600/8 blur-[120px]" />
      </div>

      <div className="mx-auto max-w-6xl px-6">
        <FadeIn>
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-violet-400">
              Dashboard
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Your mission control for{" "}
              <span className="bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent">
                AI agents
              </span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-zinc-400">
              Real-time sessions, code diffs, agent chat, and terminal output — all in one dark-themed interface.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.2}>
          <div className="relative mt-14">
            {/* Dashboard mockup */}
            <div className="relative rounded-xl border border-zinc-800 bg-zinc-900/80 shadow-2xl shadow-black/40 overflow-hidden">
              {/* Title bar */}
              <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-zinc-700" />
                  <div className="h-3 w-3 rounded-full bg-zinc-700" />
                  <div className="h-3 w-3 rounded-full bg-zinc-700" />
                </div>
                <span className="ml-3 text-xs text-zinc-500" style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}>
                  localhost:4747
                </span>
              </div>

              {/* Dashboard content */}
              <div className="flex min-h-[400px] sm:min-h-[500px]">
                {/* Sidebar */}
                <div className="hidden w-48 border-r border-zinc-800 bg-zinc-950/60 p-4 sm:block">
                  <div className="mb-4 flex items-center gap-2">
                    <div className="h-5 w-5 rounded bg-violet-600/20" />
                    <span className="text-sm font-semibold text-zinc-200">conductor-oss</span>
                  </div>
                  <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                    Projects
                  </div>
                  {["shadower", "aba-copilot", "techwealth", "carevm"].map((p) => (
                    <div key={p} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50">
                      <div className="h-1.5 w-1.5 rounded-full bg-cyan-500" />
                      {p}
                    </div>
                  ))}
                  <div className="mt-4 mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                    Running
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-zinc-800/40 px-2 py-1.5 text-xs text-emerald-400">
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    s1-dark-mode-1
                  </div>
                </div>

                {/* Main area */}
                <div className="flex-1 p-6">
                  {/* Session header */}
                  <div className="mb-6 flex flex-wrap items-center gap-3">
                    <h3 className="text-lg font-bold text-zinc-100">Add dark mode toggle</h3>
                    <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                      done
                    </span>
                    <span className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-400">
                      claude-code
                    </span>
                    <span className="ml-auto text-sm text-zinc-500" style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}>$0.24</span>
                  </div>

                  {/* Tabs */}
                  <div className="mb-4 flex gap-1 rounded-lg bg-zinc-800/40 p-1">
                    {["Overview", "Chat", "Diff", "Terminal"].map((tab, i) => (
                      <button
                        key={tab}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                          i === 2
                            ? "bg-zinc-700 text-zinc-100"
                            : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  {/* Diff preview */}
                  <div className="rounded-lg border border-zinc-800 bg-[#0c0c0e] overflow-hidden">
                    <div className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">
                      src/components/ThemeProvider.tsx
                      <span className="ml-2 text-emerald-400">+42</span>
                      <span className="ml-1 text-rose-400">-8</span>
                    </div>
                    <div className="p-4 text-xs leading-6" style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}>
                      <div className="text-zinc-600">  const [theme, setTheme] = useState(&quot;light&quot;);</div>
                      <div className="bg-rose-500/10 text-rose-400">- &nbsp;document.body.className = theme;</div>
                      <div className="bg-emerald-500/10 text-emerald-400">+ &nbsp;document.documentElement.classList.toggle(&quot;dark&quot;, theme === &quot;dark&quot;);</div>
                      <div className="bg-emerald-500/10 text-emerald-400">+ &nbsp;localStorage.setItem(&quot;theme&quot;, theme);</div>
                      <div className="text-zinc-600">  return {'<'}ThemeContext.Provider value={'{'}...{'}'}{'>'};</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Floating badges */}
            <div className="absolute -top-3 -right-3 hidden rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 shadow-xl sm:block">
              ✨ Real-time sessions
            </div>
            <div className="absolute -bottom-3 -left-3 hidden rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 shadow-xl sm:block">
              🔍 Code diffs
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
