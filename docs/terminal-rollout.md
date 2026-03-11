# Terminal Rollout Notes

This document is the Stage 5 rollout companion for the clean-room terminal rewrite work. It is meant for operators validating the new terminal architecture before and during rollout.

## What To Measure

- Websocket bootstrap time:
  Measure how long `/api/sessions/:id/terminal/connection` takes to return a websocket URL and how long the browser needs to transition the terminal from `connecting` to `live`.
- Snapshot restore time:
  Measure `/api/sessions/:id/terminal/snapshot?lines=1200&live=1` on refresh and reconnect flows.
- Reconnect recovery:
  Confirm the terminal redraws and accepts input again after a tab refresh, browser reconnect, or transient network drop.
- Explicit fallback rate:
  Track how often remote sessions return `transport: "http-poll"`. That path should be explicit and rare, not a normal remote default.

## Lightweight Benchmark Recipes

Use a live session id while the backend is running locally.

Snapshot restore timing:

```bash
curl -sS -o /dev/null \
  -w 'snapshot status=%{http_code} total=%{time_total}s size=%{size_download}B\n' \
  "http://127.0.0.1:4749/api/sessions/<session-id>/terminal/snapshot?lines=1200&live=1"
```

Connection contract timing through the dashboard:

```bash
curl -sS \
  -w '\nconnection status=%{http_code} total=%{time_total}s\n' \
  "http://127.0.0.1:3000/api/sessions/<session-id>/terminal/connection"
```

Browser-side websocket bootstrap:

1. Open DevTools Network on the session detail page.
2. Reload the page with the terminal tab active.
3. Record:
   - terminal connection route duration
   - websocket handshake timing
   - time until the terminal accepts direct input again

## Rollout Guardrails

- Local desktop sessions should resolve websocket transport by default.
- Approved private remote paths such as Tailscale should resolve websocket transport once the remote runtime reports `ready`.
- `http-poll` is acceptable only when the remote websocket endpoint is not available yet or a real failure path is being exercised deliberately.
- Snapshot restore should keep the visible prompt and recent scrollback after refresh or reconnect.
- Resize should not corrupt the prompt or force an unwanted jump to the bottom when the user was reading older output.

## Recommended Acceptance Targets

- Local snapshot restore: typically under 200 ms on a warm backend.
- Remote snapshot restore: typically under 500 ms on a healthy private-network path.
- Reconnect notice to usable terminal: under 2 seconds on local or private-network connections.
- Unexpected `http-poll` transport rate: zero during nominal desktop and private-remote validation.

These are rollout guardrails, not protocol guarantees. If the environment is slower, capture the concrete numbers and compare them against previous runs before shipping.

## Operator Notes

- If a remote browser lands in `http-poll`, capture the response from `/api/sessions/:id/terminal/connection` before retrying.
- If restore output looks incomplete, capture the snapshot payload metadata:
  - `source`
  - `live`
  - `restored`
- If resize looks wrong, note device class, browser, window orientation, and whether the user was tailing output or scrolled up.
- Persistent websocket failures should include:
  - browser console errors
  - network handshake status
  - whether direct tmux attach still works via `co attach <session-id>`
