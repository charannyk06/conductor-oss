import { useHealth } from "@/hooks/useHealth";

const gradeColor: Record<string, string> = {
  A: "text-green-400",
  B: "text-yellow-400",
  C: "text-orange-400",
  F: "text-red-400",
};

export function StatusBar() {
  const { health, sessionHealth, error } = useHealth();

  if (error) {
    return (
      <div className="bg-red-950 border-b border-red-800 px-4 py-2 text-sm text-red-300">
        ⚠ {error}
      </div>
    );
  }

  if (!health) return null;

  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-4">
        <span className="text-green-400 font-mono">● online</span>
        <span className="text-zinc-400">v{health.version}</span>
        <span className="text-zinc-400">{health.executors} executor(s)</span>
      </div>
      {sessionHealth && (
        <div className="flex items-center gap-4">
          <span className="text-zinc-400">
            {sessionHealth.active} active
          </span>
          {sessionHealth.errored > 0 && (
            <span className="text-red-400">{sessionHealth.errored} errored</span>
          )}
          {sessionHealth.needs_input > 0 && (
            <span className="text-yellow-400">{sessionHealth.needs_input} needs input</span>
          )}
          {sessionHealth.sessions.map((s) => (
            <span key={s.id} className={`${gradeColor[s.grade] || "text-zinc-400"} font-mono text-xs`}>
              {s.executor}:{s.grade}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
