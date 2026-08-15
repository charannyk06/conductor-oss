import type { CSSProperties } from "react";

/**
 * Mobile board scrolling deliberately has one vertical owner. The whole board
 * surface scrolls so its controls can leave the viewport; the Kanban rail only
 * owns horizontal movement. Desktop keeps the fixed toolbar and independently
 * scrolling columns.
 */
export const BOARD_SCROLL_SURFACE_CLASS_NAME =
  "flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain touch-auto [-webkit-overflow-scrolling:touch] xl:overflow-hidden";

export const BOARD_HEADER_CLASS_NAME =
  "shrink-0 border-b border-[var(--vk-border)] px-3 py-2.5 xl:px-4 xl:py-4";

export const BOARD_CONTENT_CLASS_NAME =
  "min-h-[240px] min-w-0 flex-none overflow-visible p-3 sm:p-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain";

export const BOARD_KANBAN_SHELL_CLASS_NAME =
  "flex min-h-0 flex-col gap-3 xl:h-full xl:gap-4";

export const BOARD_KANBAN_RAIL_CLASS_NAME =
  "flex min-w-0 snap-x snap-proximity scroll-px-0.5 flex-row items-stretch gap-3 overflow-x-auto overflow-y-auto px-0.5 pb-3 xl:h-full xl:snap-none xl:gap-0 xl:px-0";

// Inline axis-specific values intentionally win over globals.css's coarse-pointer
// Y-axis containment. The rail contains horizontal bounce while vertical gestures
// at its zero-range Y boundary chain to the board page.
export const BOARD_KANBAN_RAIL_TOUCH_STYLE = {
  WebkitOverflowScrolling: "touch",
  touchAction: "pan-x pan-y",
  overscrollBehaviorX: "contain",
  overscrollBehaviorY: "auto",
} satisfies CSSProperties;

export const BOARD_KANBAN_COLUMN_CLASS_NAME =
  "flex h-auto min-h-[280px] w-[min(85vw,320px)] shrink-0 snap-start flex-col border border-[var(--vk-border)] bg-[var(--vk-bg-main)] shadow-none xl:h-full xl:min-h-0 xl:w-[320px] xl:border-l-0 first:xl:border-l";

export const BOARD_KANBAN_COLUMN_BODY_CLASS_NAME =
  "min-h-0 flex-none overflow-visible px-3 pb-3 pt-2 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain";
