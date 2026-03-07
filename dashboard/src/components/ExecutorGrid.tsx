import { useState, useEffect } from "react";
import { api, type ExecutorInfo } from "@/lib/api";

const executorIcons: Record<string, string> = {
  "claude-code": "🟣",
  codex: "🟢",
  gemini: "🔵",
  amp: "⚡",
  "cursor-cli": "🔶",
  opencode: "🟡",
  droid: "🤖",
  "qwen-code": "🔴",
  ccr: "🔧",
  "github-copilot": "🐙",
};

export function ExecutorGrid() {
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);

  useEffect(() => {
    api.executors().then(setExecutors);
  }, []);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Available Executors</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {executors.map((exec) => (
          <div
            key={exec.kind}
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center"
          >
            <div className="text-2xl">{executorIcons[exec.kind] || "🔧"}</div>
            <div className="text-sm font-medium mt-1">{exec.name}</div>
            <div className="text-xs text-zinc-500 font-mono truncate">{exec.binary}</div>
          </div>
        ))}
        {executors.length === 0 && (
          <p className="text-zinc-500 text-sm col-span-full">No executors discovered</p>
        )}
      </div>
    </div>
  );
}
