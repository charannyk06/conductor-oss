# Contributing to Conductor OSS

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/charannyk06/conductor-oss.git
cd conductor-oss
pnpm install
pnpm build
```

### Running locally

```bash
# Start the dashboard
pnpm dev

# Run tests
pnpm test
pnpm --filter @conductor-oss/core test
pnpm --filter conductor-oss test

# Type check
pnpm typecheck
```

### Project structure

```
packages/
  core/       — shared types, config, board parsing, session management
  cli/        — CLI entrypoint (conductor-oss npm package)
  web/        — Next.js 16 dashboard
  plugins/    — agent, runtime, notifier, workspace, and tracker plugins
scripts/      — release tooling (pack, verify, publish)
```

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm build && pnpm typecheck && pnpm test` to verify
4. Open a pull request against `main`

### Commit messages

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation changes
- `chore:` maintenance, CI, tooling
- `refactor:` code restructuring without behavior change

### What we look for in PRs

- Tests pass (`pnpm test`)
- Types check (`pnpm typecheck`)
- Build succeeds (`pnpm build`)
- Code follows existing patterns (TypeScript, ESM, no default exports in library code)

## Adding a New Agent Plugin

Agent plugins live in `packages/plugins/agent-<name>/`. See `packages/plugins/agent-claude-code/` for the reference implementation.

Each agent plugin exports:
- `manifest` with name, version, description, plugin kind
- `createAgent()` returning an `Agent` with `getLaunchCommand()`, `processName`, `promptDelivery`

## Releases

Releases are triggered manually via the **Release** GitHub Action (`workflow_dispatch`). This:
1. Bumps versions across all packages
2. Builds and tests
3. Runs the full release verification (Puppeteer E2E)
4. Creates a GitHub release with auto-generated notes
5. Publishes to npm with provenance

## Code of Conduct

Be respectful. We're building tools for developers, by developers.

## License

By contributing, you agree that your contributions will be licensed under the project's MIT license.
