/**
 * Magic numbers, timeouts, CSS values, cache TTLs, and other constants
 * extracted from SessionTerminal.tsx.
 */

export const LIVE_TERMINAL_STATUSES = new Set([
  "queued",
  "spawning",
  "running",
  "working",
  "needs_input",
  "stuck",
]);

export const RESUMABLE_STATUSES = new Set([
  "done",
  "needs_input",
  "stuck",
  "errored",
  "terminated",
  "killed",
]);

export const RECONNECT_BASE_DELAY_MS = 300;
export const RECONNECT_MAX_DELAY_MS = 1600;
export const RENDERER_RECOVERY_THROTTLE_MS = 120;

// Keep enough scrollback so users can scroll through recent output without
// losing context on tab switch or mobile scroll. The backend owns the full
// durable capture (2 MB / 10 000 lines); the browser scrollback is sized per
// device class to avoid excessive memory on mobile.
export const DESKTOP_TERMINAL_SCROLLBACK = 10_000;
export const MOBILE_TERMINAL_SCROLLBACK = 2_000;
export const LIVE_TERMINAL_SCROLLBACK =
  typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? MOBILE_TERMINAL_SCROLLBACK
    : DESKTOP_TERMINAL_SCROLLBACK;

export const TERMINAL_UI_STATE_CACHE_MAX_ENTRIES = 4;
export const TERMINAL_UI_STATE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const LIVE_TERMINAL_HELPER_KEYS = [
  { label: "Enter", special: "Enter" },
  { label: "Tab", special: "Tab" },
  { label: "Esc", special: "Escape" },
  { label: "Bksp", special: "Backspace" },
  { label: "Left", special: "ArrowLeft" },
  { label: "Right", special: "ArrowRight" },
  { label: "Up", special: "ArrowUp" },
  { label: "Down", special: "ArrowDown" },
  { label: "Ctrl+C", special: "C-c" },
  { label: "Ctrl+D", special: "C-d" },
] as const;
