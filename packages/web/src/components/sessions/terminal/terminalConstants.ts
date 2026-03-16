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

// -- ttyd binary protocol constants -------------------------------------------

/** Client -> Server: raw terminal input bytes. */
export const TTYD_CLIENT_INPUT = 0x30;
/** Client -> Server: resize JSON {"columns":N,"rows":N}. */
export const TTYD_CLIENT_RESIZE = 0x31;
/** Client -> Server: pause PTY output. */
export const TTYD_CLIENT_PAUSE = 0x32;
/** Client -> Server: resume PTY output. */
export const TTYD_CLIENT_RESUME = 0x33;

/** Server -> Client: raw PTY output bytes. */
export const TTYD_SERVER_OUTPUT = 0x30;
/** Server -> Client: window title. */
export const TTYD_SERVER_TITLE = 0x31;
/** Server -> Client: terminal preferences JSON. */
export const TTYD_SERVER_PREFS = 0x32;

/** High water mark (bytes pending) triggers PAUSE. */
export const TTYD_FLOW_HIGH_WATER = 80_000;
/** Low water mark (bytes pending) triggers RESUME. */
export const TTYD_FLOW_LOW_WATER = 20_000;

