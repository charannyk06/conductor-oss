# Contributing to Conductor OSS

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/charannyk06/conductor-oss.git
cd conductor-oss
bun install
cargo build --workspace
```

### Prerequisites

- Rust toolchain (stable)
- Bun >= 1.2
- Node.js >= 18
- git

### Running locally

```bash
# Full stack (dashboard + Rust backend)
bun run dev:full

# Backend only
bun run dev:backend

# Dashboard only
bun run dev

# Run Rust tests
cargo test --workspace

# Run TS tests
bun run --cwd packages/core test

# Type check
bun run typecheck

# Lint Rust
cargo clippy --workspace
```

### Default ports

- Source dev scripts: dashboard `http://localhost:3000`, Rust backend `http://127.0.0.1:4749`
- Launcher defaults: dashboard `http://127.0.0.1:4747`, Rust backend `http://127.0.0.1:4748`
- `co start` forwards the Rust backend URL into the dashboard automatically through `CONDUCTOR_BACKEND_URL` and `NEXT_PUBLIC_CONDUCTOR_BACKEND_URL`.
- If you run the dashboard by itself, set `CONDUCTOR_BACKEND_URL` or `NEXT_PUBLIC_CONDUCTOR_BACKEND_URL` so proxy routes such as skills and previews can reach the backend.

## Project Structure

```text
bridge-cmd/                  # Companion bridge binary used by paired-device flows
crates/                      # Rust workspace
  conductor-core/            # Types, config, board parsing, task/session models
  conductor-server/          # Axum HTTP server, routes, state, SSE streaming
  conductor-db/              # SQLite persistence via sqlx
  conductor-executors/       # Agent adapters, process management
  conductor-git/             # Git/worktree operations
  conductor-relay/           # Relay server for bridge and remote terminal flows
  conductor-types/           # Shared bridge/transport protocol types
  conductor-watcher/         # File system watching
  conductor-cli/             # Rust CLI binary
  notify-rust/               # Desktop notification support
packages/                    # TypeScript
  cli/                       # npm CLI entrypoint, native binary launcher
  core/                      # Shared TS types and schemas
  web/                       # Next.js 16 dashboard
.github/workflows/           # CI, release, security, docs sync
```

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `cargo test --workspace && cargo clippy --workspace` for Rust changes
4. Run `bun run typecheck` for TypeScript changes
5. Open a pull request against `main`

### PR Requirements

Every PR must include:

- `## Type of Change` section with checkboxes (bug fix, feature, breaking change, etc.)
- `## User-Facing Release Notes` with 1-3 plain-English bullets, or `N/A - internal maintenance only`

CI enforces these sections.

### Commit messages

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation changes
- `chore:` maintenance, CI, tooling
- `refactor:` code restructuring without behavior change

### What we look for in PRs

- Rust tests pass (`cargo test --workspace`)
- No clippy warnings (`cargo clippy --workspace`)
- Types check for TS changes (`bun run typecheck`)
- Build succeeds (`bun run build`)
- Code follows existing patterns
- Greptile AI review passes without critical issues

## Adding a New Agent Adapter

Agent adapters live in `crates/conductor-executors/src/agents/`. See `claude_code.rs` for the reference implementation.

Each adapter defines:
- Launch command and arguments
- Process name for detection
- Prompt delivery method
- Optional setup/validation logic

The dashboard Skills tab uses the same agent catalog to install official skill bundles into the correct user/workspace roots for each supported agent.

Register new adapters in `crates/conductor-executors/src/agents/mod.rs` and add discovery in `crates/conductor-executors/src/discovery.rs`.

## Adding a New API Route

1. Create handler in `crates/conductor-server/src/routes/<name>.rs`
2. Register in `crates/conductor-server/src/routes/mod.rs`
3. Add to the router in `crates/conductor-server/src/lib.rs`

## Releases

Releases are triggered manually via the **Release** GitHub Action (`workflow_dispatch`). This:
1. Bumps versions across all packages
2. Builds and tests (Rust + TypeScript)
3. Creates GitHub release notes from merged PRs' `User-Facing Release Notes` sections
4. Publishes to npm with provenance (includes platform-native Rust binaries)

## Code of Conduct

Be respectful. We're building tools for developers, by developers.

## License

By contributing, you agree that your contributions will be licensed under the project's MIT license.
