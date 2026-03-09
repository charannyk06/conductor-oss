<div align="center">

# Conductor OSS

**Local-first orchestration for terminal coding agents, with a browser dashboard, markdown board, tmux runtime, and worktree-aware repo management.**

<br>

[![npm version](https://img.shields.io/npm/v/conductor-oss?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/conductor-oss)
[![CI](https://img.shields.io/github/actions/workflow/status/charannyk06/conductor-oss/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-1.2+-f59e0b?style=flat-square)](https://bun.sh)
[![Rust](https://img.shields.io/badge/rust-backend-ce422b?style=flat-square)](https://www.rust-lang.org)
[![GitHub Stars](https://img.shields.io/github/stars/charannyk06/conductor-oss?style=flat-square&color=facc15)](https://github.com/charannyk06/conductor-oss/stargazers)

</div>

Conductor OSS is a local-first control plane for coding-agent CLIs. It runs on your machine, talks to the agent tools you already have installed, and keeps project state in local files plus a local SQLite database.

The current app combines:

- a workspace dashboard for projects, sessions, and agents
- a markdown-backed kanban board stored in `CONDUCTOR.md`
- tmux-backed session execution with restore/retry/archive flows
- worktree or in-place repo execution
- a Rust API/backend with a Next.js dashboard frontend

## What The App Does Today

- Add a workspace from an existing local repo or clone one from a Git URL.
- Persist project settings in `conductor.yaml`, including default agent/model choices and preview-server settings.
- Create and manage board tasks from the UI, with human-readable task refs, comments, attachments, and linked session attempts.
- Spawn multiple agent sessions against the same repo, either on the main checkout or in isolated worktrees.
- Stream session chat and terminal output into the dashboard with interrupt, send, kill, archive, restore, and retry actions.
- Inspect a session's diff and a live preview tab. The preview surface can capture page context and send screenshots, DOM data, console logs, or network logs back to the active session as attachments.
- Discover installed agent CLIs, surface model selection where supported, and keep session history resumable instead of treating runs as disposable.
- Integrate with GitHub repositories and GitHub Projects v2 through `gh`, plus receive signed GitHub webhooks on `/api/github/webhook`.
- Apply dashboard access controls with viewer/operator/admin roles, trusted-header auth, optional Clerk wiring, and Tailscale-managed private remote access.

## Current Architecture

### Frontend

- `packages/web`: Next.js 16, React 19, Tailwind CSS 4 dashboard
- Main surfaces: workspace overview, workspace board, session detail, session diff, session preview, repository/settings panels
- API routes in the Next app proxy or coordinate with the Rust backend and the local preview/remote-access helpers

### Backend

Rust crates under `crates/`:

- `conductor-cli`: Rust backend entrypoint
- `conductor-server`: Axum server and API routes
- `conductor-db`: SQLite persistence and migrations
- `conductor-executors`: runtime/session execution plumbing
- `conductor-git`: Git and worktree operations
- `conductor-watcher`: watcher support
- `conductor-core`: shared types and config model

### Persistence

Conductor is local-first, but not stateless. Current data lives in:

- `conductor.yaml`: workspace and repository configuration
- `.conductor/conductor.db`: local SQLite state
- `CONDUCTOR.md`: project-local markdown board
- `attachments/<project>/...`: uploaded files used in board tasks and session replies

## Supported Agents

The repo currently ships built-in adapters and UI metadata for:

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

Actual availability depends on what is installed and authenticated on your machine. Conductor does not bypass upstream auth, billing, or provider-side limits.

## Runtime Model

The current runtime path is tmux-centric.

- Sessions are launched under tmux.
- Session recovery and `co attach` assume tmux is available.
- Workspaces can run in `worktree` mode or `local` mode.
- Preview support depends on either a configured local dev server or a preview URL already associated with the session/PR.

## Quick Start From Source

### Requirements

- Bun `>= 1.2`
- Node.js `>= 18` if you want to install the published npm CLI
- Rust toolchain
- Git
- tmux
- one or more supported coding-agent CLIs

Useful optional tools:

- GitHub CLI `gh` for repo discovery and GitHub Projects sync
- Tailscale for managed private remote access

### Install and run

```bash
bun install
bun run dev:full
```

Default dev ports:

- dashboard: `http://localhost:3000`
- Rust backend: `http://127.0.0.1:4749`

Other useful scripts:

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

### Prod-like local stack

```bash
bun run prod:prepare
bun run prod:full
```

Default prod-like local ports:

- dashboard: `http://127.0.0.1:4747`
- Rust backend: `http://127.0.0.1:4748`

Notes:

- Root scripts automatically source `./.env.local` when present.
- Set `CONDUCTOR_GITHUB_WEBHOOK_SECRET` if you want webhook signature verification.
- GitHub Projects v2 sync requires a `gh` login with project scopes:

```bash
gh auth refresh --scopes read:project,project
```

## Getting A Workspace Into Conductor

You can do this from the dashboard or from the CLI.

### Dashboard flow

From the workspace overview, add either:

- an existing local repository
- a Git repository to clone into a managed location

When a workspace is added, Conductor persists it into `conductor.yaml`, ensures a board file exists, and syncs project support files.

### CLI flow

Inside a repo:

```bash
co init
co start --workspace .
```

Or, after installing the npm package:

```bash
npm install -g conductor-oss
co
```

Or without a global install:

```bash
npx conductor-oss@latest
```

The CLI package exposes `conductor`, `conductor-oss`, and `co`.

## CLI Surface

The current CLI commands include:

- `co start`: launch the dashboard and backend
- `co dashboard`: open the dashboard in a browser
- `co setup`: guided environment/bootstrap flow
- `co init`: scaffold `conductor.yaml` and `CONDUCTOR.md`
- `co spawn`: create a new session for a project
- `co list`: list sessions
- `co status`: group active sessions by attention level
- `co send`: send a follow-up message to a session
- `co attach`: attach to the tmux session
- `co restore`: relaunch a dead/exited session
- `co retry`: create a fresh attempt from a prior session or task
- `co feedback`: send reviewer feedback and requeue work
- `co kill`: terminate a session
- `co cleanup`: reclaim completed session resources
- `co doctor`: diagnose config, board, and watcher issues
- `co task show`: inspect task graph and attempts
- `co mcp-server`: start the MCP server command path

## Configuration

The app's main configuration file is `conductor.yaml`.

Representative shape:

```yaml
workspace: /absolute/path/to/control-workspace
server:
  host: 127.0.0.1
  port: 4749
projects:
  my-app:
    name: My App
    repo: https://github.com/acme/my-app.git
    path: /absolute/path/to/my-app
    defaultBranch: main
    runtime: tmux
    workspace: worktree
    boardDir: my-app
    agent: codex
    agentConfig:
      permissions: default
      model: o4-mini
      reasoningEffort: medium
    devServer:
      command: bun dev
      cwd: packages/web
      port: 3001
preferences:
  codingAgent: codex
access:
  requireAuth: false
```

Useful project-level fields supported by the current code:

- `defaultWorkingDirectory`
- `setupScript`
- `cleanupScript`
- `archiveScript`
- `copyFiles`
- `devServer.command`
- `devServer.cwd`
- `devServer.url`
- `devServer.port`
- `devServer.host`
- `devServer.path`
- `devServer.https`

## GitHub Integration

The current GitHub integration is deeper than simple repo linking:

- discover accessible repositories via `gh`
- link a Conductor project to GitHub Projects v2
- sync board state with a linked GitHub Project
- accept signed webhook deliveries at `/api/github/webhook`

This path assumes normal `gh` authentication and GitHub permissions on the local machine.

## Access Control And Remote Use

The safest way to run Conductor is on loopback only. The Rust backend explicitly refuses non-loopback binding unless you opt into:

```bash
CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND=true
```

The current repo also includes support for:

- viewer/operator/admin roles in config
- trusted auth headers
- Cloudflare Access-style trusted-header validation
- optional Clerk-backed sign-in wiring in the web app
- Tailscale-managed private remote access from the dashboard

Relevant env examples live in:

- [`.env.example`](.env.example)
- [`packages/web/.env.example`](packages/web/.env.example)

## Repository Layout

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
  cli/
  core/
  plugins/
  web/
scripts/
docs/
```

## Operational Realities

Important current constraints from the codebase:

- The runtime is tmux-first, so tmux is effectively required for the core session workflow.
- Agent behavior depends heavily on the upstream CLI you install and how that CLI handles auth, rate limits, prompts, and output formatting.
- GitHub repo discovery and GitHub Projects sync depend on `gh` being installed and authenticated.
- Preview tooling is strongest when the repo has an explicit dev-server mapping in config.
- Conductor is local-first orchestration software, not a hosted agent platform.

## Links

- GitHub: <https://github.com/charannyk06/conductor-oss>
- Issues: <https://github.com/charannyk06/conductor-oss/issues>
- Pull requests: <https://github.com/charannyk06/conductor-oss/pulls>
- npm package: <https://www.npmjs.com/package/conductor-oss>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=charannyk06/conductor-oss&type=Date)](https://star-history.com/#charannyk06/conductor-oss&Date)

## License

MIT. See [LICENSE](LICENSE).
