import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "outline";

const variants: Record<BadgeVariant, string> = {
  default: "border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)]",
  success: "border-transparent bg-transparent text-[var(--vk-green)]",
  warning: "border-transparent bg-transparent text-[var(--vk-orange)]",
  error: "border-transparent bg-transparent text-[var(--vk-red)]",
  info: "border-transparent bg-transparent text-[var(--vk-text-muted)]",
  outline: "border-[var(--vk-border)] bg-transparent text-[var(--vk-text-muted)]",
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
        "inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-[11px] leading-none",
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
