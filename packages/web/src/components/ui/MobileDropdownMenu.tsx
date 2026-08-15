"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Menus are portaled to document.body, so this layer must remain above every
 * application dialog/sheet (currently capped at z-[141]). Keeping the layer in
 * one place prevents a menu from opening invisibly behind its owning surface.
 */
export const MOBILE_DROPDOWN_LAYER_CLASS_NAME = "z-[160]";
export const MOBILE_DROPDOWN_COLLISION_PADDING = 16;

export const MOBILE_DROPDOWN_CONTENT_CLASS_NAME = [
  "oc-mobile-menu-content",
  MOBILE_DROPDOWN_LAYER_CLASS_NAME,
  "overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]",
  "outline-none",
].join(" ");

export const MOBILE_DROPDOWN_MAX_HEIGHT =
  "min(var(--radix-dropdown-menu-content-available-height), max(0px, calc(var(--oc-visual-viewport-height, 100dvh) - max(1rem, env(safe-area-inset-top)) - max(1rem, env(safe-area-inset-bottom)))))";

export const MOBILE_DROPDOWN_MAX_WIDTH =
  "min(var(--radix-dropdown-menu-content-available-width), max(0px, calc(100vw - max(0.5rem, env(safe-area-inset-left)) - max(0.5rem, env(safe-area-inset-right)))))";

type MobileDropdownMenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenu.Content>;

export const MobileDropdownMenuContent = forwardRef<
  ComponentRef<typeof DropdownMenu.Content>,
  MobileDropdownMenuContentProps
>(function MobileDropdownMenuContent(
  {
    children,
    className,
    collisionPadding = MOBILE_DROPDOWN_COLLISION_PADDING,
    sideOffset = 8,
    hideWhenDetached = true,
    style,
    ...props
  },
  ref,
) {
  const viewportSafeStyle: CSSProperties = {
    ...style,
    maxHeight: MOBILE_DROPDOWN_MAX_HEIGHT,
    maxWidth: MOBILE_DROPDOWN_MAX_WIDTH,
  };

  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        ref={ref}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        hideWhenDetached={hideWhenDetached}
        className={cn(className, MOBILE_DROPDOWN_CONTENT_CLASS_NAME)}
        style={viewportSafeStyle}
        {...props}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
});

MobileDropdownMenuContent.displayName = "MobileDropdownMenuContent";
