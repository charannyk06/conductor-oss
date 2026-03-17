# Terminal Phase 2 Rollout Notes

This document is the Workstream E rollout companion for the Phase 2 terminal architecture migration. Use it to prove desktop, mobile, and private-remote terminal performance before merge and during rollout.

## Benchmark Hooks

The terminal HTTP surfaces now expose benchmark-friendly headers.

- `/api/sessions/:id/terminal/token`
  - `required`
  - `expiresInSeconds`
- `/api/sessions/:id/terminal/snapshot`
  - `Server-Timing: terminal_snapshot;dur=...`
  - `x-conductor-terminal-snapshot-source`
  - `x-conductor-terminal-snapshot-live`
  - `x-conductor-terminal-snapshot-restored`
  - `x-conductor-terminal-snapshot-format` when the backend served a restore frame

These headers are visible in browser DevTools and in `curl -D -` output, which keeps benchmarking out of the hot path and out of the UI.

## Quick Benchmark Pass

Use a live session id while the dashboard is running locally.

```bash
bun run bench:terminal -- <session-id>
```

The script hits token, live snapshot, and read-only snapshot endpoints through the dashboard and prints status, total request time, response size, and `Server-Timing`. Live terminal streaming remains token- and ttyd-native (`/terminal/ws?protocol=ttyd`).

If dashboard auth is enabled, run the benchmark from a local operator environment or reproduce the same requests with equivalent auth headers or cookies.

## What To Track

- Attach latency
  - browser websocket handshake timing
  - time from page load to usable prompt
- Restore latency
  - `terminal_snapshot` header timing
  - total snapshot request time
  - whether the active prompt and recent scrollback survive refresh
- Resize control latency
  - browser-observed ttyd resize round-trip timing
  - visible prompt stability after viewport or orientation changes
- Reconnect success
  - whether token refresh and direct ttyd reconnect succeed during nominal flows
  - whether the terminal returns to live streaming quickly without entering full snapshot mode
  - time from disconnect notice to usable prompt
- Mobile input reliability
  - direct typing, Enter, Backspace, paste, accessory keys, and keyboard open or close stability

## Recommended Acceptance Targets

- Local desktop token + ttyd websocket path: typically under 150 ms on a warm backend
- Local desktop live snapshot: typically under 200 ms on a warm backend
- Private-remote live snapshot: typically under 500 ms on a healthy network path
- Reconnect notice to usable prompt: under 2 seconds on local or private-remote paths
- Unexpected snapshot fallback rate: zero during nominal desktop and approved private-remote validation

These are merge targets, not protocol guarantees. Capture the observed numbers and compare them against the integration branch before shipping.

## Merge Readiness Gate

1. Run `cargo test --workspace` on a Unix-like machine with native PTY support.
2. Run `cargo test -p conductor-server routes::terminal::tests -- --nocapture`.
3. Run `bun run typecheck`.
4. Run `bun run --cwd packages/web build`.
5. Run `bun test --cwd packages/web src/components/sessions/sessionTerminalUtils.test.ts`.
6. Complete the manual checklist in [docs/terminal-qa-checklist.md](docs/terminal-qa-checklist.md).
7. Record observed numbers in [docs/terminal-qa-matrix.md](docs/terminal-qa-matrix.md).

## Failure Capture

When a run fails, capture:

- session id
- device, browser, and local vs remote path
- response headers from the failing terminal endpoint
- terminal token payload (`required`, `expiresInSeconds`)
- terminal snapshot payload (`source`, `live`, `restored`, `format`, `sequence`)
- ttyd websocket close code, open timing, and reconnect timing
- browser console and network errors
- whether `co attach <session-id>` still reaches the same live session
