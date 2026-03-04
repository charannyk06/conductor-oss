import { cn } from "@/lib/cn";

type StatusDotStatus = "running" | "done" | "error" | "idle";

const statusColors: Record<StatusDotStatus, string> = {
  running: "bg-emerald-500 animate-pulse",
  done: "bg-emerald-500",
  error: "bg-red-500",
  idle: "bg-[#484f58]",
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
