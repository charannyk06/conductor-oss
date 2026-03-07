<div align="center">

# Conductor OSS

**Local-first coding agent orchestration with a board, chat UI, worktree isolation, and resumable multi-session runs.**

<br>

[![npm version](https://img.shields.io/npm/v/conductor-oss?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/conductor-oss)
[![CI](https://img.shields.io/github/actions/workflow/status/charannyk06/conductor-oss/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-1.2+-f59e0b?style=flat-square)](https://bun.sh)
[![Rust](https://img.shields.io/badge/rust-backend-ce422b?style=flat-square)](https://www.rust-lang.org)
[![GitHub Stars](https://img.shields.io/github/stars/charannyk06/conductor-oss?style=flat-square&color=facc15)](https://github.com/charannyk06/conductor-oss/stargazers)

</div>

## What is Conductor?

Conductor OSS is a local-first dashboard for controlling coding-agent CLIs from a structured browser UI.

It combines:

- a markdown-native board for tasks and issues
- a chat-oriented execution surface for agent runs
- local branch mode or isolated worktree mode
- multiple concurrent sessions against the same repo
- a Rust backend with a Bun/Next frontend

Conductor is not a hosted managed agent platform. It runs on your machine, uses your locally installed agent CLIs, and keeps state in your local workspace.

---

## Why Conductor?

| | Manual workflow | Terminal-only agent use | **Conductor OSS** |
|---|---|---|---|
| Task tracking | Separate tickets / notes | Separate from execution | **Board-linked tasks and runs** |
| Session management | Manual tabs and branches | One terminal at a time | **Multiple parallel sessions** |
| Workspace isolation | Manual branches/worktrees | Manual | **Built-in local/worktree session modes** |
| Agent UX | Raw CLI only | Raw CLI only | **Structured chat + tool-call UI** |
| Resume after completion | Manual | Manual | **Session stays resumable until archived** |
| Storage | Mixed tools | Local shell history | **Local SQLite + board files** |
| Deployment model | Varies | Local | **Local-first** |

---

## Repository Links

- GitHub Repository: https://github.com/charannyk06/conductor-oss
- Issues: https://github.com/charannyk06/conductor-oss/issues
- Pull Requests: https://github.com/charannyk06/conductor-oss/pulls
- CI: https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml
- NPM Package: https://www.npmjs.com/package/conductor-oss

---

## Current product shape

The app is currently organized around three core objects:

1. `Task`
   - a board card or issue tracked in `CONDUCTOR.md`
2. `Session`
   - one run or attempt against that task with a specific agent, model, workspace, and branch
3. `Workspace`
   - the local repo or worktree used by that run

Current capabilities include:

- board-linked tasks with human-readable task refs
- multiple runs attached to a single board task
- local branch mode or worktree isolation mode
- resumable sessions that remain in `needs_input` after a successful run
- archive as the explicit cleanup action for a run
- grouped tool-call rendering in chat
- per-agent model selection
- local-first execution with installed coding-agent CLIs
- workspace and remote access configuration in the dashboard

---

## Architecture

Conductor currently ships as a Rust backend with a Bun/Next.js frontend.

### Backend

Rust crates under `crates/`:

- `conductor-cli`: local launcher and app entrypoint
- `conductor-server`: Axum API server, session manager, board/session routes
- `conductor-executors`: agent adapters and PTY-backed process handling
- `conductor-db`: local SQLite persistence
- `conductor-git`: git/worktree operations
- `conductor-watcher`: watcher logic
- `conductor-core`: shared core types

### Frontend

Web app under `packages/web/`:

- Next.js 16
- React 19
- Bun workspace scripts
- browser UI for board, settings, chat, sessions, and linked runs

### Persistence

Conductor is local-first, but not database-free.

Current state is stored in:

- `.conductor/conductor.db`: local SQLite state
- `CONDUCTOR.md`: board/task planning surface
- workspace and worktree files in the selected project path

---

## Session lifecycle

A session is the unit of execution.

Each session has:

- an agent
- a model
- a workspace path
- a branch or worktree
- chat history
- tool-call history
- local runtime output

Current lifecycle behavior:

- active runs stream into the chat view
- tool calls are rendered as grouped structured rows
- after a successful run, the session moves to `needs_input`
- replying continues the same session instead of spawning a duplicate session entry
- archiving is the explicit teardown and cleanup path

---

## Supported agents

Conductor currently detects and uses agent CLIs that are installed locally.

Common supported agents in the app today:

- Claude Code
- Codex
- Gemini
- Qwen Code
- OpenCode
- GitHub Copilot

Actual availability depends on what is installed and authenticated on your machine.

Notes:

- upstream auth and billing constraints still apply
- some CLIs may be present but unusable until their normal terminal auth flow is completed
- Conductor does not bypass provider-side limits, auth, or subscription checks

---

## Board model

The board is the planning surface. Sessions are the execution surface.

Current behavior:

- tasks live in the board file and can be moved or edited from the web UI
- a task can link to multiple session runs
- one run can be marked as the primary linked run
- board cards surface linked runs and jump directly into the session chat
- task refs are human-readable instead of raw UUID-only identifiers

---

## Quick Start

### Install dependencies

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

---

## Workspace scripts

Useful root scripts:

```bash
bun run dev
bun run dev:backend
bun run dev:full
bun run build
bun run build:frontend
bun run clean
```

---

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

---

## Development prerequisites

Install locally:

- Bun `>= 1.2`
- Rust toolchain
- Git
- one or more supported coding-agent CLIs

Common optional tools:

- GitHub CLI
- tmux

---

## What the app is optimized for

Conductor OSS is currently best suited for:

- local-first development workflows
- multiple coding-agent sessions against the same repo
- linking execution back to markdown board tasks
- isolating risky work in worktrees while keeping review in one dashboard
- preserving resumable session history instead of treating every run as disposable

---

## Current limitations

This repo is still evolving quickly.

Important current realities:

- reliability depends partly on the installed upstream CLI behavior
- some providers require normal terminal auth or billing setup before their agent works here
- the chat view is a structured projection over terminal-backed execution
- UX and output rendering are still being tightened actively
- documentation can drift quickly unless it is updated alongside implementation changes

---
## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=charannyk06/conductor-oss&type=Date)](https://star-history.com/#charannyk06/conductor-oss&Date)

---

## License

MIT. See [LICENSE](LICENSE).
