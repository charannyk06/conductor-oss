# Conductor Bridge — Product Requirements Document

## Status
Draft — 2026-03-19

> Archive note
> This is a historical planning document. The shipped product has since evolved into a local-first Rust + Next.js app with a multi-agent Skills tab and launcher-backed dashboard/backend env wiring. Keep the flow diagrams below as context, not as source-of-truth implementation.

---

## 1. Overview

**What this document describes**

Conductor Bridge: a feature that lets users run the full Conductor development environment on their local machine and access it from any browser, anywhere in the world. No cloud storage. No data leaves the user's machine unless explicitly shared. The cloud relay is a dumb pipe — it passes encrypted bytes and knows nothing about sessions, files, or agent state.

**One-line pitch**

> Your development environment, accessible from any browser. Your code never leaves your machine.

---

## 2. Product Vision

A developer downloads one binary, runs one command, logs in with GitHub OAuth, and opens a browser to access their full development environment from anywhere.

```
1. User installs conductor-bridge
2. Runs: conductor bridge connect
3. Opens browser to conductor.app
4. Authenticates with GitHub
5. Dashboard shows their laptop as "connected"
6. User adds a workspace (native folder picker opens)
7. Picks ~/projects/shadower
8. Clicks "New session" → selects a coding agent → full terminal opens
9. All data stays on laptop. All agents run on laptop.
10. User travels, opens phone, opens conductor.app
11. Session still running. Terminal still live. Files still local.
```

**Privacy as a feature:** The cloud relay never stores session data, file metadata, or agent output. It cannot decrypt WebSocket frames. All traffic is encrypted in transit. The relay is mathematically unable to see what files exist on the laptop. Users can audit the bridge binary (open source MIT). The relay can be self-hosted on any VPS.

---

## 3. User Flows

### Flow 1: First-time setup

```
User downloads conductor-bridge
User runs: conductor bridge connect
  → Bridge shows: "Open conductor.app to authenticate"
  → Bridge displays short-lived token (5 min)
User opens conductor.app/connect
  → GitHub OAuth login
  → Paste token
  → Bridge connects to conductor.app
  → Dashboard shows: "Laptop connected"
User clicks "Add workspace"
  → Native folder picker opens
  → User selects ~/projects/shadower
  → Dashboard adds workspace
Setup complete. No account creation. No email. No password.
```

### Flow 2: Daily use

```
conductor bridge
  → Bridge connects (already authenticated)
  → Dashboard shows "Online"
Opens conductor.app
  → Already logged in
  → Dashboard shows workspace and active sessions
Starts new session: ~/projects/shadower, selected agent
  → Terminal opens in browser (ttyd iframe)
  → Selected agent runs on laptop, reads/writes ~/projects/shadower
  → Output streams to browser in real-time
Closes laptop, goes to bed
  → Session keeps running
```

### Flow 3: Mobile access

```
Opens conductor.app on phone
  → Dashboard responsive, mobile-friendly
  → Shows active sessions
  → Taps the session
  → Full terminal opens (ttyd iframe, touch-friendly)
  → Can watch the selected agent writing files
  → Can send commands (Ctrl+C to stop)
```

### Flow 4: Bridge goes offline

```
Laptop sleeps → Bridge drops → Dashboard shows "Offline"
Laptop wakes → Bridge reconnects → Dashboard shows "Online"
Sessions resume. Terminal state restored.
If rebooted: agents killed, sessions show "Stopped"
```

### Flow 5: Share a session

```
Clicks "Share session"
  → Dashboard generates read-only link (2 hours)
  → Link sent to colleague
Colleague opens link
  → Read-only terminal view
  → Cannot send input
Link expires or user revokes it
```

---

## 4. Architecture

### System components

```
LAPTOP                                    CONDUCTOR.APP              BROWSER
                                           (cloud, stateless)         (anywhere)
                                           
conductor-bridge ──WSS────────────────► relay-server ──────────► dashboard
     │                                         │                    ▲
     │ localhost HTTP                          │                    │
     ▼                                         │                    │
conductor-backend                           │                  WSS
(SQLite, agents,                            │                    │
ttyd, filesystem)                          │                    │
                                            │                    │

Relay: WebSocket server, JWT auth, frame forwarding, zero storage
Dashboard: Next.js, GitHub OAuth, session list, ttyd viewer, settings
```

### The relay protocol

Four channel types over a single WebSocket connection:

**Terminal:** Browser ↔ Dashboard ↔ Relay ↔ Bridge ↔ ttyd ↔ PTY ↔ Agent
The relay proxies raw WebSocket frames. No awareness of terminal protocol.

**Session management:** Browser → Dashboard → Relay → Bridge → Conductor Backend (HTTP)
Bridge proxies HTTP to localhost:4749. Responses flow back.

**File browsing:** Browser → Dashboard → Relay → Bridge → File system
Bridge reads local filesystem on demand, returns JSON tree. Relay passes bytes without awareness.

**Bridge status:** Bridge heartbeats, dashboard shows online/offline.

### Authentication

**Browser → Dashboard:** GitHub OAuth → JWT session cookie.

**Bridge → Relay:**
1. Bridge shows short-lived token (5 min)
2. User pastes in dashboard at conductor.app/connect
3. Dashboard sends token + GitHub JWT to relay
4. Relay verifies JWT (GitHub API or cached JWKS)
5. Relay stores: GitHub user ID → bridge connection

**Browser → Relay:**
1. Browser connects to relay WebSocket with JWT
2. Relay verifies JWT
3. Relay wires browser to the user's bridge

### Multi-bridge support

A user can connect multiple bridges (laptop + desktop). Each bridge has a unique ID. Sessions are tied to the bridge that created them. Offline bridges show "offline" but don't lose data.

### Self-hosted relay

```bash
docker run -p 443:8080 -e RELAY_JWT_SECRET=... conductor-relay
```

The bridge points to `wss://your-relay.example.com/bridge`. Everything else identical.

---

## 5. Data Architecture

### What lives where

| Data | Location |
|------|----------|
| Session history | Laptop SQLite |
| Session metadata | Laptop SQLite |
| Agent output | Laptop memory/SQLite |
| Workspace file contents | Laptop filesystem |
| File path names | Laptop filesystem |
| Agent credentials | Laptop env vars |
| Bridge tokens | Laptop disk (encrypted) |
| GitHub OAuth token | Laptop disk (encrypted) |
| GitHub user ID | Relay memory + dashboard DB |
| Audit log | Dashboard PostgreSQL |
| Session data, file paths, agent output | **Never on relay or dashboard** |

### What the relay cannot see

Even with full access to the relay VPS:
- Session contents (encrypted WebSocket frames)
- File names or directory structure
- What agents are running
- Workspace paths
- Agent output

Architecturally enforced. The relay has no decryption keys.

---

## 6. Security

### Threats and mitigations

| Threat | Mitigation |
|--------|-------------|
| Stolen access URL | GitHub OAuth required — no URL-only access |
| Bridge token theft | Short-lived (7 days), revocable from dashboard |
| Laptop theft | Disk encryption (FileVault/BitLocker), remote revocation |
| Malicious relay operator | WSS encryption, relay has no session keys |
| Compromised relay VPS | Stateless restart, no data at rest |

### Security checklist

- [ ] Bridge binary open source (MIT) — users audit what runs with their credentials
- [ ] GitHub OAuth tokens stored encrypted on laptop
- [ ] Bridge JWT expires in 7 days, refreshable
- [ ] Session sharing links read-only, time-limited, revocable
- [ ] Relay is stateless
- [ ] All WebSocket traffic over WSS (TLS 1.3)
- [ ] Relay rate-limits per GitHub user ID
- [ ] Bridge sandboxed to workspace directories
- [ ] Professional security audit before launch

---

## 7. Feature Scope

### v1 (MVP)

**Must have:**
- Bridge binary: macOS (arm64 + x64), Linux (x64)
- GitHub OAuth login
- `conductor bridge connect` — one command to connect
- Session list (active sessions from local SQLite in browser)
- Terminal viewer (ttyd iframe, full PTY, resize, input)
- Session sharing (read-only temporary link)
- Bridge status indicator (online/offline)
- One workspace per bridge
- Responsive mobile terminal UI

**Not in v1:**
- File browser (v2)
- Workspace folder picker (v2)
- Multi-bridge support (v2)
- Session history in cloud (v2)
- Team features (v3)
- Usage billing (v3)
- Self-hosted relay tooling (v3)
- Windows bridge (v2)

### v2
- Workspace folder picker (native OS dialog)
- Read-only file browser in dashboard
- Multi-bridge (laptop + desktop + cloud VM)
- Windows bridge binary
- Session history synced for display

### v3
- Team workspaces (shared sessions, RBAC)
- Usage metrics and billing
- Self-hosted relay Docker image
- Collaborative terminal editing

---

## 8. Non-Goals

- **Cloud compute.** Agents run on the user's laptop. Not competing with Codespaces.
- **Data storage.** Session history and files stay on the laptop. Not a backup service.
- **Team infrastructure.** v1 is single-user.
- **Agent hosting.** We orchestrate agents on the user's hardware. We don't run them.
- **Code review.** Not a GitHub replacement.

---

## 9. Success Metrics

### Launch
- Time from download to first browser session (target: < 5 minutes)
- Bridge connection success rate (target: > 95%)
- Terminal latency (target: < 300ms keystroke round-trip)

### Retention
- 30-day active bridge rate (target: > 60%)
- Sessions per bridge per week (target: > 3)
- Workspace addition rate (target: > 50% in week 1)

### Technical
- Relay uptime (target: > 99.9%)
- Bridge reconnect after dropout (target: > 98%)
- Zero data loss on reconnect (target: 100%)

---

## 10. Open Questions

1. **Clipboard sync.** Copy on phone, paste into laptop terminal. Requires bridge audio/clipboard channel. Not in v1.

2. **Audio notifications.** Agent completion alerts on mobile. Does bridge need an audio channel? Not in v1.

3. **Git integration.** Dashboard shows git status (branch, dirty files). Via bridge git calls or agent output parsing? v2.

4. **Agent credential management.** How does user configure agent credentials from dashboard? Edit laptop `.env` directly? Dashboard settings panel? v2.

5. **Offline dashboard.** If conductor.app is down, show cached session history? Not in v1.

---

## 11. Technical Appendix

### Bridge responsibilities

```
conductor-bridge
├── CLI: parse args, handle commands
├── Auth: GitHub OAuth JWT, token storage
├── Tunnel: persistent outbound WebSocket to relay
├── Proxy: HTTP proxy for Conductor backend (localhost:4749)
├── File browser: local filesystem read (sandboxed to workspaces)
└── Status: heartbeat, bridge metadata
```

Bridge does NOT: run agents, manage sessions, store history, parse terminal output.

### Relay responsibilities

```
conductor-relay
├── WebSocket server (TLS, RFC 6455)
├── JWT verification (GitHub OAuth)
├── Connection multiplexer (1 bridge ↔ N browser connections)
├── Frame forwarding (bidirectional, opaque bytes)
├── Rate limiting (per user ID)
└── Audit logging (connection metadata only)
```

Relay does NOT: store sessions, parse frames, know about files or agents, access filesystem.

### WebSocket frame format

```typescript
// Browser → Bridge
type Outbound =
  | { type: "terminal_resize"; cols: number; rows: number }
  | { type: "terminal_input"; data: string }
  | { type: "api_request"; id: string; method: string; path: string; body?: unknown }
  | { type: "file_browse"; path: string }
  | { type: "ping" };

// Bridge → Browser
type Inbound =
  | { type: "terminal_output"; data: string }
  | { type: "api_response"; id: string; status: number; body: unknown }
  | { type: "file_tree"; path: string; entries: FileEntry[] }
  | { type: "bridge_status"; hostname: string; os: string; connected: boolean }
  | { type: "pong" };
```

### Conductor backend changes

The existing backend (localhost:4749) needs **zero changes** for v1. The bridge proxies HTTP requests unchanged. ttyd integration is already in place.

### Distribution

**Bridge:**
- GitHub Releases (macOS arm64, macOS x64, Linux x64)
- Homebrew: `brew install conductor-oss/tap/bridge`
- Install script: `curl https://conductor.app/install.sh | sh`

**Relay:**
- Docker: `docker run -p 443:8080 conductor-oss/relay`
- Binary: download from GitHub Releases

**Dashboard:**
- Vercel (static + serverless functions)
- Domain: conductor.app
