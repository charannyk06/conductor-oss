# Terminal Phase 2 Rollout Notes

This document is the Workstream E rollout companion for the Phase 2 terminal architecture merge. Use it to prove desktop, mobile, and private-remote terminal performance before merge and during rollout.

## Benchmark Hooks

The terminal HTTP surfaces now expose benchmark-friendly headers.

- `/api/sessions/:id/terminal/connection`
  - `Server-Timing: terminal_connection;dur=..., terminal_token;dur=...`
  - `x-conductor-terminal-transport`
  - `x-conductor-terminal-interactive`
  - `x-conductor-terminal-connection-path` with `direct`, `managed_remote`, `auth_limited`, or `unavailable`
- `/api/sessions/:id/terminal/snapshot`
  - `Server-Timing: terminal_snapshot;dur=...`
  - `x-conductor-terminal-snapshot-source`
  - `x-conductor-terminal-snapshot-live`
  - `x-conductor-terminal-snapshot-restored`
  - `x-conductor-terminal-snapshot-format` when the backend served a restore frame
- `/api/sessions/:id/terminal/resize`
  - `Server-Timing: terminal_resize;dur=...`
  - `x-conductor-terminal-resize-cols`
  - `x-conductor-terminal-resize-rows`

These headers are visible in browser DevTools and in `curl -D -` output, which keeps benchmarking out of the hot path and out of the UI.

## Quick Benchmark Pass

Use a live session id while the dashboard is running locally.

```bash
bun run bench:terminal -- <session-id>
```

The script hits connection, live snapshot, resize, and read-only snapshot endpoints through the dashboard and prints status, total request time, response size, `Server-Timing`, transport mode, and snapshot source metadata.

If dashboard auth is enabled, run the benchmark from a local operator environment or reproduce the same requests with equivalent auth headers or cookies.

## What To Track

- Attach latency
  - `terminal_connection` header timing
  - browser websocket handshake timing
  - time from page load to usable prompt
- Restore latency
  - `terminal_snapshot` header timing
  - total snapshot request time
  - whether the active prompt and recent scrollback survive refresh
- Resize control latency
  - `terminal_resize` header timing
  - visible prompt stability after viewport or orientation changes
- Reconnect success
  - whether the terminal returns to `websocket` instead of degrading into snapshot mode during nominal flows
  - time from disconnect notice to usable prompt
- Mobile input reliability
  - direct typing, Enter, Backspace, paste, accessory keys, and keyboard open or close stability

## Recommended Acceptance Targets

- Local desktop connection route: typically under 150 ms on a warm backend
- Local desktop live snapshot: typically under 200 ms on a warm backend
- Private-remote live snapshot: typically under 500 ms on a healthy network path
- Reconnect notice to usable prompt: under 2 seconds on local or private-remote paths
- Unexpected snapshot fallback rate: zero during nominal desktop and approved private-remote validation

These are merge targets, not protocol guarantees. Capture the observed numbers and compare them against the integration branch before shipping.

## Merge Readiness Gate

1. Run `cargo test --workspace` on a tmux-capable machine that allows tmux socket creation.
2. Run `cargo test -p conductor-server routes::terminal::tests -- --nocapture`.
3. Run `bun run typecheck`.
4. Run `bun run --cwd packages/web build`.
5. Run `bun test packages/web/src/components/sessions/sessionTerminalUtils.test.ts 'packages/web/src/app/api/sessions/[id]/terminal/connection/route.test.ts'`.
6. Complete the manual checklist in [docs/terminal-qa-checklist.md](docs/terminal-qa-checklist.md).
7. Record observed numbers in [docs/terminal-qa-matrix.md](docs/terminal-qa-matrix.md).

## Failure Capture

When a run fails, capture:

- session id
- device, browser, and local vs remote path
- response headers from the failing terminal endpoint
- terminal connection payload (`transport`, `interactive`, `fallbackReason`)
- terminal snapshot payload (`source`, `live`, `restored`, `format`, `sequence`)
- browser console and network errors
- whether `co attach <session-id>` still reaches the same tmux session
