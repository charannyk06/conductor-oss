import { useState, useEffect } from "react";
import { api, type Session } from "@/lib/api";

const stateColors: Record<string, string> = {
  active: "bg-green-500",
  idle: "bg-blue-500",
  spawning: "bg-yellow-500",
  needs_input: "bg-orange-500",
  errored: "bg-red-500",
  terminated: "bg-zinc-600",
  restored: "bg-purple-500",
};

export function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    const fetchSessions = async () => {
      const data = await api.sessions(filter ? { state: filter } : undefined);
      setSessions(data);
    };
    fetchSessions();
    const timer = setInterval(fetchSessions, 3000);
    return () => clearInterval(timer);
  }, [filter]);

  const handleKill = async (id: string) => {
    await api.killSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <div className="flex gap-2">
          {["", "active", "needs_input", "errored"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded text-xs ${
                filter === f ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              {f || "all"}
            </button>
          ))}
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="text-zinc-500 text-sm">No sessions</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${stateColors[session.state] || "bg-zinc-500"}`} />
                <div>
                  <div className="text-sm font-medium">
                    {session.executor} · {session.project_id}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {session.id.slice(0, 8)} · {session.state}
                    {session.model && ` · ${session.model}`}
                    {session.branch && ` · ${session.branch}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {session.state !== "terminated" && (
                  <button
                    onClick={() => handleKill(session.id)}
                    className="px-2 py-1 text-xs bg-red-900 text-red-300 rounded hover:bg-red-800"
                  >
                    Kill
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
