# Superset Terminal Architecture Research

## Project Overview

Superset (https://github.com/superset-sh/superset) is an Electron-based desktop IDE designed for running multiple CLI-based AI coding agents in parallel. It describes itself as "a turbocharged terminal that allows you to run any CLI coding agents along with the tools to 10x your development workflow." The project is built with TypeScript, Electron, React, xterm.js, and node-pty.

**Key quote from the developers:**
> "We chose xterm+node-pty because it's a proven way to run real PTYs in a desktop app (used by VSCode and Hyper), and Electron lets us ship fast."

---

## 1. Architecture: Multi-Process Daemon Model

Superset uses a **three-layer process architecture** for terminal management:

```
Renderer Process (React + xterm.js UI)
    |
    | (Electron IPC via tRPC)
    v
Main Process (Electron Node.js)
    |
    | (Unix Domain Socket, NDJSON protocol)
    v
terminal-host Daemon (long-running, survives app restarts)
    |
    | (stdin/stdout binary framing protocol)
    v
pty-subprocess (one per shell session, wraps node-pty)
```

### Why a Daemon?

The `terminal-host` runs as a separate long-running daemon process (not embedded in the Electron main process). This enables:

- **Session persistence across app restarts** -- the daemon keeps running even when the Electron app closes
- **Process isolation** -- a blocked PTY cannot stall the daemon or the main Electron process
- **Clean lifecycle management** -- the daemon can be independently spawned, monitored, and restarted

### Daemon Connection Details

- **Socket path**: `~/.superset/terminal-host.sock` (Unix domain socket)
- **Auth token**: `~/.superset/terminal-host.token` (64-character hex string)
- **PID file**: `~/.superset/terminal-host.pid`
- **Protocol**: NDJSON (newline-delimited JSON) over the socket

---

## 2. PTY Subprocess Implementation

Each terminal session gets its own `pty-subprocess` child process spawned by the daemon. This provides additional isolation.

### PTY Spawning

```typescript
ptyProcess = pty.spawn(msg.shell, msg.args, {
  name: "xterm-256color",
  cols: msg.cols,
  rows: msg.rows,
  cwd: msg.cwd,
  env: msg.env,
});
```

The subprocess also extracts the raw PTY file descriptor for direct async I/O:
```typescript
ptyFd = (ptyProcess as unknown as { fd?: number }).fd
```

This enables using `fs.write()` on the fd directly rather than going through node-pty's write method, which prevents event loop blocking.

### Binary Framing Protocol (IPC between daemon and subprocess)

Each frame consists of:
- **Byte 0**: Message type (UInt8)
- **Bytes 1-4**: Payload length (UInt32LE, little-endian)
- **Bytes 5+**: Payload buffer (0 to 64MB max)

**Message Types (bidirectional):**

| Direction | Type | Purpose |
|-----------|------|---------|
| Daemon -> Subprocess | Spawn | Launch shell with config |
| Daemon -> Subprocess | Write | Send user input (chunked to 8KB max) |
| Daemon -> Subprocess | Resize | Update terminal dimensions |
| Daemon -> Subprocess | Kill | Terminate process |
| Daemon -> Subprocess | Signal | Send OS signal (e.g., SIGINT) without marking as terminating |
| Daemon -> Subprocess | Dispose | Cleanup notification |
| Subprocess -> Daemon | Ready | Subprocess initialized |
| Subprocess -> Daemon | Spawned | PTY created, PID encoded |
| Subprocess -> Daemon | Data | Terminal output |
| Subprocess -> Daemon | Exit | Exit code and signal |
| Subprocess -> Daemon | Error | Write queue full or subprocess failures |

**Safety**: 64MB hard cap on frame size to prevent OOM from corrupted streams, since "PTY data is untrusted input in practice (terminal apps can emit arbitrarily)."

---

## 3. Buffering and Backpressure

Superset implements **three distinct backpressure layers** to prevent memory exhaustion and ensure smooth data flow.

### Output Batching (PTY -> Host)

PTY output is batched rather than immediately forwarded:
- Data collected in `outputChunks` array (avoids O(n^2) string concatenation)
- Flushes trigger either every **32ms** OR when reaching **128KB** threshold
- Comment in code: "CRITICAL: Use array buffering to avoid O(n^2) string concatenation"

### Input Backpressure (Host -> PTY)

| Layer | Mechanism | Threshold |
|-------|-----------|-----------|
| Input queue | stdin pause/resume | 8MB high / 4MB low watermark |
| Input hard limit | Drop frames + error | 64MB |
| Output | PTY pause/resume | stdout buffer full detection |

When the input write queue exceeds 8MB, upstream stdin is paused. Below 4MB, it resumes. A hard cap of 64MB prevents runaway memory usage entirely.

### Client Broadcasting Backpressure

Events are serialized as newline-delimited JSON to connected renderer clients:
- Monitor socket write return value for backpressure signal
- **Pause subprocess stdout** when any client buffer is full
- Resume when **all** clients drain
- Gracefully handle socket errors by detaching the client

### PTY Write Queue (`pty-write-queue.ts`)

Uses async `fs.write()` on the PTY file descriptor to prevent event loop blocking. Handles EAGAIN/EWOULDBLOCK errors with **exponential backoff** (2-50ms delay).

### Daemon Client Write Queue (`TerminalHostClient`)

The `writeNoAck` / `sendNotification` pattern implements fire-and-forget writes for terminal input with a **2MB queue limit** to prevent OOM conditions. This avoids timeout overhead for high-frequency keystrokes.

---

## 4. Session Lifecycle

### States

1. **Construction**: Initialize emulator, create PTY ready promise
2. **Spawn**: Launch subprocess with shell configuration
3. **Ready**: Subprocess signals readiness, resolves PTY promise
4. **Active**: Clients attach/detach, data flows bidirectionally
5. **Termination**: Kill signal marks session as terminating
6. **Cleanup**: Dispose releases resources and kills process trees

### Concurrency Control

- **Spawn Semaphore**: Maximum **3 concurrent PTY spawns** via a Semaphore class
- **Attach Scheduler**: Maximum **3 concurrent attaches** with priority-based scheduling
- **5-second readiness timeout** when creating new sessions
- **5-second force-dispose failsafe** after kill to handle stuck sessions

### Kill Escalation

Process termination follows an aggressive escalation strategy:
1. Send initial signal (default SIGTERM)
2. After **2 seconds**: escalate to SIGKILL
3. After additional **1 second**: force exit and synthesize Exit frame if onExit never fired

### Session Persistence

Sessions survive app restarts through a **snapshot/restore mechanism**:
- `reconcileDaemonSessions()` restores previous sessions on app launch
- The daemon maintains socket connections between restarts
- Session metadata persisted for recovery
- PTY file descriptors preserved across app lifecycle events

### Detachment and Cleanup

- `detachFromAllSessions()`: Removes client socket from all sessions, disposes dead sessions with no remaining clients
- `scheduleSessionCleanup()`: Reschedules every **5 seconds** until all clients detach from dead sessions
- `dispose()`: Clears all timers and kill timers, gives sessions **5 seconds** to exit gracefully

---

## 5. xterm.js Integration

### Renderer Side (React Component)

**Location**: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal.tsx`

**Key architecture**:
- Uses `useTerminalLifecycle` hook for xterm instance creation and addon initialization
- Uses `useTerminalConnection` hook providing refs for: `createOrAttach`, `write`, `resize`, `detach`, `clearScrollback`
- Data subscription via `electronTrpc.terminal.stream.useSubscription`

**Data Flow**:
```
Stream subscription -> handleStreamData -> pending events buffer -> xterm.write() or event handlers
```

**Reconnection Strategy**:
- Exponential backoff with maximum **5 retry attempts**
- Delay formula: `Math.min(1000 * 2 ** retryCountRef.current, 10_000)` (1s, 2s, 4s, 8s, 10s)
- Visual feedback written directly to the terminal during reconnection
- Cold restore via `useTerminalColdRestore` for recovery from connection loss

**Addons Used**:
- FitAddon (auto-resize terminal to container)
- SearchAddon (search overlay at top-right)
- SerializeAddon (on the headless side, for snapshotting)

### Headless Emulator (Main Process Side)

**Location**: `apps/desktop/src/main/lib/terminal-host/headless-emulator.ts`

Uses `@xterm/headless` (xterm.js 6.1.0-beta) to maintain terminal state without a visible display:

**Purpose**:
- Maintains terminal modes (DECSET/DECRST: application cursor keys, mouse tracking, bracketed paste)
- Captures snapshots for session restoration
- Tracks working directory via OSC-7 escape sequences
- Parses escape sequences with **chunk-safe buffering** (PTY output can split sequences across chunks)

**Snapshot Generation** (`getSnapshot()`):
- Complete ANSI representation of screen content
- Rehydration sequences for mode restoration (only emits differences from defaults)
- Current modes, dimensions, scrollback lines, and working directory

**Write Queue System**:
- Data enqueued with byte tracking
- `setImmediate` schedules processing
- **Time budgets**: 5ms with clients attached, 25ms without (scaled for large backlogs)
- Chunks limited to **8KB per iteration**
- Snapshot boundary waiters resolve when their item count is reached

**Snapshot Boundary System**: Tracks emulator write queue position to capture consistent state. When clients attach, the system waits (with **500ms timeout**) for all queued data before the attachment point to be processed, enabling "point-in-time" snapshots even during continuous output.

### xterm Environment Polyfill (`xterm-env-polyfill.ts`)

Fixes compatibility between `@xterm/headless` 6.x and the Bun runtime:
```typescript
// xterm 6.x detects Node via navigator.userAgent.startsWith("Node.js/")
// Bun sets navigator.userAgent to "Bun/...", so isNode is false
// Setting globalThis.window = globalThis makes the `in` check succeed
if (typeof window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}
```

---

## 6. Communication Layer: tRPC + Electron IPC

### Overview

The communication between renderer and main process uses **tRPC over Electron IPC** (not WebSocket). This is possible because Superset is an Electron desktop app, not a web app.

### Terminal Router Operations

| Operation | Pattern | Description |
|-----------|---------|-------------|
| `createOrAttach` | Request/Response | Create new session or attach to existing |
| `write` | Notification (fire-and-forget) | Send input to session |
| `resize` | Notification | Update terminal dimensions |
| `detach` | Request/Response | Disconnect from session |
| `kill` / `killAll` | Request/Response | Terminate sessions |
| `signal` | Request/Response | Send OS signal to process |
| `listSessions` | Request/Response | Enumerate active sessions |
| `clearScrollback` | Request/Response | Clear terminal history |
| `stream` | Subscription | Real-time terminal output stream |

### TerminalHostClient (Main Process -> Daemon)

The client maintains **two socket connections**:

1. **Control socket**: Handles request/response pairs with **30-second timeouts** and tracked request IDs
2. **Stream socket**: Receives asynchronous events (data, exit, errors) without request/response overhead

**Authentication**:
- Both sockets authenticate using a token written by the daemon at startup
- Protocol version negotiation on connection

**Error Recovery**:
- Connection state atomically reset on any socket error
- All pending requests rejected with "Connection lost"
- Automatic daemon restart on connection failure

**Dev Mode Features**:
- Tracks daemon script modification time
- Restarts daemon when script is rebuilt (hot-reload)
- Protocol mismatch detection triggers graceful shutdown of older daemons

---

## 7. Attach Scheduler

**Location**: `apps/desktop/src/renderer/.../Terminal/attach-scheduler.ts`

Implements priority-based task scheduling for concurrent terminal session attachments:

- **Concurrency limit**: 3 concurrent attachments (`MAX_CONCURRENT_ATTACHES`)
- **Priority scheduling**: Lower number = higher priority, FIFO for equal priority
- **Deduplication**: New task for existing pane cancels previous pending task
- **React StrictMode handling**: Prevents double-renders from exhausting concurrency limits
- **Idempotent completion**: `released` flag ensures cleanup runs exactly once
- **Debug mode**: Activated via `localStorage["SUPERSET_TERMINAL_DEBUG"]`

---

## 8. Signal Handling and Graceful Shutdown

### Signal Handlers

- **SIGINT/SIGTERM/SIGHUP**: Trigger clean shutdown with exit code 0
- Each handler uses "shutdown once" pattern to prevent duplicate execution

### Error Classification

**Transient errors** (recoverable, logged as warnings):
- `ENOSPC` (disk full)
- `ENOMEM` (out of memory)
- `EMFILE` (too many open file descriptors)
- `ENFILE` (system-wide fd limit)

**Rate limiting**: Sliding window of 60 seconds, threshold of **50 transient errors** triggers shutdown.

### Shutdown Sequence

1. Set **10-second timeout** forcing exit if cleanup hangs
2. Attempt graceful server shutdown
3. Guarantee process termination even if `stopServer()` fails

---

## 9. Key File Locations

### Main Process (Electron)

| File | Purpose |
|------|---------|
| `apps/desktop/src/main/terminal-host/index.ts` | Daemon entry point, IPC server on Unix socket |
| `apps/desktop/src/main/terminal-host/terminal-host.ts` | TerminalHost class, session management |
| `apps/desktop/src/main/terminal-host/session.ts` | Session class, PTY lifecycle, emulator, client broadcasting |
| `apps/desktop/src/main/terminal-host/pty-subprocess.ts` | PTY child process, binary framing, backpressure |
| `apps/desktop/src/main/terminal-host/pty-subprocess-ipc.ts` | Binary framing protocol definition |
| `apps/desktop/src/main/terminal-host/signal-handlers.ts` | OS signal handling, graceful shutdown |
| `apps/desktop/src/main/terminal-host/xterm-env-polyfill.ts` | Bun/xterm compatibility fix |
| `apps/desktop/src/main/lib/terminal/session.ts` | Main process session creation with node-pty |
| `apps/desktop/src/main/lib/terminal/pty-write-queue.ts` | Async write queue with backpressure |
| `apps/desktop/src/main/lib/terminal/daemon/daemon-manager.ts` | Daemon lifecycle management |
| `apps/desktop/src/main/lib/terminal-host/client.ts` | TerminalHostClient, dual-socket connection |
| `apps/desktop/src/main/lib/terminal-host/headless-emulator.ts` | @xterm/headless state tracking |

### Renderer Process (React)

| File | Purpose |
|------|---------|
| `.../Terminal/Terminal.tsx` | Main terminal React component |
| `.../Terminal/attach-scheduler.ts` | Priority-based attach scheduling |
| `.../Terminal/commandBuffer.ts` | Terminal state inspection utilities |
| `.../Terminal/state.ts` | Terminal state management |
| `.../Terminal/config.ts` | Terminal configuration |
| `.../Terminal/pane-guards.ts` | Guard conditions for terminal panes |
| `.../Terminal/hooks/` | Terminal lifecycle, connection, cold restore hooks |

---

## 10. Comparison with Conductor OSS

### Similarities

| Feature | Superset | Conductor OSS |
|---------|----------|---------------|
| PTY-based terminal | Yes (node-pty) | Yes (Rust PTY) |
| Multiple agent sessions | Yes (parallel tabs) | Yes (kanban-dispatched) |
| Session persistence | Snapshot/restore | SQLite state |
| xterm.js rendering | Yes (v6.1.0-beta) | Yes (via web dashboard) |
| Process isolation | Worktrees per agent | Worktrees per session |

### Key Differences

| Aspect | Superset | Conductor OSS |
|--------|----------|---------------|
| Runtime | Electron (desktop) | Web (Next.js + Rust backend) |
| IPC | Electron IPC + tRPC | HTTP/SSE |
| PTY Host | External daemon (Unix socket) | Embedded in Rust server |
| Communication | tRPC subscriptions | SSE streams |
| Backpressure | Multi-layer (socket, stdin, stdout) | HTTP-level |
| Session restoration | Headless xterm snapshots | Log tail from PTY |

### Applicable Patterns for Conductor

1. **Spawn Semaphore**: Limit concurrent PTY spawns (Superset uses max 3) to prevent resource exhaustion
2. **Kill Escalation**: SIGTERM -> 2s -> SIGKILL -> 1s -> force exit with synthetic exit event
3. **Output Batching**: Batch PTY output every 32ms or at 128KB threshold instead of forwarding every byte
4. **Headless Emulator**: Consider using @xterm/headless on the server side to maintain terminal state for reconnection snapshots
5. **Binary Framing**: For high-throughput PTY IPC, binary framing with length-prefixed headers outperforms text protocols
6. **Attach Scheduler**: Priority-based connection scheduling prevents thundering herd when multiple terminals reconnect simultaneously
7. **Exponential Backoff Reconnection**: `Math.min(1000 * 2^retryCount, 10_000)` with max 5 retries
8. **Snapshot Boundary System**: Wait for queued data to process before capturing state, enabling consistent point-in-time snapshots during continuous output
9. **Write Queue Backpressure**: EAGAIN/EWOULDBLOCK handling with exponential backoff (2-50ms) for PTY writes
10. **Transient Error Classification**: Distinguish recoverable OS errors (ENOSPC, ENOMEM, EMFILE) from fatal errors, with rate-limited escalation

---

## 11. Conductor Implementation Status

The following Superset patterns have been implemented in Conductor OSS:

| Pattern | Status | Location |
|---------|--------|----------|
| Kill Escalation (SIGTERM 2s → SIGKILL 1s) | ✅ Implemented | `pty_host.rs`, `pty_subprocess.rs` |
| Output Batching (32ms / 128KB) | ✅ Implemented | `pty_subprocess.rs` (reader + batcher threads) |
| Reconnection (1s, 2s, 4s, 8s, 10s, max 5) | ✅ Implemented | `terminalConstants.ts`, `useTerminalConnection.ts` |
| Spawn Semaphore (max 3) | ✅ Implemented | `terminal-daemon.ts` |
| Attach Scheduler (max 3 concurrent) | ✅ Implemented | `terminalAttachScheduler.ts` |
| Stream Batching (32ms / 128KB) | ✅ Implemented | `pty_host.rs` `DetachedStreamBatchConfig` |
| Headless Emulator (vt100) | ✅ Implemented | `emulator.rs`, `TerminalStateStore` |
| Session persistence | ✅ Implemented | SQLite + log capture |
| Binary framing (stream) | ✅ Implemented | `frame.rs` |

---

## Sources

- https://github.com/superset-sh/superset
- https://deepwiki.com/superset-sh/superset
- https://docs.superset.sh/terminal-integration
- https://superset.sh/changelog
- https://news.ycombinator.com/item?id=46368739
