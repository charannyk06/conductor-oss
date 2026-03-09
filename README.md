<div align="center">

# Conductor OSS

### AI agents that write code while you sleep.

**One command. Local-first. No cloud relay.**

[![npm version](https://img.shields.io/npm/v/conductor-oss?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/conductor-oss)
[![CI](https://img.shields.io/github/actions/workflow/status/charannyk06/conductor-oss/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Rust Backend](https://img.shields.io/badge/rust-local_backend-ce422b?style=flat-square)](https://www.rust-lang.org)
[![GitHub Stars](https://img.shields.io/github/stars/charannyk06/conductor-oss?style=flat-square&color=facc15)](https://github.com/charannyk06/conductor-oss/stargazers)

</div>

Conductor turns your repo into a local agent control plane.

Run one command, open a dashboard, drag work into a ready lane, and let your installed coding agents pick it up in parallel. Conductor keeps the state on your machine, runs a local Rust backend, stores data in local SQLite, and streams updates into the dashboard over SSE.

If you like Claude Code, Codex, Gemini, Qwen, Amp, Cursor Agent, or Copilot but want orchestration instead of a single terminal session, this is the missing layer.

## Why Conductor

- One command to a working dashboard.
- Local-first architecture with no hosted relay in the middle.
- Bring your own agent CLI and auth; Conductor does not proxy provider credentials.
- Markdown-backed Kanban board in `CONDUCTOR.md`.
- Multi-session orchestration with retries, restore, archive, and diff review.
- Worktree-aware repo isolation so multiple agents can work on the same codebase safely.
- GitHub-aware flows for repos, PRs, checks, and project sync.

## Quick Start

### 1. Make sure the machine has the basics

- Node.js `>= 18`
- `git`
- `tmux`
- at least one supported coding-agent CLI installed and already authenticated

### 2. Launch Conductor

```bash
npx conductor-oss@latest
```

What that does today:

- starts the local Conductor dashboard
- launches the local Rust backend
- opens the app in your browser
- keeps your project state local

The published npm package includes platform-native backend packages for:

- macOS (`arm64` and `x64`)
- Linux (`x64`)
- Windows (`x64`)

### 3. Add a repo and dispatch work

From the dashboard you can:

- add an existing local repo
- clone a Git repo into a managed workspace
- create tasks in the board
- drag a task into `Ready to Dispatch`

Conductor will spin up a session, stream output live, track the diff, and keep the attempt history attached to the task.

## Inside An Existing Repo

If you want to bootstrap Conductor files inside the repo you are already in:

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

The CLI exposes `conductor-oss`, `conductor`, and `co`.

## What You Get

- Workspace dashboard for repositories, projects, sessions, and agents
- Markdown-native Kanban board stored in `CONDUCTOR.md`
- Local Rust backend for orchestration, persistence, and API routes
- SQLite persistence in `.conductor/conductor.db`
- Live session chat/output streaming
- Session diff inspection and preview tooling
- Retry, restore, archive, kill, and feedback flows
- Worktree or in-place execution modes
- GitHub repo discovery, webhook handling, and project sync
- Access controls for shared/private dashboard setups

## Why This Exists

Raw coding-agent CLIs are good at one task in one terminal.

Conductor adds the missing operating system around them:

- queueing
- board automation
- task history
- worktree isolation
- session recovery
- browser visibility
- multi-agent coordination

## Local-First, Explicitly

Conductor is opinionated about where your code and session state live:

- your repositories stay on your machine
- the main backend runs locally
- state is stored in local files plus local SQLite
- the dashboard talks to the local backend
- upstream agent auth and billing stay with the agent vendor you already use

Conductor is not a hosted agent SaaS and not a relay that forwards your repo through a third-party service.

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

## Current Reality

Conductor is already usable, but strangers should know the current edges:

- The runtime is still `tmux`-first, so `tmux` is effectively required.
- Agent behavior depends on the upstream CLI you install.
- GitHub-heavy flows are best with `gh` installed and authenticated.
- Preview tooling is strongest when a repo has an explicit local dev server configured.
- The product is currently a hybrid stack: Rust backend plus Next.js dashboard/launcher.

## Important Commands

- `co start` - start the dashboard and local backend
- `co init` - scaffold `conductor.yaml` and `CONDUCTOR.md`
- `co setup` - guided environment setup
- `co spawn` - start a new session for a project
- `co list` - list sessions
- `co status` - summarize active sessions
- `co send` - send a follow-up to a session
- `co restore` - relaunch a dead session
- `co retry` - create a new attempt from a prior task/session
- `co kill` - terminate a session
- `co cleanup` - reclaim resources from completed sessions
- `co mcp-server` - run Conductor as an MCP server

## Developer Setup

If you are hacking on Conductor itself:

### Requirements

- Bun `>= 1.2`
- Rust toolchain
- Node.js `>= 18`

### Run from source

```bash
bun install
bun run dev:full
```

Default dev ports:

- dashboard: `http://localhost:3000`
- Rust backend: `http://127.0.0.1:4749`

Useful scripts:

```bash
bun run dev
bun run dev:backend
bun run dev:full
bun run prod:prepare
bun run prod:full
bun run build
bun run build:frontend
bun run clean
```

## Architecture

### User-facing stack

- npm CLI for install and launch
- Next.js dashboard for the browser UI
- Rust backend for orchestration, API routes, session state, Git integration, and persistence

### Rust crates

- `crates/conductor-cli`
- `crates/conductor-core`
- `crates/conductor-db`
- `crates/conductor-executors`
- `crates/conductor-git`
- `crates/conductor-server`
- `crates/conductor-watcher`

### Local data

- `conductor.yaml` for workspace and project config
- `CONDUCTOR.md` for the board
- `.conductor/conductor.db` for local state
- `attachments/<project>/...` for uploaded files

## Links

- GitHub: <https://github.com/charannyk06/conductor-oss>
- npm: <https://www.npmjs.com/package/conductor-oss>
- Issues: <https://github.com/charannyk06/conductor-oss/issues>
- Pull requests: <https://github.com/charannyk06/conductor-oss/pulls>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=charannyk06/conductor-oss&type=Date)](https://star-history.com/#charannyk06/conductor-oss&Date)

## License

MIT. See [LICENSE](LICENSE).
