# Dispatcher Streaming End-to-End Fix

## Problem

Dispatcher replies do not arrive like Codex or ChatGPT. They pause, then dump large chunks. Tool activity can also make the active assistant response flicker or split into multiple rows.

The currently installed Conductor 0.62.1 process is running from `~/.conductor/npm/...`, not from the dirty source branch that contains prior streaming work. Main still launches Codex with `codex exec --json`, whose normal output is item-oriented and often exposes completed assistant items rather than byte-exact live text deltas. Main already has dispatcher SSE and a 50 ms per-thread publication debounce, so adding another timer is not the answer.

## Scope

Implement and ship a focused streaming change from `origin/main`. The dirty checkout at `/Users/charannsrinivas/.openclaw/projects/conductor-oss` is reference-only and must not be modified or cleaned. It contains prior streaming experiments plus unrelated mobile and notes work. Reuse only grounded streaming code.

## Required behavior

1. Runtime adapters expose a first-class byte-exact assistant delta event. Delta text must never be trimmed, newline-normalized, or heuristically deduplicated.
2. Codex dispatcher turns use the Codex app-server protocol when available so `item/agentMessage/delta` notifications become live assistant deltas. Preserve model, reasoning, cwd, sandbox and approval behavior, the bounded pre-turn handshake, cancellation, stderr diagnostics, real legacy fallback if app-server startup fails before the turn begins, and the dispatcher rule that every headless turn rebuilds from the durable transcript instead of using a native resume target.
3. Structured streaming adapters for Claude Code, Gemini, Qwen, and OpenClaw emit assistant deltas when their native protocols provide them. Completed or final frames must not duplicate already-streamed text.
4. Dispatcher state keeps one canonical active assistant row per user turn. Tool and status rows may be interleaved without splitting subsequent assistant deltas into a new message.
5. Existing 50 ms publication batching remains the single server-side cadence control. Duplicate or no-op fragments must not churn timestamps or rebuild feeds.
6. Protocol 2 SSE emits a compact patch for exactly one changed streaming entry by stable entry ID, even when that entry is not the tail because a tool card follows it. If identity, ordering, or multiple entries change, send a full replace snapshot.
7. Compact patches carry UTF-16 offsets because browser string offsets use UTF-16 code units. Replayed duplicate patches are idempotent. Offset mismatch, server lag refresh, or reconnect must safely resync by replacement.
8. The React client updates only the changed entry, preserves tool cards and scroll behavior, and does not reconnect or refetch the whole feed per token.
9. Do not include unrelated mobile shell, notes, board, bridge, layout, or visual changes.

## Acceptance tests

- Rust unit tests for byte-exact delta parsing and no duplicate final output across supported structured adapters.
- Codex app-server protocol tests for initialize, thread start, turn start, delta forwarding, tool and status forwarding, completion, errors, cancellation, and paths with spaces.
- Dispatcher regressions proving Codex ignores stale persisted native resume targets and app-server thread-start metadata exposes `codexThreadId` telemetry without claiming native resume.
- Dispatcher-state tests proving one assistant row across interleaved tool cards and duplicate or no-op behavior.
- SSE tests for non-tail single-entry patching, multi-entry replacement fallback, UTF-16 emoji offsets, lag refresh recovery, and keepalive.
- Frontend reducer tests for delta apply, duplicate replay, offset mismatch replacement, non-tail entry update, and stable tool entries.
- `cargo fmt --check`
- `cargo test -p conductor-executors`
- `cargo test -p conductor-server`
- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`
- `bun run --cwd packages/web test`
- `bun run typecheck`
- `bun run build:frontend`
- Real alternate-port source smoke using local Codex: observe multiple assistant text updates before turn completion, no chunk dump, one assistant row, and final text equality.
- Browser smoke against the source build with no relevant console errors.

## Delivery

Commit only focused files, push the branch, open a PR using the repository's required release-note and type-of-change sections, and update the locally running app only after the exact built source has passed the checks above.
