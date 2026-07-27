import {
  KEYBOARD_SAFE_VIEWPORT_DIALOG_MAX_HEIGHT_CLASS_NAME,
  KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME,
} from "@/components/layout/keyboardSafeViewport";

export const DISPATCHER_CHAT_FRAME_CLASS_NAME =
  "min-h-0 flex-1 h-full max-h-[var(--oc-visual-viewport-height,100dvh)] sm:h-full";

export const DISPATCHER_CHAT_FEED_SCROLL_CLASS_NAME =
  "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]";

export const DISPATCHER_SURFACE_OVERLAY_CLASS_NAME =
  "fixed inset-0 z-[130] bg-black/60 backdrop-blur-[2px]";

export const DISPATCHER_SURFACE_CONTENT_CLASS_NAME =
  `fixed inset-x-0 ${KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME} z-[131] flex flex-col overflow-hidden rounded-t-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_-24px_80px_rgba(0,0,0,0.42)] sm:left-1/2 sm:right-auto sm:top-1/2 sm:h-auto sm:w-[min(32rem,calc(100vw-2rem))] sm:max-w-[32rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[18px] sm:border ${KEYBOARD_SAFE_VIEWPORT_DIALOG_MAX_HEIGHT_CLASS_NAME}`;

export const DISPATCHER_DESKTOP_XL_MEDIA_QUERY = "(min-width: 1280px)";

export function watchDispatcherDesktopXl(
  onMatch: () => void,
  matchMediaFn:
    | ((query: string) => MediaQueryList)
    | null = typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia.bind(window),
): () => void {
  if (!matchMediaFn) {
    return () => {};
  }

  const mediaQuery = matchMediaFn(DISPATCHER_DESKTOP_XL_MEDIA_QUERY);
  const handleMatch = (matches: boolean) => {
    if (matches) {
      onMatch();
    }
  };
  const handleChange = (event: MediaQueryListEvent) => {
    handleMatch(event.matches);
  };

  handleMatch(mediaQuery.matches);

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }

  if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }

  return () => {};
}
