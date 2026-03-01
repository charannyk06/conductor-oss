# Conductor

**Markdown-native AI agent orchestrator.** Write tasks in a kanban board — Conductor dispatches AI agents, manages git worktrees, tracks PRs through CI/review/merge, and updates your board automatically.

```markdown
## Ready to Dispatch
- [ ] fix the login bug #agent/claude-code #project/my-app

## In Progress
- [ ] fix the login bug · session:ab-1 · 🟢 working · [View](http://localhost:4747)

## Review
- [x] add dark mode · session:dm-1 · PR #42 · ✅ CI passed · awaiting review
```

Write a task → agent spawns → PR opens → CI runs → board updates. Automatically.

---

## Install

```bash
npm install -g conductor-oss
```

**That's it.** Then:

```bash
mkdir my-project && cd my-project
co init          # creates CONDUCTOR.md + conductor.yaml
co start         # start the orchestrator + dashboard
```

Open `CONDUCTOR.md`, write a task in **Ready to Dispatch**, save — done.

### Prerequisites

| Tool | Install |
|------|---------|
| Node.js 20+ | [nodejs.org](https://nodejs.org) or `brew install node` |
| tmux | `brew install tmux` or `apt install tmux` |
| GitHub CLI | `brew install gh` then `gh auth login` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| — or Codex | `npm install -g @openai/codex` |
| — or Gemini | `npm install -g @google/gemini-cli` |

Or use the one-liner:
```bash
curl -fsSL https://raw.githubusercontent.com/conductor-oss/conductor/main/install.sh | bash
```

---

## How It Works

```
CONDUCTOR.md (kanban board in your editor/Obsidian)
      |
      v
Board Watcher — detects tasks in "Ready to Dispatch"
      |
      v
Session Manager — spawns agent in tmux + git worktree
      |
      v
Agent (Claude Code / Codex) — writes code, opens PR
      |
      v
Lifecycle Manager — polls CI, reviews, merge status
      |
      v
Board + Dashboard — live updates, terminal, cost tracking
```

### Board Columns

| Column | Meaning |
|--------|---------|
| **Inbox** | Rough ideas — auto-tagged by AI within 20s |
| **Ready to Dispatch** | Tagged tasks waiting to be picked up |
| **Dispatching** | Agent is spawning |
| **In Progress** | Agent working |
| **Review** | PR open — agent done, your turn |
| **Done** | Merged ✅ |
| **Blocked** | Needs manual intervention |

### Task Format

```markdown
- [ ] description of the task #agent/claude-code #project/my-app #type/feature #priority/high
```

Or just write rough text in **Inbox** — Conductor auto-formats it.

---

## Configuration

`conductor.yaml` (created by `co init`):

```yaml
port: 4747

projects:
  my-app:
    path: ~/projects/my-app
    repo: your-org/my-app
    agent: claude-code           # "claude-code", "codex", or "gemini"
    agentConfig:
      model: claude-sonnet-4-6
      permissions: skip          # fully autonomous
    workspace: worktree
    runtime: tmux
    scm: github
```

Add as many projects as you want. Each project gets its own board column and isolated git worktrees.

---

## CLI Commands

```bash
co init                          # Scaffold CONDUCTOR.md + conductor.yaml
co start                         # Start orchestrator + dashboard
co list                          # List all active sessions
co spawn my-app "fix login bug"  # Manually spawn a session
co status                        # Status overview
co attach <session-id>           # Attach to tmux session
co kill <session-id>             # Kill a session
co dashboard                     # Open web dashboard
```

---

## Web Dashboard

Starts automatically with `co start` at `http://localhost:4747`.

- All active sessions with real-time status
- CI / review / merge tracking
- Live terminal output per session
- Cost tracking
- Send messages to agents, kill or restore sessions

Optional: Add [Clerk](https://clerk.com) auth by setting keys in `packages/web/.env.local` (see `.env.example`). Without Clerk keys, dashboard is open (local-only).

---

## Plugin Architecture

Every component is swappable:

| Slot | Built-in | Add your own |
|------|----------|-------------|
| Agent | `claude-code`, `codex`, `gemini` | Implement `AgentPlugin` |
| Runtime | `tmux` | Implement `RuntimePlugin` |
| Workspace | `worktree` | Implement `WorkspacePlugin` |
| SCM | `github` | Implement `ScmPlugin` |
| Tracker | `github` | Implement `TrackerPlugin` |
| Notifier | `discord`, `desktop` | Implement `NotifierPlugin` |

---

## Architecture

```
conductor/
├── packages/
│   ├── core/                     # Session manager, lifecycle, board watcher
│   ├── cli/                      # co CLI (init, start, list, spawn, etc.)
│   ├── web/                      # Next.js dashboard
│   └── plugins/
│       ├── agent-claude-code/    # Claude Code agent
│       ├── agent-codex/          # OpenAI Codex agent
│       ├── runtime-tmux/         # tmux runtime
│       ├── workspace-worktree/   # Git worktree isolation
│       ├── scm-github/           # GitHub PR/CI/review
│       ├── tracker-github/       # GitHub issue tracking
│       ├── notifier-discord/     # Discord notifications
│       ├── notifier-desktop/     # macOS/Linux desktop notifications
│       └── terminal-web/         # Browser terminal
```

**No database.** Session state is stored as flat `key=value` files in `~/.conductor/`.

---

## Development

```bash
git clone https://github.com/charannyk06/conductor-oss.git
cd conductor
pnpm install
pnpm build

# Run CLI
node packages/cli/dist/index.js init
node packages/cli/dist/index.js start
```

---

## License

[MIT](./LICENSE) — built with ❤️ by the Conductor community.
