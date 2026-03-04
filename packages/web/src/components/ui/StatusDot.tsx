import { cn } from "@/lib/cn";

type StatusDotStatus = "running" | "done" | "error" | "idle";

const statusColors: Record<StatusDotStatus, string> = {
  running: "bg-[var(--status-working)] attention-glow",
  done: "bg-[var(--status-ready)]",
  error: "bg-[var(--status-error)]",
  idle: "bg-[var(--status-idle)]",
};

interface StatusDotProps {
  status: StatusDotStatus;
  size?: "sm" | "md";
  className?: string;
}

export function StatusDot({ status, size = "sm", className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5",
        statusColors[status],
        className,
      )}
      aria-label={status}
    />
  );
}
