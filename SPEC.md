# Native iframe terminal spec

## Goal
Replace Conductor OSS terminal delivery with a native PTY pipeline, xterm.js in a first-party iframe, no ttyd anywhere.

## Product requirements
- Real PTY shell in the browser via xterm.js
- Full ANSI color and raw terminal fidelity
- Session stays alive when the dashboard tab or iframe disconnects
- Reconnect restores visible terminal state immediately
- Mobile-friendly sizing and touch scroll
- Keep iframe architecture in the dashboard
- Remove ttyd launch, proxy, HTML mutation, and browser protocol code

## Architecture

### Backend
- Spawn agent CLIs directly through the existing executor PTY handles.
- Use the existing `terminal_hosts`, `TerminalStateStore`, restore snapshot, and terminal capture plumbing as the source of truth.
- Expose a native terminal WebSocket route at `/api/sessions/{id}/terminal/ws`.
- Keep `/api/sessions/{id}/terminal/token` as the connection bootstrap endpoint, but change the payload to native terminal URLs.
- Keep `/api/sessions/{id}/terminal/snapshot` for fallback and transcript restore.
- Archive stale loaded sessions on backend restart instead of trying to revive ttyd processes.

### Frontend
- Replace ttyd HTML iframe loading with a first-party embedded terminal page under `/embed/terminal/[id]`.
- The embedded page mounts xterm.js directly, fetches terminal connection info from `/api/sessions/{id}/terminal/token`, opens the terminal websocket, and renders reconnect and fallback states.
- The dashboard session panel still embeds an iframe. It no longer injects auth, resize, or relay shims into third-party HTML.

## Protocol

### Bootstrap response
`GET /api/sessions/{id}/terminal/token`

Returns:
- `token`
- `required`
- `expiresInSeconds`
- `wsUrl`
- `snapshotUrl`
- `outputUrl`

### WebSocket
Path: `/api/sessions/{id}/terminal/ws?token=...`

Client to server JSON messages:
- `{ "type": "hello", "cols": number, "rows": number }`
- `{ "type": "resize", "cols": number, "rows": number }`
- `{ "type": "input", "data": string }`
- `{ "type": "ping" }`

Server to client messages:
- binary frames, raw PTY bytes for terminal output and restore snapshots
- text JSON control messages:
  - `{ "type": "ready", "sequence": number, "cwd": string | null }`
  - `{ "type": "cwd", "cwd": string | null }`
  - `{ "type": "exit", "exitCode": number }`
  - `{ "type": "error", "message": string }`
  - `{ "type": "pong" }`

## Persistence model
- Browser disconnect must not kill the PTY.
- Live output continues to update `terminal_hosts` state and durable capture files.
- Reconnect sends the current restore snapshot first, then resumes live stream.
- Backend restart does not attempt ttyd-style session revival. Sessions loaded as active without an attached runtime are archived as stale.

## Implementation plan

### 1. Backend runtime cutover
- Replace `state/detached/ttyd_launcher.rs` with a native runtime launcher that calls `executor.spawn()` directly.
- Set `SpawnOptions.interactive = executor.supports_direct_terminal_ui()`.
- Mark metadata with `runtimeMode=direct`.
- Set `streams_terminal_bytes = true` when the executor handle has `terminal_rx`.
- Remove ttyd pid, port, ws, tunnel metadata.

### 2. Backend terminal routes
- Rewrite `routes/terminal.rs` to native routes only.
- Remove ttyd frontend HTTP route and ttyd websocket protocol handling.
- Add `/api/sessions/{id}/terminal/ws` websocket handler.
- Reuse terminal token signing and snapshot building.

### 3. Frontend iframe page
- Add `/embed/terminal/[id]/page.tsx`.
- Add a client component that mounts xterm, fit addon, mobile touch shim, and reconnect logic.
- On load, fetch `/api/sessions/{id}/terminal/token`.
- If live connection is available, connect to websocket and render terminal.
- If the session is closed, fetch `/api/sessions/{id}/output?lines=500` and render transcript.

### 4. Dashboard panel host
- Replace `SessionTerminal.tsx` with a lightweight iframe host.
- Iframe source points to `/embed/terminal/[id]` with bridge query when present.
- Preserve queued terminal inserts by sending `/api/sessions/{id}/keys` directly from the host component.

### 5. Cleanup
- Delete ttyd-specific Next routes and HTML patch helpers.
- Delete ttyd protocol files and tests.
- Update comments, runtime labels, and CSP frame exceptions.

## Verification
- `cargo test -p conductor-server`
- `cargo clippy -p conductor-server -- -D warnings`
- `bun run --cwd packages/web test`
- `bun run --cwd packages/web typecheck`
- Manual browser check:
  - open session terminal
  - type commands
  - resize panel
  - detach and reattach
  - verify transcript restore

## Non-goals in this cut
- Multi-viewer terminal fanout semantics beyond the existing broadcast stream
- Hosted browser-side websocket proxying outside the existing dashboard origin setup
- Keeping backward compatibility for ttyd URLs or ttyd HTML routes
