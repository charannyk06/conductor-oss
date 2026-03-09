# Conductor OSS: Complete TS-to-Rust Migration Plan

> Goal: Eliminate all TypeScript/Rust duplication. Rust backend becomes the single source of truth for ALL logic. Next.js dashboard becomes a pure frontend (thin API proxy). CLI delegates entirely to the Rust binary.
>
> **Last reviewed:** Mar 9, 2026 (full end-to-end code audit, all 7 Rust crates + 4 TS packages)

## Current State (Corrected)

| Layer | TypeScript (lines) | Rust (lines) | Actual Status |
|-------|-------------------|-------------|---------------|
| Core types/models | 1,467 (types.ts) | 148 (core/types.rs) + 291 (state/types.rs) | Two type systems coexist. Server types are functional; core types need consolidation |
| Config loading | 850 (config.ts) | 697 (config.rs) | ~80% parity |
| Board parser | 315 (board-parser.ts) | 391 (board.rs) | ~90% parity. **BUG: metadata lost on roundtrip** |
| Session manager | 1,960 (session-manager.ts) | 2,485 (session_manager.rs) | ~85% parity. Duplicated Stdout logic between append_and_apply/apply_runtime_event |
| Board watcher | 2,519 (board-watcher.ts) | 130 (watcher/lib.rs) + 350 (runtime.rs automation) | **Working**, not skeleton. Has debouncing, SHA256 hashing, notify integration. Missing: AI enhancement dispatch, write guard |
| Lifecycle manager | 1,024 (lifecycle-manager.ts) | Partial: tmux_runtime.rs (1,642) + spawn_queue.rs (295) + runtime_status.rs (973) | Activity detection, spawn supervision, session health done. **Missing: PR tracking, CI monitoring, review routing** |
| Plugin registry | ~200 (plugin-registry.ts) | 50 (discovery.rs) | Discovery done via macro. No dynamic plugin loading needed in Rust |
| Prompt builder | 246 (prompt-builder.ts) | 0 | Not started in Rust |
| Spawn limiter | 142 (spawn-limiter.ts) | 296 (dispatcher.rs) | Done in Rust |
| Event bus | 152 (event-bus.ts) | 141 (event.rs) | Done in Rust |
| Config sync | 301 (config-sync.ts) | 480+ (support.rs) | **Done in Rust.** Project mirror regeneration, support file sync, managed/unmanaged detection. Has tests |
| Scaffold | 258 (scaffold.ts) | 0 | Not started in Rust |
| Agent plugins (10) | 3,874 total | 3,532 total | ~90% parity |
| Runtime tmux | 207 | 1,642 (tmux_runtime.rs) | Done in Rust (exceeds TS) |
| Workspace worktree | 667 | 986 (workspace.rs) | Done in Rust |
| SCM GitHub | 421 | 2,434 (github.rs routes) | Done in Rust (exceeds TS) |
| MCP server | 424 | 0 | Not started in Rust |
| Notifier desktop | 122 | 0 | Not started in Rust |
| Notifier discord | 200 | 0 | Not started in Rust |
| Tracker GitHub | 171 | 0 | Not started in Rust |
| Terminal web | 64 | 0 | Not started in Rust |
| Webhook | 368 | ~200 (webhook.rs) | ~70% parity |
| Web API routes | 48 routes | 16 route modules in server | Mixed; some proxy, some have TS logic |

**Total TS to migrate/eliminate:** ~10,760 (core) + 5,398 (plugins) + API route logic = ~18K lines
**Total Rust already done:** ~28K lines across 7 crates (139+ tests, all passing)

## Known Bugs (Fix Before Migration)

These exist in the current Rust code and must be fixed first.

### B1. Board metadata lost on roundtrip
**File:** `crates/conductor-core/src/board.rs`
**Impact:** Cards with `model:gpt-5` or `reasoningEffort:high` metadata lose those fields after board write. Runtime reads metadata, dispatches, writes board back, metadata disappears.
**Fix:** `to_markdown()` must serialize `card.metadata` back into the card line as `key:value` pairs.

### B2. Token double-counting
**File:** `crates/conductor-server/src/state/runtime_status.rs` lines 269-277
**Impact:** `cache_read` and `cache_creation` tokens are subsets of `input_tokens`, not additive. Dashboard shows inflated token counts.
**Fix:**
```rust
usage.total_tokens = Some(input_tokens.unwrap_or(0) + output_tokens.unwrap_or(0));
```

### B3. Duplicated Stdout handling in session_manager.rs
**File:** `crates/conductor-server/src/state/session_manager.rs`
**Impact:** `append_and_apply()` and `apply_runtime_event()` have ~50 lines of near-identical Stdout processing. A bug fix in one path won't reach the other.
**Fix:** Extract shared `apply_stdout_event(session, line, is_live)` method. Call from both paths.

### B4. Spawn queue race condition
**File:** `crates/conductor-server/src/state/spawn_queue.rs`
**Impact:** Board-triggered spawns go through `spawn_guard` mutex, but supervisor queue drain does not. Simultaneous session completions can kick multiple supervisor runs, potentially over-spawning.
**Fix:** Dedup check before processing: verify no active session exists for the same card title + project. Use a single lock acquisition for check-and-spawn.

### B5. Session load startup race
**File:** `crates/conductor-server/src/state/session_store.rs`
**Impact:** `load_sessions_from_disk()` may replace rather than merge with in-memory state if called concurrently.
**Fix:** Change to merge semantics: `guard.extend(loaded)` instead of `*guard = loaded`.

### B6. Codex full-file JSONL scan
**File:** `crates/conductor-server/src/state/runtime_status.rs`
**Impact:** Reads entire Codex JSONL file. Large sessions = slow status reads.
**Fix:** Use tail-based approach (last 256KB) like the Claude Code path. Reuse existing `read_file_tail()` helper.

---

## Migration Phases

### Phase 0: Fix Bugs (Day 1-2)

Fix all 6 bugs listed above. Each fix gets its own commit. Run full test suite after each.

Priority order: B1 (data loss) > B3 (code quality) > B2 (display) > B4 (race) > B5 (race) > B6 (perf).

---

### Phase 1: Consolidate Rust Types (Days 3-4)

Two type systems exist: `conductor-core/types.rs` (AgentKind, Priority, etc.) and `conductor-server/state/types.rs` (SessionRecord, SpawnRequest, SessionStatus, etc.). This is the root cause of stringly-typed session status.

#### 1.1 Unify type definitions in conductor-core
Move `SessionRecord`, `SpawnRequest`, `ConversationEntry`, `LiveSessionHandle` from `conductor-server/state/types.rs` to `conductor-core/src/types.rs`. The server crate imports from core, not the other way around.

#### 1.2 Replace stringly-typed SessionStatus with enum
Create:
```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Queued, Spawning, Working, Idle, NeedsInput, Stuck,
    Errored, Killed, Completed, Restored, Archived,
}
```
Replace all 50+ string comparisons (`session.status == "working"`, etc.) across `session_manager.rs`, `spawn_queue.rs`, `runtime.rs`, `helpers.rs`, and route handlers.

#### 1.3 Externalize model catalog
Create `data/models.json`. Extract the hardcoded model catalog from `types.ts` (lines 315-580). Both Rust and TS read from this single file.

```json
{
  "id": "claude-sonnet-4-6",
  "provider": "anthropic",
  "displayName": "Claude Sonnet 4.6",
  "contextWindow": 200000,
  "maxOutput": 16384,
  "supportsStreaming": true,
  "tier": "pro"
}
```

#### 1.4 Add proper error types
Create `crates/conductor-core/src/error.rs` with `ConductorError` enum using `thiserror`. Replace `anyhow::bail!()` calls in session_manager with typed errors where the caller needs to distinguish error kinds.

---

### Phase 2: Complete Remaining Rust Core (Days 5-6)

Only modules that are genuinely missing. Config sync and board watcher are already done; this phase fills the actual gaps.

#### 2.1 Complete board watcher
**Already done:** Filesystem watching, debouncing, content hashing, event emission.
**Still needed:** Write guard (15s window, detect own writes to avoid re-triggering), AI enhancement dispatch for Inbox cards.
**Extend:** `crates/conductor-watcher/src/lib.rs` and `crates/conductor-server/src/runtime.rs`.

#### 2.2 Port prompt builder
**From:** `packages/core/src/prompt-builder.ts` (246 lines)
**To:** `crates/conductor-executors/src/prompt.rs`

Build the full prompt sent to agents: base system instructions (autonomous operation, git workflow, PR best practices), project context (@imports, CLAUDE.md), task title/description, agent-specific formatting.

#### 2.3 Port scaffold
**From:** `packages/core/src/scaffold.ts` (258 lines)
**To:** `crates/conductor-core/src/scaffold.rs`

Generate initial `conductor.yaml` and project structure for `conductor init`. Detect git repos, suggest project configs.

#### 2.4 Port remaining paths/metadata utilities
**From:** `packages/core/src/metadata.ts` + `paths.ts` (~400 lines combined)
**To:** Extend `crates/conductor-core/src/workspace.rs`

Centralize path resolution that isn't already covered: session artifact dirs, log file locations, board file fallback chains.

---

### Phase 3: Complete Rust Plugins (Days 7-9)

5 remaining TS-only plugins. Ordered by complexity.

#### 3.1 Port terminal web bridge (64 lines)
**To:** `crates/conductor-server/src/routes/terminal.rs`
WebSocket bridge using `axum::extract::ws` for live terminal output in the dashboard. **Note:** Must handle multiplexing tmux PTY output to multiple dashboard clients. This is harder than the line count suggests.

#### 3.2 Port desktop notifier (122 lines)
**To:** `crates/conductor-server/src/notifier/desktop.rs`
Use `notify-rust` crate. Trigger on: session completed, session errored, session needs input.

#### 3.3 Port GitHub tracker (171 lines)
**To:** Extend `crates/conductor-server/src/routes/github.rs`
PR status tracking, CI check monitoring, merge state. This also absorbs the PR tracking/CI monitoring portion of the TS lifecycle manager that wasn't ported in Phase 2.

#### 3.4 Port Discord notifier (200 lines)
**To:** `crates/conductor-server/src/notifier/discord.rs`
Webhook POST with embeds for session events.

#### 3.5 Port MCP server (424 lines)
**To:** `crates/conductor-server/src/mcp.rs`
Expose Conductor capabilities as MCP tools: list sessions, check project status, create board tasks, report completion. Most complex remaining plugin.

---

### Phase 4: Integration Tests (Days 10-11)

Write tests BEFORE deleting TS. This is the safety net.

#### 4.1 Add conductor-db tests
Create `crates/conductor-db/src/repo/tests.rs`:
- Session CRUD (create, read, update state, terminate, list active, list filtered)
- Project CRUD (upsert, get, list, delete)
- Task CRUD (create, get, list filtered, update state, count by state)
- Migration idempotency (run migrations twice)
- Concurrent read/write
- Edge cases: empty strings, Unicode, very long values

#### 4.2 Add integration tests
Create `crates/conductor-server/tests/integration/`:
- `spawn_test.rs`: Full spawn-to-complete lifecycle
- `board_test.rs`: Board change triggers dispatch, metadata preserved through roundtrip
- `session_test.rs`: Session state machine transitions, resume, kill, archive, restore
- `api_test.rs`: HTTP endpoint smoke tests for all 16 route modules

#### 4.3 Add executor tests
Test CLI argument generation for all 10 agent executors. Test `BLOCKED_EXTRA_ARGS` filtering. Test output parsing for each agent's format.

---

### Phase 5: Dashboard API Consolidation (Days 12-13)

Make Next.js a pure frontend. ALL business logic moves to Rust.

#### 5.1 Audit and classify all 48 API routes
Go through every file in `packages/web/src/app/api/`. Classify as:
- **Pure proxy** (just forwards to Rust backend): no changes needed
- **Has TS logic** (computation, validation, data transforms): must migrate logic to Rust

#### 5.2 Create proxy utility
```typescript
// packages/web/src/lib/backend-proxy.ts
export async function proxyToBackend(req: Request, path: string): Promise<Response> {
  const backendUrl = `http://127.0.0.1:${process.env.CONDUCTOR_BACKEND_PORT}${path}`;
  return fetch(backendUrl, { method: req.method, headers: req.headers, body: req.body });
}
```

#### 5.3 Migrate route logic
For each route with TS logic: add equivalent Rust endpoint, replace TS route with proxy call, add tests, remove dead imports.

#### 5.4 SSE migration
Dashboard uses server-sent events for real-time session updates. The Rust server already has `event_snapshots` broadcast channel and `output_updates` channel. Verify the Next.js SSE routes are pure proxies to the Rust SSE endpoints. If any TS-side event transformation exists, move it to Rust.

---

### Phase 6: CLI Migration (Day 14)

#### 6.1 Audit CLI commands
17 commands in `packages/cli/src/commands/`. Most should POST/GET to the Rust backend API.

**Keep as thin TS wrappers:**
- `attach.ts` (tmux attach, no backend logic)
- `dashboard.ts` (opens browser URL)
- `feedback.ts` (simple send)

**Migrate to backend API calls:**
- `start.ts`, `spawn.ts`, `task.ts`, `list.ts`, `kill.ts`, `send.ts`, `status.ts`, `retry.ts`, `restore.ts`, `cleanup.ts`, `setup.ts`, `doctor.ts`

**Delegate to Rust binary:**
- `init.ts` (uses scaffold)
- `mcp-server.ts`

#### 6.2 Thin CLI wrapper pattern
CLI starts Rust backend if not running, calls backend API, formats and displays response. No business logic in TS.

---

### Phase 7: Delete TS Core (Day 15)

Only after all integration tests pass and dashboard is verified working.

#### 7.1 Remove packages/core/src/ files
Delete in dependency order (leaves first):
1. `utils.ts`, `metadata.ts`, `paths.ts`
2. `scaffold.ts`, `config-sync.ts`
3. `prompt-builder.ts`, `agent-names.ts`
4. `spawn-limiter.ts`, `event-bus.ts`
5. `board-diagnostics.ts`, `board-watcher.ts`, `board-parser.ts`
6. `lifecycle-manager.ts`, `plugin-registry.ts`
7. `session-manager.ts`
8. `config.ts`
9. `types.ts` (last; everything depends on it)
10. `index.ts` (re-export only what dashboard needs)

#### 7.2 Remove TS plugin implementations
Delete TS plugin files that have Rust equivalents. Keep only TypeScript type definitions the web dashboard imports.

#### 7.3 Clean up package.json
Remove unused dependencies from `packages/core/package.json`: board parsing libs, YAML parsing, file watching libs, anything only used by migrated code.

---

### Phase 8: Security and Polish (Days 16-17)

#### 8.1 Require webhook secret
Error on startup when webhook is enabled without a secret configured.

#### 8.2 Fix filesystem path traversal
Add symlink resolution check in `allowed_browse_roots()`. After canonicalizing, verify the resolved path is still within allowed roots.

#### 8.3 Standardize API errors
Create `ApiError` struct in Rust with `error`, `code`, `detail` fields. Use across all routes. Replace ad-hoc error strings.

#### 8.4 Add graceful shutdown
Register SIGTERM handler:
1. Stop accepting new spawns
2. Wait for in-progress spawns (30s timeout)
3. Persist all sessions
4. Exit 0

#### 8.5 Enforce session timeouts
In the lifecycle/supervision loop, check `session_timeout_secs` and kill sessions that exceed it. Currently the field exists in config but is partially enforced (only via the output consumer timeout, not for detached/tmux sessions).

---

## Verification Checklist

After each phase:
- [ ] All existing tests pass (`cargo test` + `pnpm test`)
- [ ] Dashboard loads and shows sessions correctly
- [ ] Can spawn a new session via dashboard
- [ ] Can spawn a new session via CLI
- [ ] Board watcher detects changes and dispatches
- [ ] Board metadata survives roundtrip (model, reasoningEffort)
- [ ] Session status updates in real-time (SSE)
- [ ] Completed sessions show diffs
- [ ] Kill/archive/restore work
- [ ] Config changes hot-reload
- [ ] Token counts are accurate

## Estimated Timeline

| Phase | Days | Description |
|-------|------|-------------|
| 0 | 2 | Fix 6 known bugs |
| 1 | 2 | Consolidate Rust types, replace stringly-typed status |
| 2 | 2 | Complete remaining Rust core (prompt builder, scaffold, paths) |
| 3 | 3 | Complete Rust plugins (MCP, notifiers, tracker, terminal) |
| 4 | 2 | Integration tests (safety net before TS deletion) |
| 5 | 2 | Dashboard API consolidation |
| 6 | 1 | CLI migration |
| 7 | 1 | Delete TS core |
| 8 | 2 | Security and polish |
| **Total** | **17 days** | |

## Risk Mitigation

1. **Feature branch.** All migration work on `rust-migration` branch. Main stays stable.
2. **Phase gates.** Don't start Phase N+1 until Phase N passes all verification checks.
3. **Parallel testing.** Keep TS code running alongside Rust until each module is verified. Only delete after confirmation.
4. **Rollback plan.** If any phase breaks the dashboard, revert and investigate.
5. **Integration tests before deletion.** Phase 4 (tests) is explicitly before Phase 7 (delete TS). No deleting without a safety net.

## Files to Delete After Migration

```
packages/core/src/board-parser.ts
packages/core/src/board-watcher.ts
packages/core/src/board-diagnostics.ts
packages/core/src/config.ts
packages/core/src/config-sync.ts
packages/core/src/event-bus.ts
packages/core/src/lifecycle-manager.ts
packages/core/src/metadata.ts
packages/core/src/paths.ts
packages/core/src/plugin-registry.ts
packages/core/src/prompt-builder.ts
packages/core/src/scaffold.ts
packages/core/src/session-manager.ts
packages/core/src/spawn-limiter.ts
packages/core/src/utils.ts
packages/core/src/agent-names.ts
packages/core/src/webhook-emitter.ts
packages/plugins/agent-*/src/index.ts (logic only; keep type exports)
packages/plugins/mcp-server/src/index.ts
packages/plugins/notifier-desktop/src/index.ts
packages/plugins/notifier-discord/src/index.ts
packages/plugins/tracker-github/src/index.ts
packages/plugins/terminal-web/src/index.ts
packages/plugins/runtime-tmux/src/index.ts
packages/plugins/workspace-worktree/src/index.ts
packages/plugins/scm-github/src/index.ts
packages/plugins/webhook/src/index.ts
```

## Success Criteria

- [ ] Zero TypeScript business logic remaining (only UI components and thin API proxies)
- [ ] All 139+ existing Rust tests passing
- [ ] 20+ new conductor-db tests
- [ ] 10+ integration tests covering spawn-to-complete lifecycle
- [ ] Board metadata roundtrip works (model, reasoningEffort preserved)
- [ ] Token counting is accurate (no double-counting cache tokens)
- [ ] SessionStatus is enum, not string, everywhere in Rust
- [ ] No spawn race conditions
- [ ] Session timeouts enforced for all runtime modes
- [ ] Graceful shutdown works
- [ ] Model catalog externalized to JSON
- [ ] All API errors use standard format
- [ ] SSE real-time updates work through pure proxy
- [ ] README updated with new architecture
