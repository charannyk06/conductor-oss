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
          className="h-1.5 w-1.5 rounded-full bg-[var(--status-working)]"
          style={{
            animation: "run-dot 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.16}s`,
          }}
        />
      ))}
    </span>
  );
}
