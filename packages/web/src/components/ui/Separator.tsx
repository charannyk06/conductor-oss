"use client";

import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

export const Separator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-[var(--border-soft)]",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";
