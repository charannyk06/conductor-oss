import { StatusBar } from "@/components/StatusBar";
import { SessionList } from "@/components/SessionList";
import { ProjectList } from "@/components/ProjectList";
import { EventFeed } from "@/components/EventFeed";
import { ExecutorGrid } from "@/components/ExecutorGrid";

export function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <StatusBar />

      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl font-bold tracking-tight">
            <span className="text-blue-400">C</span>onductor
          </div>
          <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
            Rust
          </span>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Multi-agent orchestrator. Markdown-native. Local-first.
        </p>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <SessionList />
          <ProjectList />
        </div>

        <ExecutorGrid />

        <EventFeed />
      </main>

      <footer className="border-t border-zinc-800 px-6 py-3 text-center text-xs text-zinc-600">
        Conductor OSS · Apache-2.0 · Rust + Bun
      </footer>
    </div>
  );
}
