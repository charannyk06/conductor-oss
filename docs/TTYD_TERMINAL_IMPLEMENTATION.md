# TTyD Web Terminal Implementation

## Overview

This document describes the complete ttyd (web-based terminal sharing) implementation for Conductor OSS. ttyd provides a high-performance, low-latency terminal interface using a binary WebSocket protocol with built-in flow control and backpressure handling.

**Architecture**: Backend (Rust with portable-pty) ↔ Binary WebSocket (ttyd protocol) ↔ Frontend (xterm.js)

## Why ttyd?

ttyd's design principles make it ideal for Conductor's use case:

1. **Performance**: Uses binary WebSocket frames (no JSON serialization overhead) + WebGL2 rendering
2. **Efficiency**: Single-byte command prefix, minimal framing overhead
3. **Backpressure**: Built-in flow control prevents browser rendering overload
4. **Reliability**: Designed for cross-platform remote terminal access
5. **Simplicity**: Protocol is minimal (~10 lines of command definitions)

## Protocol

### Command Bytes

Every WebSocket message is a binary frame with the structure:

```
+--------+---------------------------+
| byte 0 | bytes 1..N               |
| CMD    | PAYLOAD                  |
+--------+---------------------------+
```

#### Server → Client Messages

| Command | Byte | Payload |
|---------|------|---------|
| **OUTPUT** | `0x30` (`'0'`) | Raw terminal bytes (ANSI, UTF-8, etc.) |
| **SET_WINDOW_TITLE** | `0x31` (`'1'`) | UTF-8 title string |
| **SET_PREFERENCES** | `0x32` (`'2'`) | JSON: `{fontSize, fontFamily, theme, bellSound}` |

#### Client → Server Messages

| Command | Byte | Payload |
|---------|------|---------|
| **INPUT** | `0x30` (`'0'`) | UTF-8 encoded keyboard input or binary data |
| **RESIZE_TERMINAL** | `0x31` (`'1'`) | JSON: `{columns: u16, rows: u16}` |
| **PAUSE** | `0x32` (`'2'`) | (no payload) - client backpressure |
| **RESUME** | `0x33` (`'3'`) | (no payload) - client ready for more |

### Message Examples

**OUTPUT (server → client)**:
```
[0x30] [ANSI_BYTES] → display terminal output
```

**INPUT (client → server)**:
```
[0x30] [UTF8_INPUT] → send keyboard input to PTY
```

**RESIZE (client → server)**:
```
[0x31] [{columns: 120, rows: 40}] → request terminal resize
```

**PAUSE (client → server)**:
```
[0x32] → tell server to slow down, browser is overloaded
```

**RESUME (client → server)**:
```
[0x33] → tell server to resume, browser caught up
```

## Flow Control Architecture

### Server-Side (Rust)

The backend uses a "read-one-write-one" pattern:

```
PTY read → [pause reading] → WS write → [resume reading] → repeat
```

This provides natural backpressure without buffering multiple chunks:
- Memory bounded (only one PTY buffer in flight)
- No data accumulation
- Paces transmission to network speed

### Client-Side (TypeScript)

The frontend tracks xterm.js rendering load:

```typescript
const flowControl = {
  writeThreshold: 100_000,    // Check backpressure every 100KB
  highWater: 10,              // PAUSE if 10+ pending writes
  lowWater: 4,                // RESUME if drops to 4
}
```

**Flow**:
1. Server sends terminal data (OUTPUT messages)
2. Client calls `terminal.write(data, callback)` and increments `pendingWrites`
3. When `pendingWrites > highWater`, client sends PAUSE
4. Server receives PAUSE, stops reading from PTY
5. When `pendingWrites ≤ lowWater`, client sends RESUME
6. Server resumes reading

This prevents scenarios where a fast process (like `cat /dev/urandom`) overwhelms the browser's rendering pipeline.

## Implementation Details

### Backend (Rust)

**Files**:
- `crates/conductor-server/src/routes/ttyd_protocol.rs` - Protocol encoding/decoding
- `crates/conductor-server/src/routes/terminal.rs` - WebSocket handler (enhanced)

**Key Components**:

1. **ttyd_protocol module**:
   ```rust
   pub enum ClientMessage {
       Input(Vec<u8>),
       Resize { columns: u16, rows: u16 },
       Pause,
       Resume,
       Handshake(Value),
   }

   impl ClientMessage {
       pub fn from_websocket_frame(data: &[u8]) -> Option<Self> { ... }
   }
   ```

2. **Terminal WebSocket Handler** (enhanced):
   - Parses incoming ClientMessage
   - Forwards Input to `state.send_raw_to_session()`
   - Calls `state.resize_live_terminal()` on Resize
   - Respects PAUSE/RESUME for flow control
   - Sends OUTPUT messages using `encode_output()`

3. **PTY Output Streaming**:
   - Reads from detached PTY host
   - Sends each chunk wrapped with OUTPUT command byte
   - Respects client's PAUSE/RESUME signaling

### Frontend (TypeScript)

**Files**:
- `packages/web/src/components/sessions/terminal/ttydClient.ts` - Protocol client
- `packages/web/src/components/sessions/terminal/useTtydConnection.ts` - React hook
- `packages/web/src/components/sessions/SessionTerminal.tsx` - Integration

**Key Components**:

1. **TtydClient class**:
   ```typescript
   export class TtydClient {
       connect(url: string): Promise<void>
       sendInput(data: string | Uint8Array): void
       sendResize(cols: number, rows: number): void
       isConnected(): boolean
   }
   ```

   Features:
   - Binary WebSocket with `binaryType = "arraybuffer"`
   - UTF-8 encoding/decoding with `TextEncoder`/`TextDecoder`
   - Flow control state machine
   - Auto-reconnect on abnormal close (up to 5 attempts)

2. **useTtydConnection hook**:
   ```typescript
   export function useTtydConnection(options: {
       terminal: Terminal | null
       fitAddon: FitAddon | null
       ptyWsUrl: string | null
       enabled?: boolean
       onConnectionReady?: () => void
       onConnectionClosed?: (code, reason) => void
       onConnectionError?: (error) => void
   }): UseTtydConnectionResult
   ```

   Manages:
   - Lifecycle (connect, disconnect, reconnect)
   - xterm.js integration (input, output, resize)
   - Flow control feedback (PAUSE/RESUME)
   - Error handling

3. **SessionTerminal Integration**:
   - Calls `useTtydConnection` with terminal and fit addon refs
   - Uses `ttydSendResize` for terminal resize operations
   - Falls back to HTTP resize if WebSocket unavailable
   - Updates connection state and error messages

## Backpressure In Practice

### Scenario 1: Fast Output (cat /dev/urandom)

```
Time    Client              Server              PTY
────────────────────────────────────────────────────────
1       [connected]                          [reading]
2                       ← OUTPUT[1KB]        [paused]
3       ↓ 1KB to xterm  ← OUTPUT[1KB]        [paused]
4       ↓ 1KB to xterm  ← OUTPUT[1KB]        [paused]
5       ↓ 1KB to xterm
        [pendingWrites=3]
        ← OUTPUT[1KB]                        [paused]
6       ↓ 1KB to xterm
        [pendingWrites=4]
        ← OUTPUT[1KB]                        [paused]
7       ↓ 1KB to xterm
        [pendingWrites=5]
        ...
8       ↓ 1KB to xterm
        [pendingWrites=10] → PAUSE           [paused]
9       [paused]
        ↑ xterm renders [callback]
        [pendingWrites=9]
10      ↑ xterm renders [callback]
        [pendingWrites=8]
        ↑ xterm renders [callback]
        [pendingWrites=7]
        ↑ xterm renders [callback]
        [pendingWrites=6]
        ↑ xterm renders [callback]
        [pendingWrites=5]
        ↑ xterm renders [callback]
        [pendingWrites=4] → RESUME
11                                       [reading]
12                      ← OUTPUT[1KB]    [paused]
```

Result: Browser never gets overwhelmed, PTY production matches browser consumption.

## Connection Lifecycle

### Initial Connection

1. Client fetches `ptyWsUrl` from `/api/sessions/{id}/terminal/connection`
2. Client initiates WebSocket connection to `ptyWsUrl`
3. Server spawns PTY process (or connects to existing one)
4. Server sends initial messages (title, preferences) to client
5. Client applies preferences to xterm.js
6. Server resumes reading PTY output
7. DATA messages begin flowing

### Graceful Disconnect

1. Client sends `socket.close(1000)` (normal closure)
2. Server receives close event, kills PTY process
3. Client marks terminal as "closed"
4. User can choose to reconnect (fresh shell) or navigate away

### Abnormal Disconnect

1. Network fault interrupts WebSocket
2. Client detects `readyState !== OPEN`
3. Client auto-reconnects (up to 5 attempts with exponential backoff)
4. On reconnect: new PTY spawned, terminal reset, fresh session

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Protocol overhead | 1 byte/msg | Single command byte, WebSocket handles framing |
| Typical latency | <50ms | Binary frames, minimal serialization |
| Memory per session | ~2-4MB | One PTY buffer + xterm.js state |
| Bandwidth (idle) | ~1 KB/s | Ping/pong overhead |
| Bandwidth (active typing) | ~1-5 KB/s | User input is sparse |
| Bandwidth (fast output) | Network limited | Backpressure prevents buffering |

## Testing the Implementation

### 1. Basic I/O

```bash
# Should see prompt and be able to type
curl ws://localhost:4749/api/sessions/{id}/terminal/ws
```

### 2. Fast Output

```bash
# In terminal:
seq 1 1000000  # Should not consume unbounded memory

# Watch server logs for PAUSE/RESUME flow control
```

### 3. Resize

```typescript
// Send resize message to WebSocket
const msg = new Uint8Array([0x31]); // CMD_RESIZE
const json = '{"columns":120,"rows":40}';
ws.send(msg.concat(new TextEncoder().encode(json)));

// Should trigger SIGWINCH in PTY
```

### 4. Reconnection

```typescript
// Disconnect WebSocket
ws.close();

// Client should auto-reconnect within 2 seconds
// New shell session should start
```

## Troubleshooting

### WebSocket Connection Fails

**Symptom**: `error: connection failed`

**Cause**: Server not exposing WebSocket endpoint

**Fix**: Ensure `GET /api/sessions/{id}/terminal/ws` route is registered with protocol=ttyd

### Terminal Not Receiving Output

**Symptom**: Type commands but see no response

**Cause**: Client not listening for OUTPUT messages

**Fix**: Verify `client.setOnData()` callback is registered

### Resize Not Working

**Symptom**: Type `stty size` but shows wrong dimensions

**Cause**: Client not sending RESIZE messages or server not applying

**Fix**: Verify server calls `pty_resize()` after parsing RESIZE_TERMINAL

### Memory Grows Over Time

**Symptom**: Server memory increases with long-running session

**Cause**: Flow control deadlock (client never sends RESUME after PAUSE)

**Fix**: Verify client tracks `pendingWrites` correctly and sends RESUME when ≤lowWater

## References

- **ttyd GitHub**: https://github.com/tsl0922/ttyd
- **Protocol Documentation**: `research/ttyd-architecture-analysis.md`
- **xterm.js**: https://xtermjs.org/
- **WebSocket RFC**: https://tools.ietf.org/html/rfc6455
