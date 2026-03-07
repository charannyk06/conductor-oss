# Conductor OSS

Conductor OSS is a local-first dashboard for running coding-agent CLIs in parallel, linking them to board tasks, and managing isolated workspaces from a browser UI.

It is not a hosted SaaS product. The application runs on your machine, uses the agent CLIs you already install and authenticate, and stores its state locally.

## Current product shape

Today the application is built around three ideas:

- `Task`: a board card or issue tracked in `CONDUCTOR.md`
- `Session`: one run or attempt against that task with a specific agent/model/branch
- `Workspace`: the local repo or worktree where that session executes

The current UX supports:

- multi-session agent work across the same repo
- local branch mode or isolated git worktree mode
- board-linked tasks with multiple runs per task
- resumable chat sessions that stay open until archived
- grouped tool-call rendering in chat
- model selection per agent
- local and remote access settings in the dashboard
- archive/interrupt lifecycle controls for completed or stale runs

## Architecture

Conductor currently ships as a Rust backend with a Bun/Next.js frontend.

### Backend

Rust crates under `crates/`:

- `conductor-cli`: app entrypoint and local launcher
- `conductor-server`: Axum API server and session manager
- `conductor-executors`: agent adapters and PTY-backed process control
- `conductor-db`: local SQLite persistence
- `conductor-git`: git/worktree helpers
- `conductor-watcher`: file/session watcher logic
- `conductor-core`: shared types and core utilities

### Frontend

Web app under `packages/web/`:

- Next.js 16
- React 19
- run with Bun from the workspace root scripts
- talks to the Rust backend over local HTTP

### Persistence

Conductor is local-first, but it is not “no database”.

Current state is stored locally in:

- `.conductor/conductor.db`: SQLite app/session state
- repository board files such as `CONDUCTOR.md`
- repo/worktree files in the selected project path

## Session model

A session is the unit of execution.

Each session has:

- an agent
- a model
- a project/workspace
- a branch or worktree
- chat history
- runtime/tool output

Current lifecycle:

- active runs stream into the chat view
- when a run completes successfully, the session moves to `needs_input`
- replying continues the same session id instead of spawning a duplicate sidebar entry
- archiving is the explicit cleanup action for the session run

## Supported agents

Conductor currently detects and uses agent CLIs that are installed locally.

Commonly supported agents in the current app:

- Claude Code
- Codex
- Gemini
- Qwen Code
- OpenCode
- GitHub Copilot

Actual availability depends on what is installed and authenticated on your machine.

Notes:

- some CLIs may be present but unusable until you complete their normal terminal auth flow
- billing/auth restrictions from the upstream provider still apply
- Conductor does not bypass provider auth, quotas, or subscription limits

## Board and task model

The board is the planning surface. Sessions are the execution surface.

Current behavior:

- tasks live in the board file and can be edited/moved from the web UI
- a task can have multiple session runs linked to it
- one run can be marked as the primary linked run
- board cards surface linked runs and jump directly into chat
- task refs are human-readable instead of raw UUID-only identifiers

## Development setup

### Prerequisites

Install these locally:

- Bun `>= 1.2`
- Rust toolchain
- Git
- one or more supported coding-agent CLIs

Optional but commonly useful:

- GitHub CLI
- tmux

### Install

```bash
bun install
```

### Run the full app

```bash
bun run dev:full
```

Defaults:

- web UI: `http://localhost:3000`
- Rust backend: `http://127.0.0.1:4748`

### Run frontend only

```bash
bun run dev
```

### Run backend only

```bash
bun run dev:backend
```

### Build

```bash
bun run build
```

## Workspace scripts

Useful root scripts today:

```bash
bun run dev
bun run dev:backend
bun run dev:full
bun run build
bun run build:frontend
bun run clean
```

## Repository layout

```text
crates/
  conductor-cli/
  conductor-core/
  conductor-db/
  conductor-executors/
  conductor-git/
  conductor-server/
  conductor-watcher/
packages/
  web/
  plugins/
```

## What the app is optimized for

Conductor is currently best suited for:

- local-first development teams or solo operators
- multiple concurrent coding-agent sessions
- linking chat execution back to a markdown-native task board
- isolating risky work in worktrees while keeping review in one dashboard

## Current limitations

This repo is still evolving quickly.

Important current realities:

- agent behavior is only as reliable as the installed upstream CLI
- some flows still depend on provider-specific auth or account state
- the chat view is a structured projection over terminal-backed agent execution
- UX and rendering details are still actively being tightened

## License

MIT. See [LICENSE](LICENSE).
