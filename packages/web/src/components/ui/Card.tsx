import { cn } from "@/lib/cn";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-[var(--color-card-border)] bg-[var(--color-card-bg)] shadow-sm",
        "transition-all duration-150",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border-subtle)]", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center gap-2 px-4 py-2.5 border-t border-[var(--color-border-subtle)]", className)}
      {...props}
    />
  );
}
