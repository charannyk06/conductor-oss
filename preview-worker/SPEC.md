# Preview Worker — Architecture Spec

## Goal

Replace the broken `devPreviewBrowser.ts` (puppeteer on Vercel) with a proper Preview Worker service running on Contabo VPS. The worker launches headless Chrome, manages session lifecycle, and handles both public URLs and localhost dev servers via cloudflared tunnels.

## Overview

```
User browser → Vercel app → Preview Worker (Contabo VPS)
                              ├── Cloudflare Tunnel → User's localhost:3000
                              └── Chrome headless → navigates, screenshots, DOM
```

## Components

### 1. Preview Worker (Contabo VPS, Docker)

**Location:** `preview-worker/` directory in the conductor-oss repo

**Tech stack:** Node.js + TypeScript + Fastify + puppeteer-core + cloudflared

**Docker image:** Based on `node:22-alpine`, installs Chrome/Chromium + cloudflared binary

**API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create preview session, returns `sessionId` |
| POST | `/sessions/:id/command` | Run a command (connect, click, type, navigate, screenshot, dom) |
| DELETE | `/sessions/:id` | Destroy session, close Chrome, close tunnel |
| GET | `/health` | Health check with `buildSha` deployment identity (`CONDUCTOR_BUILD_SHA`, default `unknown`) |

**Session Lifecycle:**
1. `POST /sessions` — launch Chrome, configure viewport/listeners, return sessionId
2. For localhost URLs: create a temporary cloudflared quick tunnel and wait until it resolves and responds
3. `POST /sessions/:id/command` — run commands, return result (screenshot as base64, DOM as JSON)
4. `DELETE /sessions/:id` — close Chrome process, close cloudflared tunnel, remove session

**Security:**
- API key authentication via `Authorization: Bearer <key>` header
- Direct public navigation resolves DNS first, rejects private/special addresses, and connects to the validated IP so DNS cannot be rebound between validation and the request
- Redirects and browser subrequests pass through the same validation path; localhost uses the tunnel path instead of direct worker-network access
- WebSocket and other network-capable non-HTTP schemes are blocked below the page at the Chromium DevTools Protocol layer. Public `ws:`/`wss:` is intentionally fail-closed because it cannot reuse the preview worker's DNS-pinned HTTP client.
- Each session permits at most 32 in-flight intercepted requests and 64 MiB of aggregate buffered request/response data; individual request bodies are capped at 8 MiB and responses at 25 MiB.
- Session timeout: 10 minutes of inactivity → auto-destroy
- Max sessions per API key: 5 concurrent, including in-flight creation reservations
- Session creation is idempotent for a supplied client session ID and concurrent commands are serialized per session
- No external file system access, no child processes except Chrome/cloudflared

**Commands (same interface as existing `PreviewCommandRequest`):**

```typescript
type PreviewCommandRequest =
  | { command: "connect"; url: string }
  | { command: "navigate"; url: string }
  | { command: "reload" }
  | { command: "selectFrame"; frameId: string | null }
  | { command: "clickAtPoint"; x: number; y: number }
  | { command: "typeText"; text: string }
  | { command: "pressKey"; key: string }
  | { command: "selectAtPoint"; x: number; y: number }
  | { command: "selectBySelector"; selector: string; frameId?: string | null }
```

**Command Responses:**

```typescript
type PreviewCommandResponse =
  | { kind: "status"; ...PreviewStatusResponse }
  | { kind: "screenshot"; imageBase64: string }
  | { kind: "dom"; frameId: string | null; nodes: PreviewDomNode[]; truncated: boolean }
  | { kind: "error"; message: string }
```

### 2. Vercel Side Changes

**New file:** `packages/web/src/lib/previewWorkerClient.ts`
- Replaces `devPreviewBrowser.ts` when `CONDUCTOR_PREVIEW_WORKER_URL` is set
- Same interface as `PreviewBrowserManager` but calls the remote worker
- Falls back to `devPreviewBrowser.ts` when backend URL is local (for local dev)

**New env vars:**
- `CONDUCTOR_PREVIEW_WORKER_URL` — e.g. `https://preview-worker.example.com`
- `CONDUCTOR_PREVIEW_WORKER_KEY` — API key for worker auth

**Detection logic:**
- If `CONDUCTOR_BACKEND_URL` points to `localhost` or `127.0.0.1` → use local `devPreviewBrowser.ts`
- Otherwise → use `previewWorkerClient.ts`

**Error handling:**
- Worker unreachable → show "Preview service is unavailable" in UI
- Worker returns error → surface the real error message, not generic "Preview command failed"

### 3. Docker Compose (Contabo)

```yaml
services:
  preview-worker:
    build: ./preview-worker
    ports:
      - "3099:3099"
    environment:
      - WORKER_PORT=3099
      - WORKER_API_KEY=${WORKER_API_KEY}
      - WORKER_SESSION_TIMEOUT_MS=600000
      - WORKER_MAX_SESSIONS=5
      - CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX=false
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3099/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### 4. Cloudflared Tunnel (Localhost Access)

When a user wants to preview `localhost:3000`:

1. Worker receives `connect` command with `url: "http://localhost:3000"`
2. Worker calls cloudflared to create a tunnel to `localhost:3000`
3. Cloudflared returns a `*.trycloudflare.com` URL
4. Worker rewrites loopback requests to the tunnel origin while preserving the requested path and query
5. When session is destroyed, cloudflared tunnel is closed

**Cloudflared mode:** Uses `cloudflared --url <local-origin>` quick tunnels. This mode does not use a persistent tunnel token. Treat the generated public URL as temporary bearer-like access and close the process when the session ends.

## File Structure

```
conductor-oss/
├── preview-worker/
│   ├── SPEC.md                          ← this file
│   ├── Dockerfile
│   ├── docker-compose.yaml              ← for Contabo deployment
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                    ← Fastify server entry point
│   │   ├── routes/
│   │   │   ├── sessions.ts             ← POST /sessions, DELETE /sessions/:id
│   │   │   ├── command.ts              ← POST /sessions/:id/command
│   │   │   └── health.ts               ← GET /health
│   │   ├── browser/
│   │   │   ├── BrowserManager.ts       ← Chrome lifecycle, per-session browser
│   │   │   ├── commands.ts              ← Command handlers (connect, click, etc.)
│   │   │   ├── dom.ts                  ← DOM snapshot logic
│   │   │   └── tunnel.ts               ← cloudflared tunnel management
│   │   ├── lib/
│   │   │   ├── auth.ts                 ← API key validation
│   │   │   ├── security.ts              ← Private network blocking
│   │   │   └── types.ts                ← Shared types
│   │   └── sessions/
│   │       └── SessionStore.ts         ← In-memory session registry
│   └── .env.example
│
└── packages/web/src/lib/
    ├── previewWorkerClient.ts          ← NEW: replaces devPreviewBrowser.ts for remote
    └── devPreviewBrowser.ts             ← Keep for local dev, gate behind local backend URL
```

## Chrome Configuration

```typescript
const VIEWPORT = { width: 1440, height: 960 };

// Launch args for server-side Chrome (same as existing devPreviewBrowser.ts)
const CHROME_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--mute-audio",
];
```

Chrome's sandbox remains enabled by default. Only deployments that provide an equivalent container/VM isolation boundary may explicitly set `CONDUCTOR_PREVIEW_WORKER_DISABLE_SANDBOX=true`, which adds `--no-sandbox` and `--disable-setuid-sandbox`.

## API Authentication

Worker API key stored in Contabo env var `WORKER_API_KEY`. Vercel app stores it as `CONDUCTOR_PREVIEW_WORKER_KEY` in Vercel env vars (referenced via SecretRef).

Every request to the worker includes:
```
Authorization: Bearer <WORKER_API_KEY>
```

Worker validates the key on every request. Returns `401 Unauthorized` if missing or wrong.

## Session Store

In-memory store (Map of sessionId → PreviewSession). Each session tracks:

```typescript
interface PreviewSession {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  browser: Browser;          // puppeteer Browser instance
  page: Page;                // puppeteer Page instance
  tunnelUrl: string | null;  // cloudflared tunnel URL if localhost
  tunnelProcess: ChildProcess | null;
  status: "active" | "closing";
}
```

Expired sessions are destroyed by periodic cleanup and before capacity is allocated. Creation reserves capacity before Chrome launches, rolls back partially created browser/tunnel resources on failure, and coalesces concurrent requests with the same client session ID. Commands run under a per-session lock. A command timeout closes the affected session so an underlying Chrome operation cannot continue as untracked work.

## Error Responses

```typescript
// Worker returns these as JSON with appropriate HTTP status
400 Bad Request        — invalid command or parameters
401 Unauthorized       — missing or bad API key
404 Not Found         — session not found or expired
408 Request Timeout   — Chrome command timed out (30s limit)
429 Too Many Requests — max sessions exceeded
500 Internal Error    — Chrome crashed or unexpected failure
```

## What NOT to build (out of scope)

- Persistent storage of screenshots or DOM dumps
- User accounts / multi-tenancy (the configured API key is the only tenant boundary)
- Recording / playback of sessions
- PDF export
- Mobile device emulation
- Browser profile management
- Parallel command execution within one session (commands are deliberately serialized)

## Build/Deploy Steps

1. Push `preview-worker/` to GitHub
2. On Contabo: `git clone` and `docker compose up -d`
3. Set `WORKER_API_KEY` in Contabo env
4. Set `CONDUCTOR_PREVIEW_WORKER_URL` and `CONDUCTOR_PREVIEW_WORKER_KEY` in Vercel env vars
5. Test: open a session in the app, connect to `http://localhost:3000`
