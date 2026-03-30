# Strix Security Testing Instructions

This file provides context for Strix security scans against Conductor OSS.

## What Conductor Is
Conductor is an open-source multi-agent orchestrator. It runs a Rust backend and a Next.js dashboard that control AI coding agents (Claude Code, Codex, OpenCode, etc.). The app exposes an HTTP API, SSE streaming, a relay for remote devices, and a server-side Puppeteer preview browser.

## Scope of Scan
- Focus on the HTTP API surface
- Focus on the preview/browser flows
- Focus on SSE and WebSocket endpoints
- Focus on relay onboarding/claim endpoints if reachable
- Focus on the dashboard frontend for XSS, CSRF, and clickjacking vectors
- Focus on auth bypass and privilege escalation between viewer/operator/admin roles
- Do NOT focus on Docker/container hardening or OS-level issues

## Key Attack Surface (for scan focus)
1. **Dashboard API routes** - `/api/sessions/*`, `/api/projects/*`, `/api/dispatcher/*`, `/api/filesystem/*`, `/api/attachments/*`
2. **Preview browser** - server-side Puppeteer that auto-connects to discovered URLs. Can be abused for SSRF if non-local origins are reachable.
3. **SSE streaming** - `/api/sessions/:id/feed/stream`, `/api/projects/:id/dispatcher/feed/stream` - check for auth bypass and data leakage.
4. **Terminal/ttyd** - `/api/sessions/:id/terminal/ttyd/ws` - check for auth bypass on live shell sessions.
5. **Relay claim endpoint** - if reachable, check for rate limiting, queue exhaustion, and unauthorized pairing.
6. **Filesystem browser** - `/api/filesystem/*` - check for path traversal beyond workspace boundaries.
7. **Attachments** - `/api/attachments/*` - check for unauthorized upload/download.

## Auth Model
- Backend: requires auth when remote (`require_auth_when_remote` middleware). Routes without explicit guards default to Viewer (GET) or Operator (non-GET).
- Dashboard: Clerk or Cloudflare Access when hosted; local unauth on loopback by default.
- Preview: POST commands require Operator role. GET status requires Viewer role.

## Known Risks To Validate
- TM-001: Relay claim endpoint spam (DoS via pending claim queue)
- TM-002: SSRF via preview auto-connect to attacker-controlled origins
- TM-003: Cross-session browser state leakage via shared Puppeteer browser context
- TM-004: Terminal token replay from logs

## Do Not Test
- Agent execution (actual LLM calls)
- Upstream model provider security
- Production secrets or tokens
- Destructive actions against real deployments

## Non-Interactive Mode
Run with `-n` flag for CI/CD integration:
```
strix -n -t ./ --scan-mode quick --instruction-file strix-instructions.md
```
