import { cn } from "@/lib/cn";
import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantStyles: Record<ButtonVariant, string> = {
  default:
    "bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] border-[var(--color-border-default)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
  primary:
    "bg-[var(--color-accent)] text-white border-transparent hover:opacity-90",
  ghost:
    "bg-transparent text-[var(--color-text-secondary)] border-transparent hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]",
  danger:
    "bg-transparent text-[var(--color-status-error)] border-[rgba(239,68,68,0.3)] hover:bg-[rgba(239,68,68,0.08)]",
  outline:
    "bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border-default)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[11px] gap-1.5",
  md: "h-8 px-3 text-[12px] gap-2",
  lg: "h-9 px-4 text-[13px] gap-2",
  icon: "h-8 w-8 p-0",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "md", asChild, className, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md border font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1",
          "disabled:pointer-events-none disabled:opacity-40",
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...props}
      >
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";
