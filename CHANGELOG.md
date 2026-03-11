# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Terminal validation coverage** — regression tests now cover terminal snapshot restore assembly, terminal route wiring, remote transport fallback gating, and frontend terminal helper behavior for mobile and remote flows.
- **Terminal benchmark hooks** — terminal connection, snapshot, and resize endpoints now emit `Server-Timing` plus terminal-specific diagnostic headers for repeatable benchmark capture.
- **Terminal rollout docs** — added Phase 2 rollout notes, a manual QA checklist, and a sign-off matrix for desktop, phone, and private-remote terminal validation.

## [0.1.0] - 2026-03-01

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
