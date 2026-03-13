# CLAUDE.md

> Context file for AI coding agents working on Conductor OSS.

## What is Conductor OSS

Conductor is a local-first AI agent orchestrator. It turns Markdown kanban boards into dispatched coding tasks, runs them via agent CLIs (Claude Code, Codex, Gemini, etc.) in isolated worktrees, and streams results through a dashboard.

**One command, no cloud relay, no credential proxying.**

## Architecture

### Stack

- **Backend:** Rust (axum, tokio, sqlx/SQLite) at port 4749
- **Dashboard:** Next.js (packages/web) at port 3000/4747
- **CLI:** Node.js launcher + Rust native binary
- **Runtime:** direct PTY-based session management
- **Persistence:** SQLite in `.conductor/conductor.db` + Markdown files

### Rust Crates (37K+ lines)

| Crate | Purpose |
|-------|---------|
| `conductor-core` | Types, board parsing, config, task/session models, dispatcher |
| `conductor-server` | Axum HTTP server, routes, state management, SSE streaming |
| `conductor-db` | SQLite persistence via sqlx, migrations |
| `conductor-executors` | Agent adapters, process management, prompt delivery |
| `conductor-git` | Git/worktree operations |
| `conductor-watcher` | File system watching (board changes) |
| `conductor-cli` | Rust CLI binary |
| `notify-rust` | Desktop notification support |

### TypeScript Packages

| Package | Purpose |
|---------|---------|
| `packages/cli` | npm CLI entrypoint, native binary launcher |
| `packages/core` | Shared config types, board parsing (being superseded by Rust) |
| `packages/web` | Next.js 16 dashboard UI |

### Key Server Files

- `crates/conductor-server/src/routes/` - 22 route modules (sessions, tasks, boards, github, terminal, etc.)
- `crates/conductor-server/src/state/session_manager.rs` - Core session lifecycle
- `crates/conductor-server/src/state/detached_runtime.rs` - direct PTY runtime and streaming
- `crates/conductor-server/src/runtime.rs` - Runtime coordination
- `crates/conductor-executors/src/agents/` - 10 agent adapters

### Supported Agents

Claude Code, Codex, Gemini, Qwen Code, Amp, Cursor Agent, OpenCode, Droid, GitHub Copilot, CCR

Each adapter in `crates/conductor-executors/src/agents/` defines launch commands, process detection, and prompt delivery methods.

## Development

### Prerequisites

- Rust toolchain (stable)
- Bun >= 1.2
- Node.js >= 18
- git

### Commands

```bash
# Full dev (dashboard + backend)
bun run dev:full

# Backend only
bun run dev:backend
# or: cargo run --bin conductor-server

# Dashboard only
bun run dev

# Build everything
bun run build

# Tests
cargo test --workspace          # Rust (155+ tests)
bun run --cwd packages/core test  # TS core

# Type check
bun run typecheck
```

### Default Ports

- Dashboard: `http://localhost:3000` (dev) or `http://localhost:4747` (prod)
- Rust backend: `http://127.0.0.1:4749`

## Code Conventions

### Rust

- Use `thiserror` for error types, `anyhow` for ad-hoc errors in binaries
- Prefer `Arc<RwLock<T>>` for shared state, `DashMap` where contention matters
- All API routes return `Result<Json<T>, ApiError>`
- SSE endpoints use `axum::response::Sse` with `tokio_stream`
- SQLite queries use sqlx with compile-time checked macros where possible
- `SessionStatus` is an enum, not a string
- Types are consolidated in `conductor-core` (single source of truth)

### TypeScript

- ESM only, no default exports in library code
- Bun as package manager and runtime
- Next.js 16 for dashboard with App Router

### Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`

### PR Requirements

- Every PR needs `## Type of Change` checkboxes
- Every PR needs `## User-Facing Release Notes` bullets (or `N/A - internal maintenance only`)
- CI enforced: `cargo test`, `cargo clippy`, build checks
- Greptile auto-reviews all PRs

## Data Flow

1. User creates/moves task on Kanban board (`CONDUCTOR.md`)
2. File watcher detects change, parses board
3. Dispatcher picks up "Ready to Dispatch" tasks
4. Executor launches a direct PTY session and streams the native agent terminal
5. Session manager tracks lifecycle (spawn, running, complete, failed)
6. Dashboard streams updates via SSE
7. On completion: diff captured, task moved to Done

## Configuration

- `conductor.yaml` - Workspace config, project definitions, preferences
- `CONDUCTOR.md` - Kanban board (Obsidian-compatible)
- `.conductor/conductor.db` - SQLite state

## Important Patterns

### Content-Aware Write Guard

Conductor has a 15-second write guard to prevent race conditions between the file watcher and Obsidian Kanban plugin when both try to write `CONDUCTOR.md`.

### Worktree Isolation

When `workspace: worktree` is set for a project, each session gets its own git worktree so multiple agents can work on the same repo without conflicts.

### Session Lifecycle

Tasks flow: `Inbox` -> AI enhance (auto-tag) -> `Ready to Dispatch` -> `Dispatching` -> `In Progress` -> `Review` -> `Done`

### SSE Streaming

The dashboard uses Server-Sent Events for real-time updates. In standalone/production mode, SSE uses direct fetch-and-pipe handlers (not Next.js blob buffering) to avoid buffering issues.

## What NOT to Do

- Do not change `SessionStatus` from enum back to strings
- Do not add cloud relay or credential proxying (local-first is a core principle)
- Do not use `pnpm` (project uses `bun`)
- Do not add default exports in library TypeScript code
- Do not bypass the write guard for board file operations
- Do not hardcode paths; use the config/paths modules
