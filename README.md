<div align="center">

<!-- Logo placeholder — drop a conductor.svg in docs/ -->
<!-- <img src="docs/conductor-logo.svg" width="120" alt="Conductor OSS"> -->

# Conductor OSS

**Markdown-native AI agent orchestrator.**
Write tasks in a kanban board — Conductor dispatches agents, manages git worktrees, tracks PRs, and updates your board automatically.

<br>

[![npm version](https://img.shields.io/npm/v/conductor-oss?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/conductor-oss)
[![CI](https://img.shields.io/github/actions/workflow/status/charannyk06/conductor-oss/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%3E%3D18-3b82f6?style=flat-square)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-f59e0b?style=flat-square)](https://pnpm.io)
[![GitHub Stars](https://img.shields.io/github/stars/charannyk06/conductor-oss?style=flat-square&color=facc15)](https://github.com/charannyk06/conductor-oss/stargazers)

</div>

## What is Conductor?

Conductor turns your markdown kanban board into a fully autonomous AI development pipeline. Write a task in plain English, tag it with an agent and project, drag it to **Ready to Dispatch** — and Conductor handles everything else: spawning the agent in an isolated git worktree, streaming live output to a web dashboard, opening a pull request, watching CI, and updating your board card with the result.

It runs entirely on your machine. No cloud. No database. No SaaS subscription.

---

## Why Conductor?

| | Manual workflow | Other tools | **Conductor** |
|---|---|---|---|
| Task format | Jira / Linear ticket | Proprietary UI | **Plain markdown** |
| Where tasks live | Cloud app | Cloud app | **Your own files** |
| Agent execution | Manual | Managed cloud | **Local — your machine, your keys** |
| Multiple agents | Clipboard juggling | Vendor lock-in | **Claude Code, Codex, Gemini, Amp, Cursor CLI, OpenCode, Droid, Qwen Code, CCR, GitHub Copilot — pick any** |
| Context isolation | Manual branches | Varies | **Git worktree per task** |
| PR lifecycle | Manual | Partial | **Full: open → CI → review → merge** |
| Database required | — | Often | **Never — flat files only** |
| Cost | Subscription | Subscription | **Free + your API keys** |

---

## Repository Links

- GitHub Repository: https://github.com/charannyk06/conductor-oss
- Issues: https://github.com/charannyk06/conductor-oss/issues
- Pull Requests: https://github.com/charannyk06/conductor-oss/pulls
- CI: https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml
- NPM Package: https://www.npmjs.com/package/conductor-oss

---

## Demo

## Demo videos & GIFs

### 01) Task creation and dispatch

<p align="center">
  <img src="docs/demo/01-add-task.gif" alt="Session add task (GIF)" />
</p>

### 02) Auto dispatch terminal

<p align="center">
  <img src="docs/demo/02-auto-dispatch.gif" alt="Auto dispatch (GIF)" />
</p>

### 03) Live terminal execution

<p align="center">
  <img src="docs/demo/03-live-terminal.gif" alt="Live terminal (GIF)" />
</p>

### 04) Dashboard review + PR triage

<p align="center">
  <img src="docs/demo/04-dashboard.gif" alt="Dashboard review (GIF)" />
</p>

### 05) PR creation and handoff

<p align="center">
  <img src="docs/demo/05-pr-creation.gif" alt="PR creation (GIF)" />
</p>


---

## Quick Start

```bash
# 1. Install
npm install -g conductor-oss
# or: npx conductor-oss init

# 2. Scaffold a project
mkdir my-project && cd my-project
co init

# 3. Start the orchestrator
co start

# 3b. Optional: run against an explicit workspace/config path
cd /path/to/workspace
CO_CONFIG_PATH=./conductor.yaml co start --workspace . --port 4747
```

Then in the dashboard:

1. First run opens **Confirm your preferences** (agent, IDE, markdown editor, notifications).
2. Click **Add Workspace** in the left sidebar.
3. Pick **Git Repository** to load GitHub repos + select branch, or **Local Folder** to choose a repo from the folder picker.

Open `CONDUCTOR.md` in your editor (or Obsidian), write a task in **Ready to Dispatch**, save — done.

To keep visual docs accurate after each UI change, regenerate gallery screenshots:

```bash
pnpm ui:screenshots
```

If the dashboard appears stale after edits, restart the running `co start` process so port `4747` rebuilds from disk:

```bash
# from your workspace root
pkill -f "next dev -p 4747" || true
CO_CONFIG_PATH=./conductor.yaml co start --workspace . --port 4747
```

Or, from any working directory:

```bash
cd /path/to/workspace
CONDUCTOR_WORKSPACE=/path/to/workspace CO_CONFIG_PATH=./conductor.yaml co start --port 4747
```

### Running on localhost

The dashboard UI runs on:

- `co start`: `http://localhost:<port>` from `conductor.yaml` (default `4747` when using generated config)
- `co dashboard`: `--port` if provided, otherwise `conductor.yaml` `port`, otherwise `3000`

If a workspace has multiple projects, the dashboard loads all linked boards from that workspace and keeps project links scoped to the correct board files.

If you edit `conductor.yaml` while the dashboard is already running:

- Projects are now refreshed from `/api/config` every few seconds on the dashboard page, so new/updated projects appear without restarting.
- If project IDs still look stale, restart the web process as above to clear app-level state.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) · `brew install node` |
| tmux | any | `brew install tmux` · `apt install tmux` |
| GitHub CLI | any | `brew install gh` then `gh auth login` |
| An AI agent | — | See below |

**Pick one agent (or all supported):**

```bash
npm install -g @anthropic-ai/claude-code     # Claude Code
npm install -g @openai/codex-cli             # OpenAI Codex
npm install -g @google/gemini-cli            # Gemini CLI

# Optional / alternate agent CLIs (install as available in your environment)
# amp, cursor-cli (or cursor), opencode, droid, qwen-code, ccr, github-copilot
# You can also point each plugin at a custom binary using:
# AMP_BIN, CURSOR_CLI_BIN, OPEN_CODE_BIN, DROID_BIN, QWEN_CODE_BIN, CCR_BIN, GITHUB_COPILOT_BIN
```

---

## How It Works

```
 ┌─────────────────────────────────────┐
 │  CONDUCTOR.md  (your kanban board)  │
 │  - [ ] fix login bug  #agent/claude │
 └──────────────┬──────────────────────┘
                │  file watcher
                ▼
 ┌──────────────────────────┐
 │  Board Watcher           │  detects tasks in "Ready to Dispatch"
 └──────────────┬───────────┘
                │
                ▼
 ┌──────────────────────────┐
 │  Session Manager         │  spawns agent in tmux + git worktree
 └──────────────┬───────────┘
                │
                ▼
 ┌──────────────────────────┐
│  Agent Process           │  Configured agent CLI (Claude, Codex, Gemini, etc.)
 │  (isolated worktree)     │  writes code, commits, opens PR
 └──────────────┬───────────┘
                │
                ▼
 ┌──────────────────────────┐
 │  Lifecycle Manager       │  polls CI, review status, merge
 └──────────────┬───────────┘
                │
                ▼
 ┌──────────────────────────┐
 │  Board + Dashboard       │  live updates, terminal, cost
 └──────────────────────────┘
```

### Board Columns

| Column | Meaning |
|--------|---------|
| **Inbox** | Rough ideas — auto-tagged by AI within 20 seconds |
| **Ready to Dispatch** | Tagged tasks waiting to be picked up |
| **Dispatching** | Agent is spawning |
| **In Progress** | Agent working |
| **Review** | PR open — agent done, your turn |
| **Done** | Merged ✅ |
| **Blocked** | Needs manual intervention |

### Task Format

```markdown
- [ ] fix the login bug #agent/claude-code #project/my-app #type/fix #priority/high
```

Or just drop raw text in **Inbox** — Conductor auto-formats it.

Conductor accepts both native plugin IDs and common CLI aliases, each resolved to the matching dedicated plugin (no generic fallback launcher):

- `claude-code` (`claude`, `cc`, `claude-code`, `claude-cli`, `claude-code-cli`, `claude_code_cli`)
- `codex` (`openai`, `open-ai`, `openai-codex`, `openai-codex-cli`, `codex`, `codex-cli`, `codexcli`)
- `gemini` (`google-gemini`, `google-gemini-cli`, `gm`, `gemini-cli`)
- `amp` (`amp`, `amp-cli`)
- `cursor-cli` (`cursor`, `cursor-agent`, `cursor-agent-cli`, `cursor_agent`, `cursoragent`, `cursor-cli`)
- `opencode` (`open-code`, `open_code`, `open code`, `open-code-cli`, `opencode`)
- `droid` (`droid`)
- `qwen-code` (`qwen`, `qwen_code`, `qwen code`, `qwen-code`, `qwen-code-cli`)
- `ccr` (`claude-code-router`, `claude_code_router`, `ccr`, `ccr-cli`)
- `github-copilot` (`copilot`, `copilot-cli`, `gh-copilot`)

Aliases are normalized and resolved to the dedicated native plugin ID before dispatch.

---

## Features

| Feature | Status |
|---------|--------|
| 10 built-in agents — Claude Code (`claude-code`), Codex (`codex`), Gemini (`gemini`), Amp (`amp`), Cursor CLI (`cursor-cli`), Opencode (`opencode`), Droid (`droid`), Qwen Code (`qwen-code`), CCR (`ccr`), GitHub Copilot (`github-copilot`) | ✅ |
| MCP server (use Conductor from Cursor / Claude Desktop) | ✅ |
| Webhook triggers — GitHub events → kanban tasks | ✅ |
| Per-project MCP server configuration | ✅ |
| Live terminal streaming in browser | ✅ |
| Real-time kanban board sync | ✅ |
| Cost tracking per session | ✅ |
| Plugin architecture — bring your own agent/runtime/SCM | ✅ |
| No database — flat file state only | ✅ |
| Git worktree isolation per task | ✅ |
| Discord + desktop notifications | ✅ |
| Clerk authentication for dashboard (optional) | ✅ |

---

## Configuration

`conductor.yaml` (created by `co init`):

```yaml
port: 4747
boards:
  - CONDUCTOR.md
  # glob (workspace-relative)
  - projects/*/CONDUCTOR.md
  # per-pattern alias override
  - path: projects/*/*.md
    aliases:
      intake: ["Inbox", "Backlog", "To do"]
      ready: ["Ready to Dispatch", "Ready"]
      review: ["Review", "In Review"]
      done: ["Done"]
  # absolute or relative custom boards
  - /path/to/extra/boards/*.md

# global fallback aliases
columnAliases:
  intake: ["Inbox", "Backlog", "To do"]
  ready: ["Ready to Dispatch", "Ready"]
  review: ["Review", "In Review"]
  done: ["Done"]

# Optional: dashboard first-run + settings preferences
preferences:
  onboardingAcknowledged: false
  codingAgent: claude-code
  ide: vscode
  markdownEditor: obsidian
  notifications:
    soundEnabled: true
    soundFile: abstract-sound-4

projects:
  my-app:
    path: ~/projects/my-app       # path to your git repo
    repo: your-org/my-app         # GitHub org/repo
    agent: claude-code            # "claude-code" | "codex" | "gemini" | "amp" | "cursor-cli" | "opencode" | "droid" | "qwen-code" | "ccr" | "github-copilot"
    agentConfig:
      model: claude-sonnet-4-6    # any model the agent supports
      permissions: skip           # fully autonomous (no prompts)
    defaultProfile: fast
    agentProfiles:
      fast:
        agent: codex
        model: gpt-5.3-codex-spark
      deep:
        agent: claude-code
        model: claude-opus-4-6
    devServer:
      command: pnpm dev
      cwd: ~/projects/my-app
    workspace: worktree           # git worktree per task
    runtime: tmux                 # tmux session runner
    scm: github                   # GitHub PR + CI integration

    # Optional: per-project MCP servers (merged with defaults)
    mcpServers:
      postgres:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-postgres"]
        env:
          DATABASE_URL: "postgresql://localhost/my_app_dev"

# Optional: global MCP servers (available to all projects)
defaults:
  mcpServers:
    filesystem:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/"]

# Optional: Discord notifications
plugins:
  discord:
    channelId: "YOUR_CHANNEL_ID"
    tokenEnvVar: DISCORD_BOT_TOKEN
  desktop:
    sound: true
```

---

## MCP Server

Use Conductor as an MCP tool from **Cursor**, **Claude Desktop**, or any MCP-compatible client:

```json
{
  "mcpServers": {
    "conductor": {
      "command": "conductor-oss",
      "args": ["mcp"]
    }
  }
}
```

Available tools exposed via MCP:
- `conductor_dispatch` — create and dispatch a new agent task
- `conductor_list_sessions` — list active sessions and their status
- `conductor_session_status` — get details and terminal output for a session
- `conductor_list_projects` — list configured projects
- `conductor_kill_session` — terminate a running session

---

## Webhook API

Trigger tasks programmatically via HTTP or GitHub webhooks:

```bash
# Trigger a task via HTTP
curl -X POST http://localhost:4747/api/webhook/task \
  -H "Content-Type: application/json" \
  -d '{"task": "fix the auth bug", "project": "my-app", "agent": "claude-code"}'

# Configure GitHub to send PR/issue events → auto-create tasks
# In your GitHub repo: Settings → Webhooks → Add webhook
# Payload URL: http://your-host:4747/api/webhook/github
# Secret: your-webhook-secret (set WEBHOOK_SECRET env var)
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook/task` | POST | Trigger a task directly |
| `/api/webhook/github` | POST | GitHub events → tasks (HMAC-verified) |
| `/api/webhook/status` | GET | Health check for webhook subsystem |
| `/api/webhook/health` | GET | Health check endpoint |

When running the standalone webhook command, the listener defaults to port `4748` unless overridden with `--port`.

## Dashboard API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/config` | GET | Active config + runtime settings |
| `/api/events` | GET | Recent watcher/lifecycle events |
| `/api/agents` | GET | Agent inventory |
| `/api/health/boards` | GET | Monitored board status |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions/:id` | GET | Session detail |
| `/api/sessions/:id/output` | GET | Session output stream |
| `/api/sessions/:id/diff` | GET | Session diff payload |
| `/api/sessions/:id/checks` | GET | PR/CI checks |
| `/api/sessions/:id/send` | POST | Send message to a session |
| `/api/sessions/:id/feedback` | POST | Send review feedback |
| `/api/sessions/:id/kill` | POST | Kill a session |
| `/api/sessions/:id/restore` | POST | Restore a session |
| `/api/sessions/:id/keys` | POST | Refresh session keys |
| `/api/spawn` | POST | Spawn a session |

---

## CLI Reference

```bash
co init                                # Scaffold CONDUCTOR.md + conductor.yaml
co start [--no-dashboard] [--no-watcher] [--port <port>] [--workspace <path>] # Start orchestrator
co watch                               # Run board watcher only
co doctor                              # Diagnose board parsing/dispatch issues
co list [--all] [--json] [project]     # List all sessions
co spawn <project> "<task>"            # Manually dispatch a session
co send <session-id> "<msg>"           # Send message to an active session
co restore <session-id>                # Restore completed session output
co retry <session-id|task-id>          # Start a new attempt
co task show <task-id>                 # Show task parent/children/attempts
co feedback <session-id> "<msg>"       # Send review feedback and requeue task
co status [project]                    # Status overview
co attach <session-id>                 # Attach to tmux session
co cleanup [project]                   # Cleanup dead/inactive sessions
co kill <session-id>                   # Kill a session
co dashboard [--port]                  # Open web dashboard in browser
co webhook [--port]                    # Start webhook server only
co mcp-server                          # Start MCP server (stdio)
```

## Local Troubleshooting (Common)

### Wrong board links or missing board actions
- Restart `co start` with the workspace and config path that contains your projects:

```bash
CO_CONFIG_PATH=/path/to/workspace/conductor.yaml co start --workspace /path/to/workspace --port 4747
```

- Confirm `/api/config` returns all expected projects in the dashboard.

### Known agents not detected locally
- Open a local-only check:

```bash
curl -s http://localhost:4747/api/agents | jq '.agents[] | {name, description, version}'
```

- If a binary is installed but not shown, confirm it appears in PATH and retry after restart:

```bash
which codex
which claude
which gemini
which amp
which cursor
which cursor-cli
which opencode
which droid
which qwen-code
which ccr
which github-copilot
```

- If you use an alternate binary name (for example `openai-codex`), it is now detected by the refreshed route. Restart `co start` after adding it to PATH so `/api/agents` refreshes.

- If you are launching `co start` from a process manager and agents are installed for your shell user only, restart in a fresh shell so PATH is inherited.

### “Invalid request origin” on cleanup/session actions
- Make sure actions are triggered from the same origin as the running dashboard (`http://localhost:4747` is default).
- If you use `127.0.0.1`, use the same host/port consistently in your browser and API calls.

### Bulk clean up sessions
- Use **`Ctrl/Cmd + K`** then run **“Cleanup all sessions”**.
- Or call kill directly for a session:

```bash
curl -X POST http://localhost:4747/api/sessions/<session-id>/kill
```

### Session and board sanity checks
- `GET /api/sessions` should return `{ sessions: [...] }`.
- `GET /api/health/boards` should list configured board files and watch state.

---

## Plugin Architecture

Every component is a swappable plugin. Conductor ships with batteries included, but you can add your own:

| Slot | Built-in | Interface |
|------|----------|-----------|
| **Agent** | `claude-code`, `codex`, `gemini`, `amp`, `cursor-cli`, `opencode`, `droid`, `qwen-code`, `ccr`, `github-copilot` | `AgentPlugin` |
| **Runtime** | `tmux` | `RuntimePlugin` |
| **Workspace** | `worktree` | `WorkspacePlugin` |
| **SCM** | `github` | `ScmPlugin` |
| **Tracker** | `github` | `TrackerPlugin` |
| **Notifier** | `discord`, `desktop` | `NotifierPlugin` |
| **Terminal** | `terminal-web` | `TerminalPlugin` |

Plugins are regular npm packages. Implement the interface, register in `conductor.yaml`, and Conductor picks them up automatically. See [CONTRIBUTING.md](CONTRIBUTING.md) for the plugin development guide.

---

## Security

Conductor is designed to be local-first and minimal attack surface:

- **No database** — flat files only, no SQL injection surface
- **No cloud** — runs entirely on your machine
- **Agent isolation** — each session in a separate git worktree
- **No secrets persisted** — API keys stay in your environment
- **Webhook HMAC verification** — GitHub signatures checked on every request
- **MCP over stdio** — no network listener

See [SECURITY.md](SECURITY.md) for the full security policy and responsible disclosure process.

---

## Architecture

This is a **20-package pnpm monorepo**:

```
conductor-oss/
├── packages/
│   ├── core/                      # Board watcher, session manager, lifecycle
│   ├── cli/                       # `co` / `conductor-oss` CLI
│   ├── web/                       # Next.js dashboard (localhost:4747)
│   └── plugins/
│       ├── agent-claude-code/     # Claude Code agent
│       ├── agent-codex/           # OpenAI Codex agent
│       ├── agent-gemini/          # Google Gemini CLI agent
│       ├── agent-amp/             # Amp CLI agent
│       ├── agent-cursor-cli/      # Cursor CLI agent
│       ├── agent-opencode/        # OpenCode CLI agent
│       ├── agent-droid/           # Factory Droid CLI agent
│       ├── agent-qwen-code/       # Qwen Code CLI agent
│       ├── agent-ccr/             # Claude Code Router
│       ├── agent-github-copilot/  # GitHub Copilot CLI
│       ├── mcp-server/            # MCP server (stdio)
│       ├── runtime-tmux/          # tmux session runner
│       ├── workspace-worktree/    # Git worktree isolation
│       ├── scm-github/            # GitHub PR + CI + review
│       ├── tracker-github/        # GitHub issue tracking
│       ├── notifier-discord/      # Discord notifications
│       ├── notifier-desktop/      # macOS / Linux desktop notifications
│       ├── terminal-web/          # Browser terminal streaming
│       └── webhook/               # HTTP + GitHub webhook receiver
└── conductor.example.yaml
```

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, commit conventions, and the plugin development guide.

**Quick start for contributors:**

```bash
git clone https://github.com/charannyk06/conductor-oss.git
cd conductor-oss
pnpm install
pnpm build
```

---

## Built With

[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=next.js&logoColor=white)](https://nextjs.org)
[![pnpm](https://img.shields.io/badge/pnpm-f69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)

---

## License

[MIT](LICENSE) — maintained by the Conductor community.

---

<div align="center">

If Conductor saves you time, please consider giving it a ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=charannyk06/conductor-oss&type=Date)](https://star-history.com/#charannyk06/conductor-oss&Date)

</div>
