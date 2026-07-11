# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-agent skills tab** — the dashboard now installs official skill bundles for Claude Code, Codex, Gemini, Amp, Cursor CLI, OpenCode, Droid, Qwen Code, CCR, and GitHub Copilot, and the launcher forwards backend URL env vars into the web app automatically.
- **Terminal validation coverage** — regression tests now cover terminal snapshot restore assembly, terminal route wiring, remote transport fallback gating, and frontend terminal helper behavior for mobile and remote flows.
- **Terminal benchmark hooks** — terminal connection, snapshot, and resize endpoints now emit `Server-Timing` plus terminal-specific diagnostic headers for repeatable benchmark capture.
- **Terminal rollout docs** — added Phase 2 rollout notes, a manual QA checklist, and a sign-off matrix for desktop, phone, and private-remote terminal validation.

### Changed

- **Safer agent permissions by default** — newly scaffolded repositories retain each agent's normal permission and approval behavior; automatic approval remains available as an explicit opt-in.
- **Release and deployment verification** — native artifacts now report the product release version and ship with checksums, a source dependency SBOM, and GitHub provenance attestations; relay rollout uses a restricted SSH forced command and an exact-build ready health response.
- **Independent preview rollouts** — preview-worker images now deploy by immutable digest through a main-only protected environment, prove Chromium sandbox startup, and expose exact build identity before promotion.
- **Security gates** — dependency review and configured Strix scans are blocking, with expanded Dependabot coverage for Rust, JavaScript, Go, Python, and Actions.
- **Bounded remote services** — relay connections and queued bytes now have global, user, channel, and connection quotas; preview HTTP and bridge reads use absolute deadlines and aggregate buffering limits.

### Fixed

- **Authorization invariants** — authenticated `HEAD` requests follow the same role checks as their corresponding `GET` routes, and skill deletion rejects empty or escaping paths.
- **Relay lifecycle safety** — relay ownership, reconnect generations, persistence ordering, and pending terminal lifecycles are bounded and consistent.
- **Preview lifecycle safety** — browser allocation is capacity-safe and timed-out work is cancelled without leaving untracked sessions.
- **Recoverable production updates** — relay state is snapshotted transactionally, failed relay/preview candidates roll back through public health, and release retries reuse the exact npm artifact bytes already published.
- **Sandboxed preview rollout** — the production worker retains only Chromium's required `SYS_ADMIN` and `SYS_CHROOT` capabilities, allowing the browser sandbox smoke test to pass without disabling `no-new-privileges` or the read-only container boundary.
- **Relay state migration** — the protected rollout command securely migrates the known legacy `/data/relay-state.json` volume layout to the canonical state path without losing device ownership or weakening rollback.

## [0.61.11] - 2026-07-02

### Changed

- Internal maintenance and tooling updates; no user-facing product change.

## [0.61.10] - 2026-07-01

### Security

- Removed direct unauthenticated ttyd tunnel URLs from terminal session responses.
- Required administrator access for preference updates and the action guard token for dispatcher binding updates.

## [0.1.0] - 2026-03-01

> Historical initial-release snapshot. Current runtime, storage, packaging, and plugin architecture is documented in the README and source tree above.

### Added

- **Core orchestrator** — board watcher, session manager, lifecycle manager
- **3 agent plugins** — Claude Code, OpenAI Codex, Google Gemini CLI
- **Kanban board integration** — Obsidian/markdown CONDUCTOR.md boards
- **Automatic task enhancement** — AI-powered tag inference (#agent/, #project/, #type/, #priority/)
- **Git worktree isolation** — each session runs in its own worktree + branch
- **tmux runtime** — agents run in tmux sessions with full terminal capture
- **GitHub integration** — PR creation, CI monitoring, review routing, issue tracking
- **Web dashboard** — real-time session view, live terminal, cost tracking
- **MCP server** — expose Conductor as MCP server for Cursor/Claude Desktop (`co mcp-server`)
- **Webhook triggers** — HTTP + GitHub webhook → automatic kanban task creation
- **Per-project MCP config** — configure MCP servers per project in conductor.yaml
- **Discord + desktop notifications** — alert on session completion, CI failure, etc.
- **CLI** — `co init`, `co start`, `co list`, `co spawn`, `co status`, `co attach`, `co kill`
- **Plugin architecture** — 7 extensible slots (agent, runtime, workspace, scm, tracker, notifier, terminal)
- **15-package monorepo** — TypeScript, pnpm workspaces, clean build pipeline

### Security

- No database — flat file state, zero SQL injection surface
- No cloud dependency — runs entirely local
- Agent isolation via git worktrees
- Optional Clerk auth for dashboard
- Webhook HMAC-SHA256 signature verification
- MCP server on stdio (no network exposure)

[0.1.0]: https://github.com/charannyk06/conductor-oss/releases/tag/v0.1.0
[0.61.10]: https://github.com/charannyk06/conductor-oss/releases/tag/v0.61.10
[0.61.11]: https://github.com/charannyk06/conductor-oss/releases/tag/v0.61.11
