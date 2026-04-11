export const MOBILE_MOMENTUM_SCROLL_CLASS_NAME = "overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]";
export const SESSION_PREVIEW_SCROLL_SHELL_CLASS_NAME = "min-h-0 flex-1 overflow-hidden bg-[#0f1012] p-3";
export const SESSION_SCROLL_AREA_VIEWPORT_CLASS_NAME = MOBILE_MOMENTUM_SCROLL_CLASS_NAME;

export function getSessionDetailRootClassName(immersiveTerminalActive: boolean): string {
  return [
    "flex h-full min-h-0 min-w-0 w-full flex-col",
    immersiveTerminalActive
      ? "overflow-hidden bg-[#060404]"
      : "overflow-hidden",
  ].join(" ");
}
