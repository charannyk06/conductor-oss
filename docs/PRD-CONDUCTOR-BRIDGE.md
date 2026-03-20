# Conductor Bridge — Product Requirements Document

## Status
Draft — 2026-03-19

---

## 1. Overview

**What this document describes**

Conductor Bridge: a feature that lets users run the full Conductor development environment on their local machine (laptop, desktop, workstation) and access it from any browser, anywhere in the world. No cloud storage. No data leaves the user's machine unless explicitly shared. The cloud relay is a dumb pipe — it passes encrypted bytes and knows nothing about sessions, files, or agent state.

**One-line pitch**

> Your development environment, accessible from any browser. Your code never leaves your machine.

**The problem**

Developers today face a forced choice between two bad options:

- **Cloud IDEs** (GitHub Codespaces, Replit, Copilot Workspace) — compute runs on someone else's machine. Your code leaves your device. Your employer or the platform can see everything. Latency is real. Offline work is impossible. Costs scale with usage.

- **Local only** (VS Code, Zed, Neovim) — everything stays private and fast, but you're tethered to your machine. Mobile access is a joke. Pair programming requires screen sharing. You can't check on a long-running agent from your phone.

**The solution**

Conductor Bridge creates a persistent, authenticated tunnel between the user's local machine and the Conductor web dashboard. The dashboard is a hosted web app running in the cloud. The bridge is a tiny daemon running on the user's laptop. The user connects them with one command. Everything real — agents, terminals, files, session history — lives on the laptop. The cloud is only the access layer.

---

## 2. Product Vision

### The experience

A developer downloads one binary, runs one command, logs in with GitHub OAuth, and opens a browser to access their full development environment from anywhere.

```
1. User installs conductor-bridge
2. Runs: conductor bridge connect
3. Opens browser to conductor.app
4. Authenticates with GitHub
5. Dashboard shows their laptop as "connected"
6. User adds a workspace (native folder picker opens)
7. Picks ~/projects/shadower
8. Clicks "New session" → selects Claude Code → full terminal opens
9. All data stays on laptop. All agents run on laptop.
10. User travels, opens phone, opens conductor.app
11. Session still running. Terminal still live. Files still local.
```

### Privacy as a feature

The privacy guarantee is architectural, not policy:

- The cloud relay never stores session data, file metadata, or agent output
- The relay cannot decrypt WebSocket frames — it has no session keys
- All traffic is encrypted in transit (WSS)
- The relay is mathematically unable to see what files exist on the laptop
- Users can audit the bridge binary (open source MIT license)
- The relay can be self-hosted on any VPS — no dependency on conductor.app

This is a meaningfully stronger privacy claim than "we don't sell your data." The architecture makes the claim true regardless of what the company decides.

### The audience

**Primary:** Individual developers who want privacy and flexibility. They work on sensitive projects (proprietary code, research, personal projects). They use multiple devices. They sometimes need mobile access to check on long-running builds or agents.

**Secondary:** Development teams where each developer runs Conductor Bridge on their own machine, sharing sessions through the hosted dashboard. This is a future team feature, not v1.

---

## 3. User Flows

### Flow 1: First-time setup

```
User downloads conductor-bridge (binary, ~20MB)
User runs: conductor bridge connect
  → Bridge starts, shows: "Open conductor.app in your browser to authenticate"
  → Bridge displays a short-lived token (valid 5 minutes)
User opens conductor.app/connect
  → GitHub OAuth login
  → Paste token screen
  → Bridge receives JWT, stores it securely
  → Bridge establishes persistent WebSocket to conductor.app
  → Dashboard shows: "Laptop connected" with hostname and OS
User clicks "Add workspace"
  → Native folder picker opens on laptop
  → User selects ~/projects/shadower
  → Dashboard adds workspace to sidebar
Setup complete. No account creation. No email. No password.
```

### Flow 2: Daily use (laptop at home)

```
User opens terminal on laptop
Runs: conductor bridge
  → Bridge connects to conductor.app (already authenticated)
  → Dashboard shows "Online" status
User opens conductor.app in browser
  → Already logged in (GitHub OAuth session)
  → Dashboard shows their workspace and active sessions
User starts a new session: selects ~/projects/shadower, picks Claude Code
  → Terminal opens in browser (ttyd iframe)
  → Claude Code runs on laptop, reads/writes ~/projects/shadower
  → Agent output streams to browser in real-time
User closes laptop, goes to bed
Session keeps running. Laptop is awake.
```

### Flow 3: Mobile access (phone)

```
User wakes up, picks up phone
Opens conductor.app (mobile Safari/Chrome)
  → Dashboard is responsive, mobile-friendly
  → Shows active sessions
  → Taps on running Claude Code session
  → Full terminal opens (ttyd iframe, touch-friendly)
  → Can watch Claude Code writing files in real-time
  → Can send commands (e.g., Ctrl+C to stop)
User switches to Codex session, reviews diff, approves merge
  → All without touching the laptop
```

### Flow 4: Bridge goes offline

```
Laptop lid closes, sleeps
  → Bridge connection drops
  → Dashboard shows: "Laptop offline" (yellow indicator)
  → Running sessions are still in memory on laptop (paused by OS)
Laptop wakes up, reconnects
  → Bridge reconnects automatically (exponential backoff)
  → Dashboard updates: "Online"
  → Sessions resume
  → Terminal state restored
If laptop was rebooted:
  → Agent processes are killed (expected — no suspend/resume for agents)
  → Dashboard shows sessions as "Stopped"
  → User can restart from session history
```

### Flow 5: Share a session

```
User is pair programming with a colleague
Clicks "Share session" on active terminal
  → Dashboard generates a temporary read-only link (valid 2 hours)
  → Link sent to colleague via Slack
Colleague opens link
  → Read-only terminal view — sees same terminal output
  → Cannot send input (read-only share)
Link expires after 2 hours or user revokes it
```

---

## 4. Architecture

### System components

```
┌──────────────────────────────────────────────────────────────┐
│                      LAPTOP (user's machine)                  │
│                                                               │
│  ┌────────────────────┐                                     │
│  │  Conductor Bridge  │  ← one binary, installed by user     │
│  │  (Rust, ~20MB)     │                                     │
│  └─────────┬──────────┘                                     │
│            │                                                 │
│            │  localhost HTTP                                 │
│            ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Conductor Backend (existing Rust server)                  │ │
│  │  - Session management (SQLite, local)                    │ │
│  │  - Agent spawning (Claude Code, Codex, Gemini, etc.)      │ │
│  │  - ttyd terminal daemon                                 │ │
│  │  - File system access                                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  File system: /Users/charann/projects/...                    │
│  SQLite:       ~/.conductor/conductor.db                       │
│  Credentials:  environment variables, .env files               │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           │  Persistent outbound WSS
                           │  (no inbound ports opened)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      CONDUCTOR.APP (cloud)                    │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Relay Server (Rust, stateless)                           │ │
│  │  - WebSocket server (wss://conductor.app/bridge)          │ │
│  │  - JWT authentication (verify GitHub OAuth token)          │ │
│  │  - Frame forwarding (browser ↔ bridge)                    │ │
│  │  - Connection multiplexing (1 connection, N channels)       │ │
│  │  - Zero storage of session data                           │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Dashboard Web App (Next.js, Vercel)                      │ │
│  │  - GitHub OAuth login                                    │ │
│  │  - Session list / create / resume                        │ │
│  │  - Terminal viewer (ttyd iframe)                         │ │
│  │  - File browser (bridge-proxied)                         │ │
│  │  - Bridge connection status                               │ │
│  │  - Settings and preferences                              │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  User database (minimal):                                     │
│  - GitHub user ID (for auth)                                 │
│  - Bridge registration tokens (hashed)                        │
│  - Audit log (connection timestamps, bytes transferred)        │
│  - Usage metrics (for future billing)                        │
│  - NO session data, NO file paths, NO agent output           │
└──────────────────────────────────────────────────────────────┘
                           │
                           │  Browser WebSocket (WSS)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      BROWSER (any device)                    │
│                                                               │
│  - conductor.app (dashboard)                                   │
│  - GitHub OAuth session (for auth)                           │
│  - Terminal (ttyd iframe)                                     │
│  - File browser (read-only tree)                             │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### The relay protocol

The relay is a WebSocket multiplexer. Four channel types over a single bridge connection:

**Channel 1: Terminal**
```
Browser → Dashboard → Relay → Bridge → ttyd → PTY → Agent
Agent → PTY → ttyd → Bridge → Relay → Dashboard → Browser
```
The relay proxies raw WebSocket frames. It has no awareness of terminal protocol. It doesn't parse ANSI escape codes. It doesn't store terminal output.

**Channel 2: Session management**
```
Browser → Dashboard → Relay → Bridge → Conductor Backend (HTTP)
Backend → Bridge → Relay → Dashboard → Browser
```
Browser makes API calls to the bridge through the relay. Bridge proxies HTTP requests to localhost:4749. Responses flow back the same way.

**Channel 3: File browsing**
```
Browser → Dashboard → Relay → Bridge → File system
File system → Bridge → Relay → Dashboard → Browser
```
Bridge exposes file browsing API over the WebSocket tunnel. Dashboard requests `/browse?path=~/projects/shadower`. Bridge reads local filesystem, returns JSON tree. Relay passes bytes without awareness.

**Channel 4: Bridge status**
```
Bridge → Relay → Dashboard: { type: "status", hostname, os, connected: true }
Dashboard → Relay → Bridge: { type: "ping" } / Bridge: { type: "pong" }
```

### Authentication

**GitHub OAuth (browser → dashboard):**
1. User visits conductor.app → redirects to GitHub OAuth
2. User approves → GitHub redirects with code
3. Dashboard exchanges code for access token → session cookie set with JWT

**Bridge authentication (bridge → relay):**
1. First run: bridge shows a short-lived token (valid 5 minutes)
2. User pastes token in dashboard (at conductor.app/connect)
3. Dashboard sends token to relay along with GitHub OAuth JWT
4. Relay verifies JWT with GitHub's API (or cached JWKS)
5. Relay stores mapping: GitHub user ID → bridge connection
6. All future frames from this bridge are tagged with the GitHub user ID

**WebSocket authentication (browser → relay):**
1. Browser connects to relay's WebSocket endpoint
2. Browser sends JWT in first frame
3. Relay verifies JWT
4. Relay wires browser WebSocket to bridge WebSocket for that user

### Multi-bridge support

A user can connect multiple bridges (laptop + desktop):
```
User A
├── Bridge on laptop (home)
│   └── Workspaces: ~/personal, ~/work
└── Bridge on desktop (office)
    └── Workspaces: ~/office-projects
```
Each bridge has a unique ID. Sessions are tied to the bridge that created them. If a bridge goes offline, its sessions are shown as "offline" but not deleted.

### Self-hosted relay

Users who don't want to use conductor.app can run their own relay:

```bash
docker run -p 443:8080 \
  -e RELAY_JWT_SECRET=... \
  conductor-relay
```

The bridge configuration points to `wss://your-relay.example.com/bridge`. Everything else works identically.

---

## 5. Data Architecture

### What lives where

| Data | Location | Who can access |
|------|----------|----------------|
| Session history | Laptop SQLite | User only |
| Session metadata (IDs, status) | Laptop SQLite | User only |
| Agent output (stdout/stderr) | Laptop memory/SQLite | User only |
| Workspace file contents | Laptop filesystem | User only |
| File path names | Laptop filesystem | User only (proxied on demand) |
| Agent credentials | Laptop env vars | User only |
| Bridge connection tokens | Laptop disk (encrypted) | User only |
| GitHub OAuth token | Laptop disk (encrypted) | User only |
| User ID (GitHub) | Relay memory + dashboard DB | Dashboard only |
| Bridge connection log | Relay memory (transient) | Relay operator |
| Audit log (connections, bytes) | Dashboard PostgreSQL | Dashboard operator |
| Usage metrics | Dashboard PostgreSQL | Dashboard operator |

### What the relay cannot see

Even with full access to the relay VPS:
- Session contents (encrypted WebSocket frames)
- File names or directory structure
- What agents are running
- Workspace paths
- Agent output
- Any data stored on the laptop

Architecturally enforced by end-to-end encryption within the WebSocket tunnel. The relay has no decryption keys.

---

## 6. Security

### Threat model

**Threat 1: Stolen access URL** — Dashboard requires GitHub OAuth session. An attacker without the GitHub session sees only an auth redirect.

**Threat 2: Bridge token theft** — Token is short-lived (7 days), revocable from dashboard settings. Revocation takes effect immediately.

**Threat 3: Laptop theft** — All data is on the laptop (encrypted by FileVault/BitLocker). Bridge can be revoked from another logged-in session.

**Threat 4: Malicious relay operator** — WebSocket frames are encrypted (WSS). Relay has no session keys. No file contents, no session metadata, no agent output visible.

**Threat 5: Compromised relay VPS** — No persistent data (stateless restart loses only connection mappings). Fresh Docker container recovers.

### Security checklist

- [ ] Bridge binary is open source (MIT) — users can audit what runs with their credentials
- [ ] GitHub OAuth tokens stored encrypted on laptop (never plaintext)
- [ ] Bridge connection JWT expires in 7 days, refreshable
- [ ] Session sharing links are read-only, time-limited, revocable
- [ ] Relay is stateless (no session data at rest)
- [ ] All WebSocket traffic over WSS (TLS 1.3)
- [ ] Relay rate-limits connections per GitHub user ID
- [ ] Bridge sandboxed to workspace directories (no arbitrary filesystem access)
- [ ] Professional security audit before launch

---

## 7. Feature Scope

### v1 (MVP)

**Must have:**
- Bridge binary for macOS (arm64 + x64) and Linux (x64)
- GitHub OAuth login
- Bridge connects to relay with one command (`conductor bridge connect`)
- Session list (active sessions from local SQLite, displayed in browser)
- Terminal viewer (ttyd iframe, full PTY support, resize, input)
- Session sharing (read-only temporary link)
- Bridge status indicator (online/offline)
- One workspace per bridge
- Responsive mobile UI for terminal viewing

**Will NOT have in v1:**
- File browser (v2)
- Workspace folder picker (v2)
- Multi-bridge support (v2)
- Session history in cloud (v2)
- Team features (v3)
- Usage billing (v3)
- Self-hosted relay deployment tooling (v3)
- Windows bridge binary (v2)

### v2
- Workspace folder picker (native OS dialog on laptop)
- Read-only file browser in dashboard
- Multi-bridge support (laptop + desktop + cloud VM)
- Session history synced to dashboard for display
- Windows bridge binary

### v3
- Team workspaces (shared session viewing, role-based access)
- Usage metrics and billing (per-bridge monthly minutes)
- Self-hosted relay Docker image + deployment guide
- Collaborative editing (shared terminal)
- Mobile file browser

---

## 8. Non-Goals (Explicitly Not This Product)

- **Cloud compute.** Agents run on the user's laptop. We are not competing with GitHub Codespaces.

- **Data storage.** Session history and files stay on the laptop. We are not a cloud backup service.

- **Team infrastructure.** v1 is single-user.

- **Agent hosting.** We don't run agents. We orchestrate agents on the user's hardware.

- **Code review.** This is not a GitHub replacement.

---

## 9. Success Metrics

### Launch metrics
- Time from download to first session in browser (target: < 5 minutes)
- Bridge connection success rate (target: > 95%)
- Terminal latency (target: < 300ms round-trip for keystroke to echo)
- Sessions created per week (target: establish baseline)

### Retention metrics
- 30-day active bridge rate (target: > 60% of bridges that connect once connect again)
- Sessions per bridge per week (target: > 3)
- Workspace addition rate (target: > 50% of users add a workspace within first week)

### Technical metrics
- Relay uptime (target: > 99.9%)
- Bridge reconnect success after network dropout (target: > 98%)
- Zero data loss on bridge reconnect (target: 100%)

---

## 10. Open Questions

1. **Clipboard access from mobile.** Copy on phone, paste into terminal on laptop. Requires bridging clipboard over the tunnel. Not in v1.

2. **Audio notifications.** Agent completion alerts on mobile. Does the bridge need an audio channel? Not in v1.

3. **Git integration in dashboard.** Git status (branch, dirty files) shown in dashboard. Does dashboard call git on laptop (via bridge) or parse agent output? Likely v2.

4. **Agent credential management.** How does user configure agent credentials from dashboard? Do they edit laptop's `.env` directly? Is there a settings panel for env vars? Likely v2.

5. **Offline-first dashboard.** If conductor.app is down, can the dashboard show cached session history? Not critical for v1.

---

## 11. Technical Appendix

### Bridge binary responsibilities

```
conductor-bridge
├── CLI: parse args, handle commands
├── Auth: GitHub OAuth JWT handling, token storage
├── Tunnel: persistent WebSocket to relay
├── Proxy: HTTP proxy for Conductor backend API
├── File browser: local filesystem read (sandboxed)
└── Status: heartbeat, bridge metadata
```

The bridge does NOT: run agents, manage sessions, store session history, parse terminal output, manage workspaces.

### Relay server responsibilities

```
conductor-relay
├── WebSocket server (TLS, RFC 6455)
├── JWT verification (GitHub OAuth JWT)
├── Connection multiplexer (one bridge ↔ N browser connections)
├── Frame forwarding (bidirectional, opaque bytes)
├── Rate limiting (per user ID)
└── Audit logging (connection metadata only)
```

The relay does NOT: store sessions, parse WebSocket frames, know about files or agents, access the filesystem, store user credentials.

### WebSocket frame format

Frames are JSON-encoded messages with a type discriminator:

```typescript
// Browser → Bridge
type BridgeOutbound =
  | { type: "terminal_resize"; cols: number; rows: number }
  | { type: "terminal_input"; data: string }
  | { type: "api_request"; id: string; method: string; path: string; body?: unknown }
  | { type: "file_browse"; path: string }
  | { type: "ping" };

// Bridge → Browser
type BridgeInbound =
  | { type: "terminal_output"; data: string }
  | { type: "api_response"; id: string; status: number; body: unknown }
  | { type: "file_tree"; path: string; entries: FileEntry[] }
  | { type: "bridge_status"; hostname: string; os: string; connected: boolean }
  | { type: "pong" };
```

Frames are sent over a single WebSocket connection. The relay doesn't parse them.

### Conductor backend changes required

The existing Conductor backend (running on laptop at localhost:4749) needs minimal changes:

1. Listen on localhost only (already the default)
2. No CORS changes needed (bridge is on same machine)
3. No API changes — bridge proxies HTTP requests unchanged
4. ttyd integration already in place

The bridge is a thin proxy, not a modification to the backend.

### Distribution

**Bridge binary:**
- GitHub Releases (macOS arm64, macOS x64, Linux x64)
- Homebrew tap: `brew install conductor-oss/tap/bridge`
- Install script: `curl https://conductor.app/install.sh | sh`
- Docker (for cloud VMs): `docker run conductor-oss/bridge`

**Relay server:**
- Docker: `docker run -p 443:8080 conductor-oss/relay`
- Binary (for VPS): download from GitHub Releases

**Dashboard:**
- Vercel (static host + serverless functions)
- Domain: conductor.app
