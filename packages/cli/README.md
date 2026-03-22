# conductor-oss

`conductor-oss` is the published npm package for Conductor's CLI launcher.

It starts the local dashboard and Rust backend, scaffolds `CONDUCTOR.md` and `conductor.yaml`, launches agent sessions, and exposes the user-facing `co` commands.

## Install

Use it without installing:

```bash
npx conductor-oss@latest
```

Or install it globally:

```bash
npm install -g conductor-oss
co start
```

The package installs these command aliases:

- `conductor-oss`
- `conductor`
- `co`

## Quick Start

Initialize an existing repo:

```bash
npx conductor-oss@latest init
npx conductor-oss@latest start --workspace .
```

Launcher defaults:

- Dashboard: `http://127.0.0.1:4747`
- Rust backend: `http://127.0.0.1:4748`

Source checkouts of the repo use different development ports:

- Dashboard: `http://localhost:3000`
- Rust backend: `http://127.0.0.1:4749`

## What It Does

Conductor is a local-first orchestrator for AI coding agents. The npm package gives you:

- Markdown-native planning with `CONDUCTOR.md`
- Worktree-isolated agent sessions
- ttyd-backed real terminal sessions in the dashboard
- Session recovery with retry, restore, feedback, and cleanup flows
- A local SQLite state store in `.conductor/conductor.db`

## CLI Commands

| Command | Description |
|---------|-------------|
| `co start` | Start the dashboard and Rust backend |
| `co init` | Scaffold `conductor.yaml` and `CONDUCTOR.md` |
| `co setup` | Guided first-run setup for agents, editors, and local tooling |
| `co spawn` | Create a new session |
| `co list` | List sessions |
| `co status` | Show the current attention-oriented status board |
| `co send` | Send a message to a running session |
| `co feedback` | Send reviewer feedback and requeue a session |
| `co retry` | Create a new attempt from an existing task or session |
| `co restore` | Restore an exited session |
| `co kill` | Terminate a session |
| `co cleanup` | Reclaim resources from completed sessions |
| `co doctor` | Inspect backend and session health |
| `co dashboard` | Open the dashboard in a browser |
| `co task show <taskId>` | Inspect task attempts, parent, and child tasks |
| `co mcp-server` | Run Conductor as an MCP server over stdio |

## Supported Agents

Conductor currently includes adapters for:

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

The dashboard only offers agents it can discover on your machine.

## Access Control and Bridge

The current package supports local-first usage plus optional access-control and paired-device flows already present in the app:

- Verified Cloudflare Access JWT validation and role bindings
- Optional Clerk-backed sign-in flows in the web app
- Bridge and relay flows for paired-device execution

Unauthenticated public dashboard access is not supported.

## More Docs

For repository architecture, contributor guidance, and the broader product overview, see:

- GitHub: <https://github.com/charannyk06/conductor-oss>
- Root README: <https://github.com/charannyk06/conductor-oss#readme>
