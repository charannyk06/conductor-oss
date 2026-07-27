export const KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR = "--oc-safe-viewport-height";
export const KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR = "--oc-visual-viewport-height";
export const KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR = "--oc-visual-viewport-offset-top";

export const KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VALUE = "var(--oc-safe-viewport-height,100dvh)";
export const KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VALUE = "var(--oc-visual-viewport-height,100dvh)";
export const KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VALUE = "var(--oc-visual-viewport-offset-top,0px)";

// Keep these as complete string literals so Tailwind can detect every arbitrary-value class.
export const KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME =
  "inset-x-0 top-[var(--oc-visual-viewport-offset-top,0px)] h-[var(--oc-visual-viewport-height,100dvh)]";
export const KEYBOARD_SAFE_VIEWPORT_MAX_BOTTOM_CLASS_NAME =
  "max-h-[var(--oc-safe-viewport-height,100dvh)]";
export const KEYBOARD_SAFE_VIEWPORT_FRAME_CLASS_NAME =
  "h-[var(--oc-visual-viewport-height,100dvh)]";
export const KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME =
  "max-h-[calc(var(--oc-visual-viewport-height,100dvh)-1.5rem)]";
export const KEYBOARD_SAFE_VIEWPORT_DIALOG_MAX_HEIGHT_CLASS_NAME =
  "sm:max-h-[calc(var(--oc-visual-viewport-height,100dvh)-3rem)]";
export const KEYBOARD_SAFE_VIEWPORT_SHEET_CLASS_NAME =
  "top-[calc(var(--oc-visual-viewport-offset-top,0px)+10dvh)] h-[calc(var(--oc-visual-viewport-height,100dvh)-10dvh)]";

export interface KeyboardSafeViewportMetrics {
  visibleHeight: number;
  offsetTop: number;
  bottom: number;
}

export function resolveStableLayoutViewportHeight(
  previousHeight: number,
  innerHeight: number,
  clientHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): number {
  const currentLayoutHeight = Math.max(
    0,
    ...[innerHeight, clientHeight].map((value) =>
      Number.isFinite(value) ? Math.max(0, value) : 0,
    ),
  );
  const hasVisualViewportHeight = Number.isFinite(visualViewportHeight) && visualViewportHeight > 0;
  if (!hasVisualViewportHeight) return Math.round(currentLayoutHeight);

  const safeOffsetTop = Number.isFinite(visualViewportOffsetTop)
    ? Math.max(0, visualViewportOffsetTop)
    : 0;
  const candidates = [previousHeight, currentLayoutHeight, visualViewportHeight + safeOffsetTop];

  return Math.round(
    Math.max(
      0,
      ...candidates.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0)),
    ),
  );
}

export function resolveKeyboardSafeViewportMetrics(
  layoutViewportHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): KeyboardSafeViewportMetrics {
  const hasLayoutViewportHeight = Number.isFinite(layoutViewportHeight) && layoutViewportHeight > 0;
  const safeLayoutHeight = hasLayoutViewportHeight ? Math.max(0, layoutViewportHeight) : 0;
  const hasVisualViewportHeight = Number.isFinite(visualViewportHeight) && visualViewportHeight > 0;
  const rawVisibleHeight = hasVisualViewportHeight
    ? Math.max(0, visualViewportHeight)
    : safeLayoutHeight;
  const rawOffsetTop = hasVisualViewportHeight && Number.isFinite(visualViewportOffsetTop)
    ? Math.max(0, visualViewportOffsetTop)
    : 0;
  const bottom = hasLayoutViewportHeight
    ? Math.min(safeLayoutHeight, rawOffsetTop + rawVisibleHeight)
    : rawOffsetTop + rawVisibleHeight;
  const offsetTop = Math.min(rawOffsetTop, bottom);
  const visibleHeight = Math.max(0, bottom - offsetTop);

  return {
    visibleHeight: Math.round(visibleHeight),
    offsetTop: Math.round(offsetTop),
    bottom: Math.round(bottom),
  };
}

export function resolveKeyboardSafeViewportHeight(
  layoutViewportHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): number {
  return resolveKeyboardSafeViewportMetrics(
    layoutViewportHeight,
    visualViewportHeight,
    visualViewportOffsetTop,
  ).bottom;
}
