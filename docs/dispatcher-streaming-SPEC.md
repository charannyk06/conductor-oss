# Dispatcher Streaming End-to-End Fix

## Problem

Dispatcher replies do not arrive like Codex or ChatGPT. They pause, then dump large chunks. Tool activity can also make the active assistant response flicker or split into multiple rows.

The currently installed Conductor process is not running from the dirty source branch that contains prior streaming work. Main still launches Codex with `codex exec --json`, whose normal output is item-oriented and often exposes completed assistant items rather than byte-exact live text deltas. Main already has dispatcher SSE and a 50 ms per-thread publication debounce, so adding another timer is not the answer.

## Scope

Implement and ship a focused streaming change from `origin/main`. Any separate dirty checkout used as reference-only must not be modified or cleaned. Reuse only grounded streaming code.

## Required behavior

1. Runtime adapters expose a first-class byte-exact assistant delta event. Delta text must never be trimmed, newline-normalized, or heuristically deduplicated.
2. Codex dispatcher turns use the Codex app-server protocol when available so `item/agentMessage/delta` notifications become live assistant deltas. Preserve model, reasoning, cwd, sandbox and approval behavior, the bounded pre-turn handshake, cancellation, stderr diagnostics, real legacy fallback if app-server startup fails before the turn begins, and the dispatcher rule that every headless turn rebuilds from the durable transcript instead of using a native resume target.
3. Structured streaming adapters for Claude Code, Gemini, Qwen, and OpenClaw emit assistant deltas when their native protocols provide them. Completed or final frames must not duplicate already-streamed text.
4. Dispatcher state keeps one stable assistant row per contiguous assistant segment. A newly appended runtime tool or status lifecycle row seals the prior assistant segment; later assistant deltas must create and then keep updating a new tail assistant row after that barrier. Tool lifecycle updates matched by `toolCallId` still update their original row in place and must not retroactively barrier a later assistant segment.
5. Existing 50 ms publication batching remains the single server-side cadence control. Duplicate or no-op fragments must not churn timestamps or rebuild feeds.
6. Protocol 2 SSE emits a compact patch for exactly one changed streaming entry by stable entry ID, even when that entry is not the tail because a tool card follows it. If identity, ordering, or multiple entries change, send a full replace snapshot.
7. Compact patches carry UTF-16 offsets because browser string offsets use UTF-16 code units. Replayed duplicate patches are idempotent. Offset mismatch, server lag refresh, or reconnect must safely resync by replacement.
8. The React client updates only the changed entry, preserves tool cards and scroll behavior, and does not reconnect or refetch the whole feed per token.
9. Do not include unrelated mobile shell, notes, board, bridge, layout, or visual changes.

## Hosted Paired-Device Transport Contract

The hosted paired-device path must not downgrade `text/event-stream` into a buffered JSON response. The browser-facing route, relay HTTP proxy, paired-device bridge WebSocket, and local backend must all preserve a live byte stream.

### HTTP relay request shape

Hosted event-stream routes call the relay device proxy with a JSON body shaped like:

```json
{
  "method": "GET",
  "path": "/api/projects/<project>/dispatcher/feed/stream?...",
  "stream": true,
  "headers": {
    "accept": "text/event-stream",
    "cache-control": "no-cache"
  }
}
```

- `stream: true` selects the streamed paired-device transport.
- Existing buffered `method` / `path` / `body` requests remain unchanged when `stream` is omitted or false.
- Request headers are optional and must be sanitized. Never forward cookies, authorization headers, hop-by-hop headers, or injected forwarded headers through the bridge protocol.

### Bridge WebSocket lifecycle

The paired-device bridge protocol now has a first-class streamed API request flow:

- Bridge capability negotiation:
  - The bridge advertises streamed API support by including `api_stream_v1` in every `bridge_status.capabilities` payload.
  - The relay normalizes capabilities per active bridge connection and must reset capability knowledge on every bridge reconnect so stale capabilities cannot be reused.
  - Before the active bridge has reported its first `bridge_status`, streamed HTTP requests fail closed with `425 Too Early` or `503 Service Unavailable` so EventSource retries without sending any fallback `api_request`.
  - After the active bridge has reported status, the relay uses the streamed transport only when that status explicitly includes `api_stream_v1`.
  - Bridges that report status without `api_stream_v1` fail streamed HTTP requests immediately with `426 Upgrade Required`. Do not downgrade `text/event-stream` requests into buffered `api_request` traffic.
- Browser/relay to bridge:
  - `api_stream_request { id, method, path, headers?, body? }`
  - `api_stream_cancel { id }`
- Bridge to relay/browser:
  - `api_stream_start { id, status, headers }`
  - `api_stream_chunk { id, chunk_base64 }`
  - `api_stream_end { id, error? }`

Rules:

- Every streamed request is keyed by a unique `id`.
- `api_stream_start` must be the first response message for that `id`.
- `api_stream_chunk` payloads are raw upstream bytes encoded as base64. The bridge must not buffer the full response to reassemble text.
- `api_stream_end` always terminates the lifecycle for that `id`.
- `api_stream_cancel` aborts only the currently registered in-flight stream for the same `id`. The bridge must remove that registration atomically with the abort decision so a completed stream cannot leave a stale later handle behind.
- Unknown, already-completed, or already-cancelled `api_stream_cancel` IDs are ignored.
- A request ID may only be completed, chunked, or ended by the pending stream entry registered for the same device. Wrong-device or stale-connection messages are ignored and must not complete another request.

### Header and body preservation

- Preserve upstream status code from the paired machine.
- Preserve safe response headers from the paired machine, especially:
  - `content-type: text/event-stream`
  - `cache-control: no-cache, no-transform`
  - `x-accel-buffering: no`
- Strip hop-by-hop headers, `content-length`, `content-encoding`, cookies, and any unsafe or malformed header values.
- The hosted Next route must pass the upstream `ReadableStream` through directly instead of wrapping it in a buffering transform.

## Failure Recovery

The streamed paired-device path must fail closed and clean up pending state on every exit path.

- Before `api_stream_start`:
  - If the bridge cannot reach the paired backend, it synthesizes a short 5xx JSON error response through the stream lifecycle.
  - If the relay has not processed bridge status yet, it returns `425 Too Early` or `503 Service Unavailable` without sending any upstream request so EventSource can retry cleanly.
  - If the relay has processed bridge status and the bridge does not advertise `api_stream_v1`, it returns `426 Upgrade Required` without sending any upstream request.
  - If the relay forwards `api_stream_request` but never receives `api_stream_start`, it returns a 503 or 504 HTTP error and removes the pending stream entry.
- After `api_stream_start`:
  - If the paired backend errors mid-stream, the bridge sends `api_stream_end { error }` and stops reading upstream bytes.
  - If the hosted client disconnects, the relay drops the pending stream registration immediately. Later chunks for that ID are discarded.
  - If the hosted route times out, closes early, or detects a protocol failure after forwarding `api_stream_request`, the relay removes the pending request first and then best-effort sends `api_stream_cancel { id }` so only the matching paired stream is aborted.
  - If the bridge disconnects or a device is deleted, the relay removes all pending streamed requests for that device and closes their bodies.
  - If the hosted reader stops consuming and the per-stream relay queue fills, the relay removes the pending stream entry instead of buffering without bound.
- The bridge receive loop must never await a whole streamed response. Stream forwarding runs in its own bounded task so Ping, file browse, preview, and terminal control traffic keep flowing while the stream is open.
- Dispatcher SSE reconnect behavior remains the user-visible recovery path after a mid-stream close. Do not add polling as a workaround.

## Acceptance tests

- Rust unit tests for byte-exact delta parsing and no duplicate final output across supported structured adapters.
- Codex app-server protocol tests for initialize, thread start, turn start, delta forwarding, tool and status forwarding, completion, errors, cancellation, and paths with spaces.
- Dispatcher regressions proving Codex ignores stale persisted native resume targets and app-server thread-start metadata exposes `codexThreadId` telemetry without claiming native resume.
- Dispatcher-state tests proving exact user/assistant/tool chronology, one stable assistant row per contiguous segment, stable updates within each segment, tool completion updates in place, final-only snapshot fallback, and duplicate or no-op behavior.
- SSE tests for non-tail single-entry patching, multi-entry replacement fallback, UTF-16 emoji offsets, lag refresh recovery, and keepalive.
- Bridge transport tests for streamed request serialization, `start` / `chunk` / `end` correlation, and in-flight control-message handling while a stream stays open.
- Relay tests that prove chunk 1 reaches the hosted reader before chunk 2 and `end`, and that pending stream state is cleaned up on `end`, `error`, disconnect, and backpressure.
- Hosted web proxy tests that prove bridge-backed dispatcher feed routes return a live streaming body rather than waiting for completion.
- Frontend reducer tests for delta apply, duplicate replay, offset mismatch replacement, non-tail entry update, and stable tool entries.
- `cargo fmt --check`
- `cargo test -p conductor-executors`
- `cargo test -p conductor-server`
- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`
- `bun run --cwd packages/web test`
- `bun run typecheck`
- `bun run build:frontend`
- Real alternate-port source smoke using local Codex: observe multiple assistant text updates before turn completion, no chunk dump, one assistant row per contiguous assistant segment, preserved tool/assistant chronology, and final text equality.
- Browser smoke against the source build with no relevant console errors.

## Delivery

Commit only focused files, push the branch, open a PR using the repository's required release-note and type-of-change sections, and update the locally running app only after the exact built source has passed the checks above.

## PR Sections

Required `## User-Facing Release Notes` section:

- Use 1-3 plain-English bullets, or `N/A - internal maintenance only`

Required `## Type of Change` section:

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Agent or integration addition / modification
- [ ] Documentation update
- [ ] Refactor / chore
