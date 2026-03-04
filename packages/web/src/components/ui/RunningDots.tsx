import { cn } from "@/lib/cn";

interface RunningDotsProps {
  className?: string;
}

export function RunningDots({ className }: RunningDotsProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label="Working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[#58a6ff]"
          style={{
            animation: "running-dot 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.16}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes running-dot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </span>
  );
}
