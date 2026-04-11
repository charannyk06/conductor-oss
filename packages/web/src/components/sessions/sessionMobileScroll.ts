export const MOBILE_MOMENTUM_SCROLL_CLASS_NAME = "overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]";

export function getSessionDetailRootClassName(immersiveTerminalActive: boolean): string {
  return [
    "flex h-full min-h-0 min-w-0 w-full flex-col",
    immersiveTerminalActive
      ? "overflow-hidden bg-[#060404]"
      : "overflow-hidden",
  ].join(" ");
}
