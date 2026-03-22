# CLAUDE.md

> Context file for AI coding agents working on Conductor OSS.

## What is Conductor OSS

Conductor is a local-first AI agent orchestrator. It turns Markdown kanban boards into dispatched coding tasks, runs them via agent CLIs (Claude Code, Codex, Gemini, etc.) in isolated worktrees, and streams results through a dashboard.

**One command. Markdown-native. Local-first by default.**

## Architecture

### Stack

- **Backend:** Rust (axum, tokio, sqlx/SQLite). Repo dev scripts use port 4749; the launcher defaults to 4748.
- **Dashboard:** Next.js (packages/web). Repo dev scripts use port 3000; the launcher defaults to 4747.
- **CLI:** Node.js launcher + Rust native binary
- **Runtime:** ttyd-first PTY-based session management
- **Persistence:** SQLite in `.conductor/conductor.db` + Markdown files
- **Bridge/Access:** optional relay, paired-device bridge, and dashboard access-control flows in the same repo

### Rust Crates

| Crate | Purpose |
|-------|---------|
| `conductor-core` | Types, board parsing, config, task/session models, dispatcher |
| `conductor-server` | Axum HTTP server, routes, state management, SSE streaming |
| `conductor-db` | SQLite persistence via sqlx, migrations |
| `conductor-executors` | Agent adapters, process management, prompt delivery |
| `conductor-git` | Git/worktree operations |
| `conductor-relay` | Relay server for bridge and remote terminal flows |
| `conductor-types` | Shared bridge and transport protocol types |
| `conductor-watcher` | File system watching (board changes) |
| `conductor-cli` | Rust CLI binary |
| `notify-rust` | Desktop notification support |

### TypeScript Packages

| Package | Purpose |
|---------|---------|
| `packages/cli` | npm CLI entrypoint, native binary launcher |
| `packages/core` | Shared TS types and schemas |
| `packages/web` | Next.js 16 dashboard UI, bridge onboarding, and access controls |

### Key Server Files

- `crates/conductor-server/src/routes/` - route handlers (sessions, tasks, boards, github, terminal, attachments, access, notifications, etc.)
- `crates/conductor-server/src/state/session_manager.rs` - Core session lifecycle
- `crates/conductor-server/src/state/detached/` - detached runtime coordination, ttyd launcher, and PTY streaming
- `crates/conductor-server/src/runtime.rs` - Runtime coordination
- `crates/conductor-executors/src/agents/` - agent adapters
- `crates/conductor-relay/src/` - relay and bridge transport server
- `bridge-cmd/` - companion bridge binary used by pairing flows

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
# or: cargo run --bin conductor -- start --port 4747

# Dashboard only
bun run dev

# Build everything
bun run build

# Tests
cargo test --workspace          # Rust workspace
bun run --cwd packages/core test  # TS core

# Type check
bun run typecheck
```

### Default Ports

- `bun run dev:full`: dashboard `http://localhost:3000`, backend `http://127.0.0.1:4749`
- `co start`: dashboard `http://127.0.0.1:4747`, backend `http://127.0.0.1:4748` unless config overrides it
- Native `cargo run --bin conductor -- start`: backend `http://127.0.0.1:4747` unless `--port` is set

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
4. Executor launches a ttyd-backed PTY session and streams the native agent terminal
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

### Access Control

The dashboard can stay local-only, validate Cloudflare Access JWT headers, or enable optional Clerk-hosted sign-in flows. Public share-link remote control was removed.

## What NOT to Do

- Do not change `SessionStatus` from enum back to strings
- Do not turn bridge or access-control features into hosted state or credential proxying
- Do not use `pnpm` (project uses `bun`)
- Do not add default exports in library TypeScript code
- Do not bypass the write guard for board file operations
- Do not hardcode paths; use the config/paths modules
