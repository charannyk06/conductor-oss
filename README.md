<div align="center">

# Conductor OSS

### The local-first control plane for AI coding agents

**One command. Markdown-native. No cloud relay.**

[![npm version](https://img.shields.io/npm/v/conductor-oss?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/conductor-oss)
[![CI](https://img.shields.io/github/actions/workflow/status/charannyk06/conductor-oss/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Rust Backend](https://img.shields.io/badge/rust-local_backend-ce422b?style=flat-square)](https://www.rust-lang.org)
[![GitHub Stars](https://img.shields.io/github/stars/charannyk06/conductor-oss?style=flat-square&color=facc15)](https://github.com/charannyk06/conductor-oss/stargazers)

</div>

---

Conductor OSS is a local-first orchestration platform for AI coding agents. It takes Markdown kanban boards, turns them into dispatchable work, and launches your installed coding CLIs — Claude Code, Codex, Gemini, and seven others — inside isolated git worktrees with full terminal access from a browser dashboard.

Everything runs on your machine. State lives in local files and SQLite. Agents keep their own authentication and billing. Conductor is the operating layer around them, not a replacement.

## Why Conductor

Running one agent in one terminal works fine for a single task. When you want to queue multiple tasks across multiple repos, dispatch them to different agents, watch them run in parallel, retry failures, review diffs, and coordinate it all from one place — you need an orchestration layer.

Conductor adds:

- **Planning** — Markdown kanban boards that work in Obsidian and in the browser
- **Dispatch** — Automated task-to-agent assignment with queue management
- **Isolation** — Git worktree-per-session so agents never step on each other
- **Visibility** — Live terminal streaming, session feeds, and diff inspection
- **Recovery** — Session restore after backend restarts, retries, and feedback loops
- **Review** — PR creation, CI check monitoring, and code diff tools built in

## Quick Start

### Requirements

- Node.js `>= 18`
- `git`
- At least one supported coding agent CLI installed and authenticated

### Launch

```bash
npx conductor-oss@latest
```

This starts the Rust backend and Next.js dashboard, then opens the browser. Default ports:

- Dashboard: `http://127.0.0.1:4747`
- Backend: `http://127.0.0.1:4749`

### Initialize an existing repo

```bash
npx conductor-oss@latest init
npx conductor-oss@latest start --workspace .
```

This scaffolds `conductor.yaml`, `CONDUCTOR.md`, and `.conductor/conductor.db` in the current directory.

### Global install

```bash
npm install -g conductor-oss
co
```

The launcher registers three aliases: `conductor-oss`, `conductor`, and `co`.

## Supported Agents

Conductor ships with adapters for 10 coding agent CLIs. Each adapter handles binary detection, launch commands, process monitoring, and prompt delivery.

| Agent | CLI |
|-------|-----|
| Claude Code | `claude` |
| Codex | `codex` |
| Gemini | `gemini` |
| Qwen Code | `qwen` |
| Amp | `amp` |
| Cursor Agent | `cursor-agent` |
| OpenCode | `opencode` |
| Droid | `droid` |
| GitHub Copilot | `gh copilot` |
| CCR | `ccr` |

Agents appear in the dashboard picker based on what is installed and authenticated on your machine.

## Native Terminal Experience

Conductor launches agents into their real terminal UIs — not a synthetic chat shell. Claude Code runs as Claude Code. Codex runs as Codex. Interactive sessions are now `ttyd`-first: each live agent gets a real ttyd-backed PTY, the dashboard connects either straight to that loopback ttyd socket on local desktops or through Conductor's authenticated websocket relay on remote/private paths, and reconnecting still preserves the native agent experience.

<div align="center">

| Agent Picker | Claude Code Session |
|:---:|:---:|
| ![Agent picker](docs/screenshots/launch-agent-picker.png) | ![Claude Code terminal](docs/screenshots/launch-claude-native.png) |

| Codex Session | Gemini Session |
|:---:|:---:|
| ![Codex terminal](docs/screenshots/launch-codex-native.png) | ![Gemini terminal](docs/screenshots/launch-gemini-native.png) |

</div>

## How It Works

### Task Lifecycle

```
Inbox → Ready to Dispatch → Dispatching → In Progress → Review → Done
```

1. **Create tasks** in `CONDUCTOR.md` — a Markdown kanban board compatible with Obsidian
2. **Move tasks** to "Ready to Dispatch" (or let the automation promote them)
3. **Conductor dispatches** — picks up queued tasks, selects an agent, prepares the workspace
4. **Agent executes** — launched in an isolated git worktree with a compiled task prompt
5. **Monitor live** — terminal streaming, normalized session feed, and runtime metadata in the dashboard
6. **Review output** — inspect diffs, browse changed files, view CI checks, create PRs
7. **Iterate** — retry, restore, send feedback, or archive

### Dashboard Surfaces

Each session page provides:

- **Terminal** — live interactive terminal over the agent's PTY session
- **Overview** — normalized conversation feed, runtime state, metadata, and recovery actions
- **Preview** — connect a local dev URL and interact with the running app
- **Diff** — file-level change inspection and workspace file browser

<div align="center">

| Dashboard Overview | Session Detail |
|:---:|:---:|
| ![Dashboard](docs/screenshots/01-dashboard-overview.png) | ![Session](docs/screenshots/07-session-detail.png) |

</div>

## CLI Reference

The npm launcher (`co`) is the primary CLI. Run `co --help` for the full command list.

| Command | Description |
|---------|-------------|
| `co start` | Start the backend and dashboard |
| `co init` | Scaffold `conductor.yaml` and `CONDUCTOR.md` |
| `co setup` | Guided first-run configuration |
| `co doctor` | Diagnose backend and runtime issues |
| `co spawn` | Create a new session |
| `co list` | List all sessions |
| `co status` | Summarize workspace and session state |
| `co send` | Send a follow-up message to a running session |
| `co feedback` | Send reviewer feedback into a session |
| `co retry` | Create a new attempt from a prior task or session |
| `co restore` | Restore an exited session |
| `co kill` | Terminate a session |
| `co cleanup` | Reclaim resources from completed sessions |
| `co dashboard` | Open the dashboard in a browser |
| `co mcp-server` | Run Conductor as an MCP server over stdio |

A lower-level Rust CLI also exists in `crates/conductor-cli` for direct backend interaction during development.

## Configuration

Conductor uses three local files:

| File | Purpose |
|------|---------|
| `conductor.yaml` | Workspace config, project definitions, agent defaults, runtime preferences |
| `CONDUCTOR.md` | Markdown kanban board for planning and dispatch |
| `.conductor/conductor.db` | SQLite database for sessions, metadata, and runtime state |

Additional runtime artifacts:

- `.conductor/rust-backend/detached/` — PTY session data for terminal restore
- `attachments/` — Uploaded files and generated session artifacts

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   npm launcher   │    │  Next.js 16 UI   │    │  Rust backend   │
│  packages/cli    │    │  packages/web    │    │  conductor-     │
│                  │    │                  │    │  server         │
│  start, spawn,   │───▶│  Dashboard,      │◀──▶│  HTTP + SSE +   │
│  init, doctor    │    │  Terminal,       │    │  WebSocket      │
│                  │    │  Diff, Preview   │    │                 │
└─────────────────┘    └──────────────────┘    └────────┬────────┘
                                                        │
                    ┌───────────────────────────────────┤
                    │                                   │
          ┌────────▼────────┐               ┌──────────▼──────────┐
          │  conductor-core  │               │ conductor-executors  │
          │  Types, config,  │               │ 10 agent adapters,   │
          │  board parsing   │               │ process management   │
          └─────────────────┘               └──────────────────────┘
                    │                                   │
          ┌────────▼────────┐               ┌──────────▼──────────┐
          │  conductor-db    │               │  conductor-git       │
          │  SQLite via sqlx │               │  Worktree isolation  │
          └─────────────────┘               └──────────────────────┘
```

### Rust Crates

| Crate | Purpose |
|-------|---------|
| `conductor-server` | Axum HTTP server — 22 route modules, session manager, PTY runtime, SSE streaming |
| `conductor-core` | Shared types, board parser, configuration, task and session models |
| `conductor-executors` | 10 agent adapters — binary detection, launch commands, prompt delivery |
| `conductor-db` | SQLite persistence via sqlx with compile-time checked queries |
| `conductor-git` | Git operations and worktree lifecycle management |
| `conductor-watcher` | Filesystem watcher for `CONDUCTOR.md` changes |
| `conductor-cli` | Low-level Rust CLI binary |

### TypeScript Packages

| Package | Purpose |
|---------|---------|
| `packages/cli` | npm launcher — user-facing CLI, binary management, process orchestration |
| `packages/web` | Next.js 16 dashboard — session UI, terminal viewer, board editor, diff tools |
| `packages/core` | Shared TypeScript types and Zod schemas |

### Key Design Decisions

- **Local-first** — no cloud relay, no credential proxying, all state on disk
- **SQLite-only** — single-file database, no external DB dependency
- **TTyd-backed PTY** — shell-backed sessions via real `ttyd`, not synthetic chat shells
- **Agent-agnostic** — Conductor orchestrates; each agent keeps its own auth and billing
- **Markdown-native** — boards live in `CONDUCTOR.md`, readable in any editor or Obsidian
- **Worktree isolation** — each session gets its own git worktree to prevent conflicts
- **TTYD-first streaming** — real `ttyd` sessions with backend-authenticated relay and restore-aware capture

## Develop From Source

### Prerequisites

- Rust stable toolchain
- Bun `>= 1.2`
- Node.js `>= 18`
- `git`

### Setup

```bash
bun install
```

### Commands

```bash
bun run dev:full     # Dashboard (port 3000) + Rust backend (port 4749)
bun run dev          # Dashboard only
bun run dev:backend  # Backend only (or: cargo run --bin conductor-server)
bun run build        # Full production build
bun run typecheck    # TypeScript type checking

cargo test --workspace                   # Rust tests
cargo clippy --workspace -- -D warnings  # Rust linting
```

### Dev Ports

| Service | Port |
|---------|------|
| Dashboard (dev) | `http://localhost:3000` |
| Dashboard (prod) | `http://127.0.0.1:4747` |
| Rust backend | `http://127.0.0.1:4749` |

## Project Structure

```
conductor-oss/
├── crates/
│   ├── conductor-server/       # Axum HTTP server, routes, state, SSE
│   ├── conductor-core/         # Types, config, board parsing
│   ├── conductor-executors/    # Agent adapters (10 agents)
│   ├── conductor-db/           # SQLite persistence
│   ├── conductor-git/          # Git/worktree operations
│   ├── conductor-watcher/      # Filesystem watcher
│   ├── conductor-cli/          # Rust CLI binary
│   └── notify-rust/            # Desktop notifications
├── packages/
│   ├── cli/                    # npm launcher
│   ├── web/                    # Next.js dashboard
│   └── core/                   # Shared TypeScript types
├── docs/
│   ├── screenshots/            # Dashboard and session screenshots
│   ├── demo/                   # Workflow demo videos
│   └── terminal-*.md           # Terminal protocol and QA docs
├── .github/workflows/          # CI, release, security, PR checks
├── Cargo.toml                  # Rust workspace
├── package.json                # Bun workspace
├── conductor.yaml              # Workspace config (user-created)
├── CONDUCTOR.md                # Kanban board (user-created)
└── LICENSE                     # MIT
```

## Known Constraints

- Agent output quality depends entirely on the upstream CLI you install — Conductor orchestrates, it does not modify agent behavior
- GitHub-integrated flows (PR creation, check monitoring) work best with `gh` installed and authenticated
- Preview tooling requires a repo that exposes a local dev server URL
- Remote access was intentionally removed — use your own network or proxy layer for remote setups
- Interactive sessions run through ttyd; legacy tmux and legacy direct sessions are compatibility data that should be archived instead of resumed

## Links

- GitHub: <https://github.com/charannyk06/conductor-oss>
- npm: <https://www.npmjs.com/package/conductor-oss>
- Issues: <https://github.com/charannyk06/conductor-oss/issues>
- Pull requests: <https://github.com/charannyk06/conductor-oss/pulls>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=charannyk06/conductor-oss&type=Date)](https://star-history.com/#charannyk06/conductor-oss&Date)

## License

MIT. See [LICENSE](LICENSE).
