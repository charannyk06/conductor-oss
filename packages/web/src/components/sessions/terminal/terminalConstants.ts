/**
 * Terminal status sets used by SessionTerminal.tsx.
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
