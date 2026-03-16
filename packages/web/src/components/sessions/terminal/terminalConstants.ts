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

export const RECONNECT_BASE_DELAY_MS = 300;
export const RECONNECT_MAX_DELAY_MS = 1600;
export const RECONNECT_MAX_ATTEMPTS = 6;
export const RECONNECT_HEALTHY_THRESHOLD_MS = 2_000;
export const RENDERER_RECOVERY_THROTTLE_MS = 120;
export const TERMINAL_WRITE_BATCH_MAX_DELAY_MS = 16;
export const TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS = 10;
export const DETACH_DELAY_MS = 120;
export const SHELL_CRASH_DETECTION_WINDOW_MS = 5_000;

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

export const READ_ONLY_TERMINAL_SNAPSHOT_LINES = 10_000;

export const TERMINAL_CONNECTION_CACHE_MAX_TTL_MS = 5_000;
export const TERMINAL_CONNECTION_CACHE_MAX_ENTRIES = 2;
export const TERMINAL_SNAPSHOT_CACHE_MAX_ENTRIES = 8;
export const TERMINAL_UI_STATE_CACHE_MAX_ENTRIES = 4;
export const TERMINAL_SNAPSHOT_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
export const TERMINAL_UI_STATE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

