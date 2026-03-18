# AGENTS.md

> Instructions for AI agents contributing to Conductor OSS.

## Project Overview

Conductor OSS is a local-first AI agent orchestrator built with Rust + Next.js. It dispatches coding tasks from Markdown kanban boards to agent CLIs, running them in isolated worktrees with live dashboard streaming.

## Before You Start

1. Read `CLAUDE.md` for architecture and conventions
2. Run `cargo test --workspace` to verify the build
3. Check `CONDUCTOR-TAGS.md` for task tagging conventions
4. Branch from `main`, use conventional commit messages

## Code Style

### Rust (primary codebase, 37K+ lines)

- Error handling: `thiserror` for library errors, `anyhow` for binaries
- Async: tokio runtime, axum for HTTP
- Database: sqlx with SQLite, migrations in `conductor-db`
- State: `Arc<RwLock<T>>` or `DashMap` for concurrent access
- Tests: inline `#[cfg(test)]` modules, 155+ tests across crates
- No `unwrap()` in library code; use `?` or explicit error handling

### TypeScript (dashboard + CLI launcher)

- Runtime: Bun >= 1.2
- Framework: Next.js 16, App Router
- No default exports in library code
- ESM only

## PR Checklist

- [ ] `cargo test --workspace` passes
- [ ] `cargo clippy --workspace` has no warnings
- [ ] `bun run typecheck` passes (if TS changes)
- [ ] PR has `## Type of Change` section with checkboxes
- [ ] PR has `## User-Facing Release Notes` with plain-English bullets

## Key Directories

```
crates/
  conductor-core/       # Types, config, board parsing, task models
  conductor-server/     # HTTP server, routes, state, SSE
  conductor-db/         # SQLite persistence
  conductor-executors/  # Agent adapters, process management
  conductor-git/        # Git operations
  conductor-watcher/    # File system watching
  conductor-cli/        # Rust CLI
packages/
  cli/                  # npm CLI launcher
  core/                 # Shared TS types (being superseded by Rust)
  web/                  # Next.js dashboard
```

## Common Tasks

### Adding a new agent adapter

1. Create `crates/conductor-executors/src/agents/<name>.rs`
2. Implement `Executor` trait: `spawn()`, `build_args()`, `kind()`, `binary_path()`
3. Register in `crates/conductor-executors/src/agents/mod.rs`
4. Add discovery logic in `crates/conductor-executors/src/discovery.rs`

### Adding a new API route

1. Create route handler in `crates/conductor-server/src/routes/<name>.rs`
2. Register in `crates/conductor-server/src/routes/mod.rs`
3. Add to router in `crates/conductor-server/src/lib.rs`

### Adding a database migration

1. Add migration SQL in `crates/conductor-db/src/migrations.rs`
2. Bump migration version
3. Test with fresh database

## Architecture Constraints

- **Local-first:** No cloud relay, no credential proxying, no hosted state
- **ttyd-first:** Runtime defaults to ttyd-backed PTY sessions; tmux is legacy compatibility-only
- **SQLite-only:** No external database dependencies
- **Agent-agnostic:** Conductor orchestrates; agents do their own auth and billing
- **Markdown-native:** Board state lives in `CONDUCTOR.md`, readable by humans and Obsidian
