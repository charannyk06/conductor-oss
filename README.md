<div align="center">

# Conductor OSS

### Local-first orchestration for coding-agent CLIs

**One command. Markdown-native. No cloud relay.**

[![npm version](https://img.shields.io/npm/v/conductor-oss?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/conductor-oss)
[![CI](https://img.shields.io/github/actions/workflow/status/charannyk06/conductor-oss/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Rust Backend](https://img.shields.io/badge/rust-local_backend-ce422b?style=flat-square)](https://www.rust-lang.org)
[![GitHub Stars](https://img.shields.io/github/stars/charannyk06/conductor-oss?style=flat-square&color=facc15)](https://github.com/charannyk06/conductor-oss/stargazers)

</div>

Conductor OSS is a local-first control plane for software work driven by AI coding agents.

It turns Markdown kanban boards into dispatchable work, launches installed coding CLIs inside isolated workspaces, persists state in local files plus SQLite, and gives you a browser dashboard for live terminal access, normalized session history, preview, diff review, and recovery workflows.

If you already use tools like Claude Code, Codex, Gemini, Qwen Code, Cursor Agent, Amp, OpenCode, Copilot, or CCR, Conductor is the orchestration layer around them rather than a replacement for them.

## What Conductor Does

- Dispatches tasks from `CONDUCTOR.md` boards into real agent sessions.
- Runs agents locally in the repo or in isolated git worktrees.
- Uses a terminal-first runtime so each session remains an interactive shell-backed workspace.
- Streams session status into a dashboard over SSE and websocket-backed terminal connections.
- Tracks retries, restores, kill/archive flows, session diffs, checks, previews, and feedback loops.
- Stores state locally in `conductor.yaml`, `CONDUCTOR.md`, and `.conductor/conductor.db`.
- Keeps agent authentication and billing with the upstream CLI you already installed.

## Core Workflow

1. Add a local repo or clone one into a managed workspace.
2. Create or edit tasks in `CONDUCTOR.md`.
3. Move a task into `Ready to Dispatch`.
4. Conductor launches the selected agent in an isolated workspace.
5. Follow the session from the browser:
   - `Terminal`: the live terminal is the primary session workspace.
   - `Overview`: normalized feed, runtime state, metadata, and recovery hints.
   - `Preview`: connect a local dev URL and interact with the app from the session page.
   - `Diff`: inspect changed files, workspace contents, and checks.
6. Retry, restore, send feedback, or archive the session when needed.

## Highlights

- Local-first by design: no hosted relay, no repo proxy, no hosted state store.
- Markdown-native planning: boards remain readable outside the app.
- Multi-agent support with adapter-based discovery and launch logic.
- Worktree-aware execution for parallel changes in the same repository.
- Session recovery after backend restarts, including tmux reattach for live runtimes.
- GitHub-aware flows for repository import, PR metadata, checks, and project syncing.
- MCP server mode for integrating Conductor with external clients.

## Supported Agents

Built-in adapters currently exist for:

- Claude Code
- Codex
- Gemini
- Qwen Code
- Amp
- Cursor Agent
- OpenCode
- Droid
- GitHub Copilot
- CCR

Availability still depends on what is installed and authenticated on your machine.

## Quick Start

### Requirements

- Node.js `>= 18`
- `git`
- `tmux`
- at least one supported coding-agent CLI installed and authenticated

### Launch Conductor

```bash
npx conductor-oss@latest
```

The npm launcher defaults to `co start --open`, which starts the local stack and opens the dashboard.

Launcher defaults:

- dashboard: `http://127.0.0.1:4747`
- Rust backend: `http://127.0.0.1:4748`

### Initialize an existing repo

```bash
npx conductor-oss@latest init
npx conductor-oss@latest start --workspace .
```

That scaffolds:

- `conductor.yaml`
- `CONDUCTOR.md`
- `.conductor/conductor.db`

If you prefer a global install:

```bash
npm install -g conductor-oss
co
```

The launcher exposes `conductor-oss`, `conductor`, and `co`.

## CLI Overview

The npm launcher is the main user-facing CLI. Run `co --help` for the full surface.

Common launcher commands:

- `co start` - start the Rust backend and web dashboard
- `co dashboard` - open the dashboard
- `co init` - scaffold `conductor.yaml` and `CONDUCTOR.md`
- `co setup` - guided first-run setup
- `co doctor` - diagnose backend and runtime issues
- `co spawn` - create a session
- `co list` - list sessions
- `co status` - summarize session state
- `co send` - send a follow-up to a session
- `co attach` - attach your terminal to a session's tmux pane
- `co restore` - restore an exited session
- `co retry` - create a new attempt from an earlier task or session
- `co kill` - terminate a session
- `co cleanup` - reclaim resources from completed sessions
- `co feedback` - send reviewer feedback back into a session
- `co task` - task graph helpers
- `co mcp-server` - run Conductor as an MCP server over stdio

There is also a native Rust CLI in `crates/conductor-cli` used by the launcher and source development. Its command set is intentionally smaller and lower-level than the npm launcher.

## Configuration and Local Data

Conductor uses a small set of local files:

- `conductor.yaml`
  Workspace and project configuration, agent defaults, access settings, and runtime preferences.
- `CONDUCTOR.md`
  Markdown kanban board used for planning and dispatch.
- `.conductor/conductor.db`
  SQLite persistence for sessions, metadata, and runtime state.
- `.conductor/rust-backend/tmux/`
  Runtime artifacts for tmux-backed sessions.
- `attachments/...`
  Uploaded session files and generated artifacts.

## Application Surfaces

### Dashboard

The Next.js dashboard is the main UI for:

- project and repository management
- board editing and task comments
- session monitoring
- terminal access
- preview browser controls
- diff and file inspection
- PR and check visibility
- app update notices and runtime health

### Rust Backend

The Rust backend is the orchestration core. It handles:

- session lifecycle and spawn queueing
- executor discovery and agent adapters
- tmux-backed runtime management
- workspace and worktree preparation
- SQLite persistence
- SSE event streaming
- terminal websocket transport
- board automation and filesystem watching
- GitHub and notification integrations

### Terminal-First Sessions

The live terminal is now the primary session workspace. The dashboard still provides a normalized feed and metadata, but interactive work is expected to happen through the terminal surface, not a synthetic chat-only shell.

## Architecture

User-facing stack:

- npm launcher in `packages/cli`
- Next.js dashboard in `packages/web`
- Rust backend in `crates/conductor-server`

Rust workspace crates:

- `crates/conductor-cli`
- `crates/conductor-core`
- `crates/conductor-db`
- `crates/conductor-executors`
- `crates/conductor-git`
- `crates/conductor-server`
- `crates/conductor-watcher`

Key runtime properties:

- local-first
- SQLite-only persistence
- tmux-backed interactive sessions
- agent-agnostic execution
- Markdown-native board state

## Develop From Source

Requirements:

- Bun `>= 1.2`
- Node.js `>= 18`
- Rust toolchain
- `tmux`

Install dependencies:

```bash
bun install
```

Run the full dev stack:

```bash
bun run dev:full
```

Source-dev defaults:

- dashboard: `http://localhost:3000`
- Rust backend: `http://127.0.0.1:4749`

Useful commands:

```bash
bun run dev
bun run dev:backend
bun run dev:full
bun run build
cargo test --workspace
cargo clippy --workspace -- -D warnings
bun run typecheck
```

## Current Constraints

- `tmux` is effectively required for the interactive runtime.
- Agent behavior and output quality depend on the upstream CLI you install.
- GitHub-heavy flows work best with `gh` installed and authenticated.
- Preview tooling is strongest when a repo exposes a local dev server or preview URL.
- Public tunnel-style remote access was removed; protected remote setups should use your own network or proxy layer.

## Why Conductor Exists

Single-agent terminals are useful for one task at a time. Conductor adds the operating layer around them:

- queueing
- planning
- isolation
- visibility
- retries
- recovery
- review
- browser-based coordination

## Links

- GitHub: <https://github.com/charannyk06/conductor-oss>
- npm: <https://www.npmjs.com/package/conductor-oss>
- Issues: <https://github.com/charannyk06/conductor-oss/issues>
- Pull requests: <https://github.com/charannyk06/conductor-oss/pulls>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=charannyk06/conductor-oss&type=Date)](https://star-history.com/#charannyk06/conductor-oss&Date)

## License

MIT. See [LICENSE](LICENSE).
