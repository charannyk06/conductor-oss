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

## Demo GIF Links

- [Add task in Obsidian Kanban](docs/demo/01-add-task.gif)
- [Auto-dispatch flow](docs/demo/02-auto-dispatch.gif)
- [Live terminal streaming](docs/demo/03-live-terminal.gif)
- [Dashboard overview](docs/demo/04-dashboard.gif)
- [PR creation](docs/demo/05-pr-creation.gif)

## Repository Links

- GitHub Repository: https://github.com/charannyk06/conductor-oss
- Issues: https://github.com/charannyk06/conductor-oss/issues
- Pull Requests: https://github.com/charannyk06/conductor-oss/pulls
- CI: https://github.com/charannyk06/conductor-oss/actions/workflows/ci.yml
- NPM Package: https://www.npmjs.com/package/conductor-oss

---

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
| Multiple agents | Clipboard juggling | Vendor lock-in | **Claude Code, Codex, Gemini — pick any** |
| Context isolation | Manual branches | Varies | **Git worktree per task** |
| PR lifecycle | Manual | Partial | **Full: open → CI → review → merge** |
| Database required | — | Often | **Never — flat files only** |
| Cost | Subscription | Subscription | **Free + your API keys** |

---

## Demo

<details open>
<summary><strong>Watch the 5-minute end-to-end demo</strong> — task → agent → PR → board update</summary>

<br>

### 1. Add a task in Obsidian Kanban
Type a task in the Inbox column → Conductor auto-tags it with agent/project/type.

<p align="center">
  <img src="docs/demo/01-add-task.gif" width="200" style="max-width: 200px; height: auto;" alt="Add task to Inbox" />
</p>

### 2. Agent dispatches and works autonomously
Drag to "Ready to Dispatch" → agent spawns in isolated git worktree → card moves to In Progress.

<p align="center">
  <img src="docs/demo/02-auto-dispatch.gif" width="200" style="max-width: 200px; height: auto;" alt="Auto dispatch" />
</p>

### 3. Live terminal streaming
Watch the agent work in real-time through the web dashboard.

<p align="center">
  <img src="docs/demo/03-live-terminal.gif" width="200" style="max-width: 200px; height: auto;" alt="Live terminal streaming" />
</p>

### 4. Dashboard overview
Track all sessions across projects — active, completed, cost estimates.

<p align="center">
  <img src="docs/demo/04-dashboard.gif" width="200" style="max-width: 200px; height: auto;" alt="Dashboard overview" />
</p>

### 5. Agent creates PR on GitHub
Agent commits, pushes, opens a PR — board card updates with PR link.

<p align="center">
  <img src="docs/demo/05-pr-creation.gif" width="200" style="max-width: 200px; height: auto;" alt="PR creation" />
</p>

📹 Full demo (5 min)

<p align="center">
  <img src="docs/demo/full-demo.gif" width="260" style="max-width: 260px; height: auto;" alt="Full demo overview" />
</p>



</details>

---

## Quick Start

```bash
# 1. Install
npm install -g conductor-oss
# or: npx conductor-oss init

# 2. Scaffold a project
mkdir my-project && cd my-project
co init

# 3. Edit conductor.yaml — set your project path + GitHub repo
# (takes 30 seconds)

# 4. Start the orchestrator
co start
```

Open `CONDUCTOR.md` in your editor (or Obsidian), write a task in **Ready to Dispatch**, save — done.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) · `brew install node` |
| tmux | any | `brew install tmux` · `apt install tmux` |
| GitHub CLI | any | `brew install gh` then `gh auth login` |
| An AI agent | — | See below |

**Pick one agent (or all three):**

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
npm install -g @openai/codex               # OpenAI Codex
npm install -g @google/gemini-cli          # Gemini CLI
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
 │  Agent Process           │  Claude Code / Codex / Gemini
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

---

## Features

| Feature | Status |
|---------|--------|
| 3 frontier agents — Claude Code, Codex, Gemini CLI | ✅ |
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

projects:
  my-app:
    path: ~/projects/my-app       # path to your git repo
    repo: your-org/my-app         # GitHub org/repo
    agent: claude-code            # "claude-code" | "codex" | "gemini"
    agentConfig:
      model: claude-sonnet-4-6    # any model the agent supports
      permissions: skip           # fully autonomous (no prompts)
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
- `spawn_task` — create and dispatch a new agent task
- `list_sessions` — list active sessions and their status
- `get_session` — get details and terminal output for a session
- `kill_session` — terminate a running session

---

## Webhook API

Trigger tasks programmatically via HTTP or GitHub webhooks:

```bash
# Trigger a task via HTTP
curl -X POST http://localhost:4747/webhook/http \
  -H "Content-Type: application/json" \
  -d '{"task": "fix the auth bug", "project": "my-app", "agent": "claude-code"}'

# Configure GitHub to send PR/issue events → auto-create tasks
# In your GitHub repo: Settings → Webhooks → Add webhook
# Payload URL: http://your-host:4747/webhook/github
# Secret: your-webhook-secret (set WEBHOOK_SECRET env var)
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/http` | POST | Trigger a task directly |
| `/webhook/github` | POST | GitHub events → tasks (HMAC-verified) |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions/:id` | GET | Session detail + terminal output |

---

## CLI Reference

```bash
co init                          # Scaffold CONDUCTOR.md + conductor.yaml
co start                         # Start orchestrator + dashboard
co list                          # List all active sessions
co spawn <project> "<task>"      # Manually dispatch a session
co status                        # Status overview
co attach <session-id>           # Attach to tmux session
co kill <session-id>             # Kill a session
co dashboard                     # Open web dashboard in browser
co mcp                           # Start MCP server (stdio)
```

---

## Plugin Architecture

Every component is a swappable plugin. Conductor ships with batteries included, but you can add your own:

| Slot | Built-in | Interface |
|------|----------|-----------|
| **Agent** | `claude-code`, `codex`, `gemini` | `AgentPlugin` |
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

This is a **15-package pnpm monorepo**:

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
