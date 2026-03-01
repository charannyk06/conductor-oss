# Contributing to Conductor OSS

Thank you for your interest in contributing! Conductor OSS is a 15-package pnpm monorepo written in TypeScript. This guide covers everything you need to get up and running.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Commit Convention](#commit-convention)
- [PR Process](#pr-process)
- [Architecture Overview](#architecture-overview)
- [Plugin Development](#plugin-development)

---

## Development Setup

### Prerequisites

- Node.js ≥ 18
- pnpm ≥ 9 (`npm install -g pnpm`)
- tmux (`brew install tmux` or `apt install tmux`)
- GitHub CLI (`brew install gh` then `gh auth login`)

### Clone and build

```bash
git clone https://github.com/charannyk06/conductor-oss.git
cd conductor-oss
pnpm install
pnpm build
```

### Run locally against a test project

```bash
# Create a scratch project
mkdir -p /tmp/conductor-test && cd /tmp/conductor-test

# Point to your local build
node ~/conductor-oss/packages/cli/dist/index.js init

# Edit the generated conductor.yaml with a real project path
# Then start the orchestrator
node ~/conductor-oss/packages/cli/dist/index.js start
```

### Useful commands

```bash
pnpm build          # Build all packages (excluding web)
pnpm typecheck      # Type-check without emitting JS
pnpm clean          # Remove all dist/ directories
```

---

## Running Tests

```bash
# Run all tests (where test scripts exist)
pnpm -r test

# Run tests for a specific package
pnpm --filter @conductor-oss/core test
```

> Most packages are integration-tested by running them against a real project. Unit tests are in `*.test.ts` files alongside source files.

---

## Code Style

- **TypeScript strict mode** — no implicit `any`, `strictNullChecks` on
- **No `any` types** without an explanatory comment
- **Functional style** — prefer small, pure functions over classes
- **Console logs** prefixed with `[package-name]` (e.g. `[core]`, `[cli]`)
- **Imports** — use `node:` prefix for Node built-ins (e.g. `node:fs`, `node:path`)
- **ESM only** — all packages use `"type": "module"`, no CommonJS

Format with your editor's TypeScript settings — there is no auto-formatter enforced at the repo level yet.

---

## Commit Convention

Conductor uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]
```

Types:
- `feat` — new user-facing feature
- `fix` — bug fix
- `chore` — tooling, deps, config
- `refactor` — code change with no behavior change
- `docs` — documentation only
- `test` — adding or fixing tests
- `ci` — CI/CD changes

Examples:
```
feat(core): add retry logic for failed agent sessions
fix(cli): correct pnpm filter syntax for workspace commands
chore(deps): bump typescript to 5.8
docs: add webhook API reference to README
```

---

## PR Process

1. **Fork** the repo and create a feature branch from `main`
2. **Make your changes** — keep PRs focused (one thing per PR)
3. **Build and typecheck** — `pnpm build && pnpm typecheck` must pass clean
4. **Open a PR** — use the PR template and fill in all sections
5. **Wait for CI** — all matrix builds must pass
6. **Code review** — at least one maintainer review required before merge

Squash merging is preferred for clean history.

---

## Architecture Overview

```
conductor-oss/
├── packages/
│   ├── core/                  # Central orchestration logic
│   │   ├── src/board/         # Board watcher (file → tasks)
│   │   ├── src/sessions/      # Session manager (task → agent process)
│   │   └── src/lifecycle/     # Lifecycle manager (CI, review, merge polling)
│   │
│   ├── cli/                   # `co` / `conductor-oss` binary
│   │   └── src/commands/      # One file per command (init, start, list, ...)
│   │
│   ├── web/                   # Next.js 14 dashboard (App Router)
│   │   └── src/app/           # Dashboard routes and components
│   │
│   └── plugins/               # All extension points
│       ├── agent-*/           # Agent plugins (claude-code, codex, gemini)
│       ├── runtime-*/         # Runtime plugins (tmux)
│       ├── workspace-*/       # Workspace plugins (worktree)
│       ├── scm-*/             # SCM plugins (github)
│       ├── tracker-*/         # Issue tracker plugins (github)
│       ├── notifier-*/        # Notification plugins (discord, desktop)
│       ├── terminal-*/        # Terminal streaming (terminal-web)
│       ├── mcp-server/        # MCP server (stdio)
│       └── webhook/           # HTTP + GitHub webhook receiver
```

**Data flow:**
1. `Board Watcher` reads `CONDUCTOR.md`, detects tasks in the "Ready to Dispatch" column
2. `Session Manager` creates a session record (`~/.conductor/<session-id>/`) and invokes the configured `AgentPlugin` + `RuntimePlugin`
3. The agent runs inside a git `worktree` (provided by `WorkspacePlugin`)
4. `Lifecycle Manager` polls the SCM plugin for PR status, CI results, and review approvals
5. As state changes, the board card in `CONDUCTOR.md` is updated, and the web dashboard receives live updates via SSE

**State storage:** All session state lives in `~/.conductor/<session-id>/state` as `key=value` pairs. No database.

---

## Plugin Development

Each plugin is a regular npm package that exports a default object implementing one of the plugin interfaces defined in `@conductor-oss/core`.

### Example: Custom Agent Plugin

```typescript
// packages/plugins/agent-my-custom/src/index.ts
import type { AgentPlugin, AgentSession } from '@conductor-oss/core';

const plugin: AgentPlugin = {
  name: 'my-custom',
  async spawn(session: AgentSession): Promise<void> {
    // Launch your agent process here
    // session.workdir = the git worktree path
    // session.task = the task description
    // session.config = agentConfig from conductor.yaml
  },
  async kill(session: AgentSession): Promise<void> {
    // Terminate the agent process
  },
};

export default plugin;
```

### Registering your plugin

```yaml
# conductor.yaml
projects:
  my-app:
    agent: my-custom   # matches the plugin name
```

Conductor resolves plugins by looking for `conductor-plugin-<name>` or `@conductor-oss/plugin-<name>` in your `node_modules`.

See the existing plugins (`agent-claude-code`, `runtime-tmux`) for real examples.

---

## Reporting Issues

Open an issue with:
- Your OS and Node.js version
- `conductor.yaml` (redact repo URLs if private)
- Relevant log output from `~/.conductor/` or the terminal
- The exact `co` command that triggered the issue
