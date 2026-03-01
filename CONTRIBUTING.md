# Contributing to Conductor

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/conductor-oss/conductor.git
cd conductor
pnpm install
pnpm build
```

### Run locally

```bash
# Create a test project
mkdir -p /tmp/conductor-test && cd /tmp/conductor-test
node ~/conductor/packages/cli/dist/index.js init
# Edit conductor.yaml with your project paths
node ~/conductor/packages/cli/dist/index.js start
```

### Project Structure

```
packages/
├── cli/          # CLI entry point (`co` / `conductor`)
├── core/         # Board watcher, session manager, lifecycle manager
├── web/          # Next.js dashboard
└── plugins/
    ├── agent-claude-code/     # Claude Code agent integration
    ├── agent-codex/           # Codex agent integration
    ├── notifier-discord/      # Discord notifications
    ├── notifier-desktop/      # macOS desktop notifications
    ├── plugin-runtime-tmux/   # tmux session runner
    ├── scm-github/            # GitHub PR/CI tracking
    ├── terminal-web/          # Web terminal streaming
    ├── tracker-github/        # GitHub issue tracker
    └── workspace-worktree/    # Git worktree isolation
```

### Build

```bash
pnpm build          # Build all 12 packages
pnpm typecheck      # Type-check without emitting
pnpm clean          # Remove all dist/ folders
```

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Run `pnpm build` — must compile clean
4. Open a PR with a clear description

## Reporting Issues

Open an issue with:
- Your OS and Node version
- `conductor.yaml` (redact repo URLs if private)
- Relevant log output from `~/.conductor/` or the terminal

## Code Style

- TypeScript strict mode
- No `any` types without justification
- Console logs prefixed with `[module-name]`
- Plugins implement the `PluginModule` interface
