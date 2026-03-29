# Paperclip-Inspired Adapter Improvements for Conductor OSS

## Context
Paperclip (github.com/paperclipai/paperclip) has a mature OpenClaw gateway adapter that demonstrates patterns Conductor OSS should adopt. This spec covers implementing those patterns across all Conductor agent adapters, with emphasis on the OpenClaw gateway executor.

## Reference: Paperclip's OpenClaw Gateway Adapter
- Location: `packages/adapters/openclaw-gateway/` (1434 lines, 46.7KB execute.ts)
- Key patterns: structured wake text, atomic issue checkout, auto-pairing, cost extraction, log redaction, idempotency keys, session key strategies

---

## Phase 1: OpenClaw Gateway Executor Enhancements (Rust)

### 1.1 Auto-Pairing on Connect Failure
**File:** `crates/conductor-executors/src/agents/openclaw.rs`

When the gateway connect fails with a "pairing required" error:
- Call `device.pair.list` over shared auth to find pending requests
- Call `device.pair.approve` with the matching requestId
- Retry the connect once
- Only attempt if `authToken` or `password` is available
- Persist the device token after approval for future connects

Implementation:
- Add `auto_approve_device_pairing()` async function
- Add `extract_pairing_request_id()` to parse requestId from error messages
- Wire into the existing connect loop with a single retry flag

### 1.2 Structured Log Redaction
**File:** `crates/conductor-executors/src/agents/openclaw.rs`

Add log redaction for sensitive keys before emitting tracing events:
- Pattern: auth, authorization, token, secret, password, api_key, private_key, x-openclaw-auth, x-openclaw-token
- Replace values with `[redacted len=N sha256=<prefix>]`
- Apply to connect params, headers, and outbound payloads

### 1.3 Cost/Usage Extraction from Gateway Response
**File:** `crates/conductor-executors/src/agents/openclaw.rs`

Parse the `agent.wait` response and `agent` event stream for:
- `meta.agentMeta.usage.{inputTokens, outputTokens, cachedInputTokens}`
- `meta.agentMeta.provider`
- `meta.agentMeta.model`
- `meta.agentMeta.costUsd`
- `meta.runtimeServices[]` (preview URLs, service status)

Emit these as structured metadata on the `ExecutorOutput::Completed` event.

### 1.4 Idempotency Key Formalization
**File:** `crates/conductor-executors/src/agents/openclaw.rs`

Currently we send `client_run_id` as idempotency. Formalize this:
- Use the Conductor session ID + run attempt number as the idempotency key
- Send it in `idempotencyKey` field of the chat.send/agent request
- Log the key for debugging dedup scenarios

### 1.5 Abort/Cancel Support
**File:** `crates/conductor-executors/src/agents/openclaw.rs`

We already have `send_abort()` which sends `chat.abort`. Enhance:
- Send abort on timeout (already done)
- Send abort when the card is moved to "done" or "cancelled" externally
- Track abort state to avoid processing late events

---

## Phase 2: Wake Context Injection (Rust + TS)

### 2.1 Structured Dispatch Context
**Files:**
- `crates/conductor-executors/src/prompt.rs` -- add `build_wake_context()`
- `crates/conductor-server/src/task_context.rs` -- extend task context

When dispatching to OpenClaw, inject structured context into the prompt:

```
Conductor dispatch context:
- session_id: <id>
- project_id: <id>
- board: <path>
- card_id: <card-id>
- card_title: <title>
- card_status: dispatching
- worktree: <path>
- branch: <branch>

Checkout workflow:
1. Mark card as in_progress (PATCH board or API)
2. Execute the task instructions
3. On completion: mark card as done with summary
4. On failure: mark card as blocked with error details

Idempotency key: <session_id>:<attempt>
```

### 2.2 API Endpoints for Card Checkout
**File:** `crates/conductor-server/src/state/` (new or extend existing)

Add atomic card checkout:
- `POST /api/cards/{card_id}/checkout` with `expected_statuses: ["ready", "dispatching"]`
- Returns 409 if status doesn't match (prevents double-dispatch)
- `PATCH /api/cards/{card_id}` with status + comment (like Paperclip's PATCH /api/issues/{id})

---

## Phase 3: Adapter Abstraction Pattern (Rust)

### 3.1 Unified Adapter Trait
**File:** `crates/conductor-executors/src/agents/mod.rs`

Define a common `AgentAdapter` trait that all agents implement:

```rust
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn name(&self) -> &str;
    async fn is_available(&self) -> bool;
    async fn version(&self) -> Result<String>;

    /// Core dispatch method. All agents implement this.
    async fn dispatch(&self, ctx: DispatchContext) -> Result<DispatchResult>;

    /// Optional: probe connectivity before dispatch.
    async fn probe(&self, timeout: Duration) -> Result<ProbeResult>;

    /// Optional: extract usage/cost from a completed run.
    fn extract_usage(&self, result: &DispatchResult) -> Option<UsageSummary>;
}
```

### 3.2 DispatchContext (shared across all adapters)
```rust
pub struct DispatchContext {
    pub run_id: String,
    pub session_key: String,
    pub prompt: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub timeout: Option<Duration>,
    pub env: HashMap<String, String>,
    pub task_meta: TaskMeta,  // card_id, project_id, board_path, etc.
}

pub struct TaskMeta {
    pub card_id: Option<String>,
    pub project_id: Option<String>,
    pub board_path: Option<PathBuf>,
    pub card_title: Option<String>,
    pub goal_chain: Vec<String>,  // ancestry: company goal -> project -> card
}
```

### 3.3 Implement for Each Agent

| Agent | Transport | Wake Context | Auto-Pair | Cost Extract |
|-------|-----------|-------------|-----------|-------------|
| OpenClaw | WS gateway | Yes (structured) | Yes | Yes (meta.agentMeta) |
| Claude Code | CLI subprocess | Yes (env vars) | N/A | Yes (JSON output) |
| Codex | CLI subprocess | Yes (env vars) | N/A | Yes (stream-json) |
| Gemini | CLI subprocess | Yes (env vars) | N/A | Partial |
| Cursor | CLI subprocess | Yes (env vars) | N/A | Partial |
| Amp | CLI subprocess | Yes (env vars) | N/A | Partial |
| OpenCode | CLI subprocess | Yes (env vars) | N/A | Partial |

---

## Phase 4: Session Key Strategy (Rust)

### 4.1 Session Routing
**File:** `crates/conductor-executors/src/agents/openclaw.rs`

Implement the same three strategies Paperclip uses:
- `issue` -> `conductor:card:{card_id}` (resume same session for same card)
- `run` -> `conductor:run:{run_id}` (new session per dispatch)
- `fixed` -> configured key

Already partially implemented in `resolve_session_key()`. Enhance:
- Add `session_key_strategy` to agent config
- Default to `issue` for OpenClaw (resume card work across heartbeats)
- Default to `run` for CLI agents (fresh session per dispatch)

---

## Phase 5: TS Dispatcher Adapter Alignment
**File:** `packages/openclaw-dispatcher/src/adapter.ts`

The TS adapter already has good patterns. Align with Paperclip:
- Add `ensureBinding()` auto-creation (already exists)
- Add `streamFeed()` with SSE deltas (already exists)
- Add `createTask()` / `updateTask()` / `handoffTask()` (already exists)
- Add cost tracking to `DispatcherFeedEntry` metadata
- Add goal ancestry to binding metadata

---

## Testing

### Unit Tests
- Auto-pairing: mock WS server, simulate pairing_required error, verify retry
- Log redaction: verify sensitive keys are redacted in output
- Cost extraction: parse sample gateway responses with usage data
- Session key: verify strategy resolution for issue/run/fixed modes
- Atomic checkout: verify 409 on status mismatch

### Integration Tests
- Full OpenClaw dispatch -> wake context -> agent response -> cost extraction
- Board card checkout -> dispatch -> completion flow
- Multi-agent dispatch with spawn limiter

---

## File Change Summary

### New Files
- None (all changes to existing files)

### Modified Files (Rust)
1. `crates/conductor-executors/src/agents/openclaw.rs` -- auto-pair, redaction, cost extraction, abort
2. `crates/conductor-executors/src/prompt.rs` -- wake context builder
3. `crates/conductor-executors/src/agents/mod.rs` -- AgentAdapter trait (if not exists)
4. `crates/conductor-server/src/task_context.rs` -- TaskMeta struct
5. `crates/conductor-core/src/types.rs` -- UsageSummary, DispatchResult types

### Modified Files (TS)
1. `packages/openclaw-dispatcher/src/adapter.ts` -- cost tracking, goal ancestry
2. `packages/openclaw-dispatcher/src/types.ts` -- new type fields

### Test Files
1. `crates/conductor-executors/src/agents/openclaw.rs` (inline tests)
2. `crates/conductor-executors/src/executor_ext_tests.rs`

---

## Priority Order
1. Auto-pairing in OpenClaw executor (highest value, smallest change)
2. Log redaction (security, small change)
3. Wake context injection (biggest UX improvement)
4. Cost/usage extraction (dashboard value)
5. Atomic card checkout (reliability)
6. Session key strategy enhancement (persistence)
7. AgentAdapter trait unification (architecture)
8. TS dispatcher alignment (integration)
