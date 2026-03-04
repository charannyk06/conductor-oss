import { cn } from "@/lib/cn";
import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantStyles: Record<ButtonVariant, string> = {
  default: "border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]",
  primary: "border-[var(--vk-border)] bg-[var(--vk-bg-active)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]",
  ghost: "border-transparent bg-transparent text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]",
  danger: "border-[var(--vk-red)]/40 bg-[color:color-mix(in_srgb,var(--vk-red)_18%,transparent)] text-[var(--vk-red)] hover:bg-[color:color-mix(in_srgb,var(--vk-red)_24%,transparent)]",
  outline: "border-[var(--vk-border)] bg-transparent text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1",
  md: "h-8 px-3 text-[13px] gap-1.5",
  lg: "h-9 px-3.5 text-[14px] gap-2",
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
          "inline-flex items-center justify-center rounded-[var(--radius-sm)] border font-medium",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--vk-orange)]",
          "disabled:pointer-events-none disabled:opacity-45",
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
