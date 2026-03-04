import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "outline";

const variants: Record<BadgeVariant, string> = {
  default:
    "bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] border-[var(--color-border-subtle)]",
  success:
    "bg-[rgba(34,197,94,0.12)] text-[var(--color-accent-green)] border-[rgba(34,197,94,0.2)]",
  warning:
    "bg-[rgba(245,158,11,0.12)] text-[var(--color-accent-yellow)] border-[rgba(245,158,11,0.2)]",
  error:
    "bg-[rgba(239,68,68,0.12)] text-[var(--color-accent-red)] border-[rgba(239,68,68,0.2)]",
  info:
    "bg-[var(--color-accent-subtle)] text-[var(--color-accent)] border-[rgba(59,130,246,0.2)]",
  outline:
    "bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border-default)]",
};

interface BadgeProps {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
}

export function Badge({ variant = "default", className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-none",
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
