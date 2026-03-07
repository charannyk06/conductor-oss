import { useEvents } from "@/hooks/useEvents";

const eventColors: Record<string, string> = {
  TaskCreated: "text-blue-400",
  TaskStateChanged: "text-yellow-400",
  TaskCompleted: "text-green-400",
  SessionSpawned: "text-purple-400",
  SessionActive: "text-green-400",
  SessionNeedsInput: "text-orange-400",
  SessionErrored: "text-red-400",
  SessionTerminated: "text-zinc-400",
  BoardChanged: "text-cyan-400",
  SystemStarted: "text-green-300",
};

export function EventFeed() {
  const { events, connected, clear } = useEvents();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Events
          <span className={`ml-2 text-xs ${connected ? "text-green-400" : "text-red-400"}`}>
            {connected ? "● live" : "● disconnected"}
          </span>
        </h2>
        <button
          onClick={clear}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Clear
        </button>
      </div>

      {events.length === 0 ? (
        <p className="text-zinc-500 text-sm">Waiting for events...</p>
      ) : (
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {events.map((event, i) => {
            const eventType = typeof event === "object" && event !== null
              ? Object.keys(event).find((k) => k !== "timestamp") || "Unknown"
              : "Unknown";

            return (
              <div
                key={i}
                className="text-xs font-mono flex gap-2 py-0.5"
              >
                <span className={eventColors[eventType] || "text-zinc-400"}>
                  {eventType}
                </span>
                <span className="text-zinc-600 truncate">
                  {JSON.stringify(event).slice(0, 120)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
