# ttyd Architecture Deep Dive

## Research Date: 2026-03-15

## Table of Contents
1. [Overview](#overview)
2. [Binary Protocol Format](#binary-protocol-format)
3. [Data Flow: PTY to Browser](#data-flow-pty-to-browser)
4. [Data Flow: Browser to PTY](#data-flow-browser-to-pty)
5. [Flow Control (Backpressure)](#flow-control-backpressure)
6. [Resize Handling](#resize-handling)
7. [Connection Lifecycle and Reconnection](#connection-lifecycle-and-reconnection)
8. [Key Architectural Decisions](#key-architectural-decisions)
9. [Source Code References](#source-code-references)

---

## Overview

ttyd is a C-based terminal sharing tool that exposes a PTY over WebSocket to an xterm.js frontend. The architecture is remarkably simple and effective:

- **Backend**: C with libwebsockets + libuv (async I/O event loop)
- **Frontend**: Preact + xterm.js (TypeScript, built with webpack)
- **Transport**: WebSocket with binary frames
- **Protocol**: Single-byte command prefix + payload (custom application-level framing)

The entire protocol fits in roughly 10 lines of #defines. There is no complex serialization, no JSON for data transfer, no message length headers. It is elegant in its minimalism.

---

## Binary Protocol Format

### Protocol Constants (from `src/server.h`)

```c
// Client -> Server messages
#define INPUT            '0'   // 0x30 - keyboard/binary input
#define RESIZE_TERMINAL  '1'   // 0x31 - terminal resize request
#define PAUSE            '2'   // 0x32 - flow control: pause output
#define RESUME           '3'   // 0x33 - flow control: resume output
#define JSON_DATA        '{'   // 0x7B - initial handshake with auth + size

// Server -> Client messages
#define OUTPUT           '0'   // 0x30 - terminal output data
#define SET_WINDOW_TITLE '1'   // 0x31 - set browser window title
#define SET_PREFERENCES  '2'   // 0x32 - send client preferences/config
```

### Message Format

Every WebSocket message (sent as **binary** frames) has the structure:

```
+--------+---------------------------+
| byte 0 | bytes 1..N               |
| CMD    | PAYLOAD                  |
+--------+---------------------------+
```

- **Byte 0**: Single ASCII character identifying the command type
- **Bytes 1..N**: Command-specific payload (raw bytes for OUTPUT/INPUT, UTF-8 JSON for RESIZE/PREFS)

### Specific Message Formats

**OUTPUT (Server -> Client)**:
```
'0' + raw_terminal_bytes
```
The payload is raw PTY output -- ANSI escape sequences, UTF-8 text, everything the process writes to stdout/stderr through the PTY.

**INPUT (Client -> Server)**:
```
'0' + raw_keystroke_bytes
```
The payload is UTF-8 encoded keyboard input.

**RESIZE_TERMINAL (Client -> Server)**:
```
'1' + JSON: {"columns": 120, "rows": 40}
```

**SET_WINDOW_TITLE (Server -> Client)**:
```
'1' + UTF-8 title string (e.g., "/bin/bash (hostname)")
```

**SET_PREFERENCES (Server -> Client)**:
```
'2' + JSON preferences object
```

**JSON_DATA / Initial Handshake (Client -> Server)**:
```
'{"AuthToken":"...","columns":120,"rows":40}'
```
Note: This uses `{` as the command byte, so the entire message is valid JSON. This is the first message the client sends upon connection.

**PAUSE (Client -> Server)**:
```
'2'  (single byte, no payload)
```

**RESUME (Client -> Server)**:
```
'3'  (single byte, no payload)
```

---

## Data Flow: PTY to Browser

### Step-by-step: Process output reaches the browser

```
Process (bash, etc.)
    |
    | writes to stdout/stderr
    v
PTY master fd (kernel)
    |
    | libuv pipe reads (non-blocking)
    v
read_cb() in pty.c
    |
    | uv_read_stop() -- pauses further reads immediately
    | calls process->read_cb() with pty_buf_t
    v
process_read_cb() in protocol.c
    |
    | stores buf in pss->pty_buf
    | calls lws_callback_on_writable(wsi) -- schedules WS write
    v
LWS_CALLBACK_SERVER_WRITEABLE handler
    |
    | calls wsi_output(wsi, pss->pty_buf)
    v
wsi_output() in protocol.c
    |
    | prepends OUTPUT ('0') command byte
    | calls lws_write(wsi, data, len, LWS_WRITE_BINARY)
    | frees the buffer
    | calls pty_resume() -- resumes PTY reads
    v
WebSocket binary frame sent to client
    |
    v
onSocketData() in xterm/index.ts
    |
    | reads first byte as command
    | slices data from byte 1 onward
    v
writeFunc(data) -- which is writeData() or zmodem consume
    |
    v
terminal.write(data) -- xterm.js renders the output
```

### Critical Detail: One-at-a-time Read Pattern

The `read_cb` in pty.c does something very important:

```c
static void read_cb(uv_stream_t *stream, ssize_t n, const uv_buf_t *buf) {
  uv_read_stop(stream);  // <-- STOP reading immediately after receiving data
  pty_process *process = (pty_process *) stream->data;
  if (n <= 0) {
    if (n == UV_ENOBUFS || n == 0) return;
    process->read_cb(process, NULL, true);  // EOF
    goto done;
  }
  process->read_cb(process, pty_buf_init(buf->base, (size_t) n), false);
done:
  free(buf->base);
}
```

After reading ONE chunk from the PTY, it immediately stops reading (`uv_read_stop`). Reading is only resumed after the data has been successfully written to the WebSocket:

```c
// In LWS_CALLBACK_SERVER_WRITEABLE:
if (pss->pty_buf != NULL) {
    wsi_output(wsi, pss->pty_buf);
    pty_buf_free(pss->pty_buf);
    pss->pty_buf = NULL;
    pty_resume(pss->process);  // <-- Resume reading only after WS write
}
```

This creates a natural backpressure mechanism: the PTY will not read faster than the WebSocket can send.

### Server-Side Output Framing (wsi_output)

```c
static void wsi_output(struct lws *wsi, pty_buf_t *buf) {
  if (buf == NULL) return;
  char *message = xmalloc(LWS_PRE + 1 + buf->len);
  char *ptr = message + LWS_PRE;

  *ptr = OUTPUT;                         // byte 0: command '0'
  memcpy(ptr + 1, buf->base, buf->len);  // bytes 1..N: raw PTY data
  size_t n = buf->len + 1;

  if (lws_write(wsi, (unsigned char *)ptr, n, LWS_WRITE_BINARY) < n) {
    lwsl_err("write OUTPUT to WS\n");
  }

  free(message);
}
```

Note: `LWS_PRE` is a libwebsockets requirement -- it reserves space before the data for WebSocket framing headers, avoiding a copy.

---

## Data Flow: Browser to PTY

### Step-by-step: Keystroke reaches the PTY

```
User presses key
    |
    v
xterm.js onData / onBinary event
    |
    v
sendData() in xterm/index.ts
    |
    | prepends INPUT ('0') command byte
    | sends as binary WebSocket frame
    v
WebSocket binary frame received by server
    |
    v
LWS_CALLBACK_RECEIVE handler in protocol.c
    |
    | accumulates fragments in pss->buffer
    | checks if message is complete (lws_is_final_fragment)
    | reads command byte from buffer[0]
    v
case INPUT:
    |
    | calls pty_write(process, pty_buf_init(buffer+1, len-1))
    v
pty_write() in pty.c
    |
    | uv_write() to process->in pipe
    v
PTY master fd (kernel writes to slave)
    |
    v
Process stdin receives the keystrokes
```

### Frontend Input Sending (sendData)

```typescript
public sendData(data: string | Uint8Array) {
    const { socket, textEncoder } = this;
    if (socket?.readyState !== WebSocket.OPEN) return;

    if (typeof data === 'string') {
        // String input: pre-allocate buffer with room for worst-case UTF-8
        const payload = new Uint8Array(data.length * 3 + 1);
        payload[0] = Command.INPUT.charCodeAt(0);  // '0' = 0x30
        const stats = textEncoder.encodeInto(data, payload.subarray(1));
        socket.send(payload.subarray(0, (stats.written as number) + 1));
    } else {
        // Binary input (from onBinary)
        const payload = new Uint8Array(data.length + 1);
        payload[0] = Command.INPUT.charCodeAt(0);
        payload.set(data, 1);
        socket.send(payload);
    }
}
```

Key details:
- Uses `TextEncoder.encodeInto()` for zero-copy UTF-8 encoding into a pre-allocated buffer
- Pre-allocates `data.length * 3 + 1` bytes to handle worst-case UTF-8 expansion
- Uses `subarray()` to send only the written portion (no copy)
- Always sends as binary WebSocket frames

### Server-Side Input Processing

```c
case INPUT:
    if (!server->writable) break;  // read-only mode check
    int err = pty_write(pss->process, pty_buf_init(pss->buffer + 1, pss->len - 1));
    if (err) {
        lwsl_err("uv_write: %s (%s)\n", uv_err_name(err), uv_strerror(err));
        return -1;
    }
    break;
```

### Server-Side Fragment Reassembly

The server handles WebSocket message fragmentation:

```c
case LWS_CALLBACK_RECEIVE:
    // Accumulate fragments
    if (pss->buffer == NULL) {
        pss->buffer = xmalloc(len);
        pss->len = len;
        memcpy(pss->buffer, in, len);
    } else {
        pss->buffer = xrealloc(pss->buffer, pss->len + len);
        memcpy(pss->buffer + pss->len, in, len);
        pss->len += len;
    }

    // Wait for complete message
    if (lws_remaining_packet_payload(wsi) > 0 || !lws_is_final_fragment(wsi)) {
        return 0;
    }

    // Process complete message...
```

This is important: large messages may arrive in multiple WebSocket frames, and ttyd correctly reassembles them before processing.

---

## Flow Control (Backpressure)

ttyd implements a two-level flow control system:

### Level 1: Server-side (PTY read pacing)

As described above, the server reads ONE chunk from the PTY, stops reading, writes it to WebSocket, then resumes reading. This prevents the server from buffering unbounded PTY output.

```
PTY read -> uv_read_stop -> WS write -> pty_resume -> PTY read -> ...
```

### Level 2: Client-side (xterm.js write pacing)

The frontend implements explicit PAUSE/RESUME flow control:

```typescript
public writeData(data: string | Uint8Array) {
    const { terminal, textEncoder } = this;
    const { limit, highWater, lowWater } = this.options.flowControl;

    this.written += data.length;
    if (this.written > limit) {
        // Use write callback to track pending writes
        terminal.write(data, () => {
            this.pending = Math.max(this.pending - 1, 0);
            if (this.pending < lowWater) {
                this.socket?.send(textEncoder.encode(Command.RESUME));
            }
        });
        this.pending++;
        this.written = 0;
        if (this.pending > highWater) {
            this.socket?.send(textEncoder.encode(Command.PAUSE));
        }
    } else {
        terminal.write(data);
    }
}
```

Default flow control parameters (from `app.tsx`):
```typescript
const flowControl = {
    limit: 100000,    // bytes written before checking backpressure
    highWater: 10,    // pending writes before sending PAUSE
    lowWater: 4,      // pending writes before sending RESUME
} as FlowControl;
```

**How it works**:
1. The client tracks total bytes written to xterm.js (`this.written`)
2. Every 100KB of data written, it starts tracking pending xterm.js write completions
3. `terminal.write(data, callback)` -- the callback fires when xterm.js has processed the data
4. When pending writes exceed 10 (highWater), client sends PAUSE to server
5. Server receives PAUSE, calls `pty_pause()` which stops reading from PTY via `uv_read_stop()`
6. When pending writes drop below 4 (lowWater), client sends RESUME
7. Server receives RESUME, calls `pty_resume()` which restarts PTY reading

This prevents scenarios where a fast-producing process (like `cat /dev/urandom`) overwhelms the browser's rendering pipeline.

### Server-Side PAUSE/RESUME Handling

```c
case PAUSE:
    pty_pause(pss->process);
    break;
case RESUME:
    pty_resume(pss->process);
    break;
```

```c
void pty_pause(pty_process *process) {
  if (process == NULL) return;
  if (process->paused) return;
  uv_read_stop((uv_stream_t *) process->out);
}

void pty_resume(pty_process *process) {
  if (process == NULL) return;
  if (!process->paused) return;
  process->out->data = process;
  uv_read_start((uv_stream_t *) process->out, alloc_cb, read_cb);
}
```

---

## Resize Handling

### Frontend: Detecting and Sending Resize

The `FitAddon` from xterm.js calculates the optimal terminal dimensions based on the container size. When the window resizes:

```typescript
// Window resize triggers fit
register(addEventListener(window, 'resize', () => fitAddon.fit()));

// xterm.js emits onResize after fit() changes dimensions
register(
    terminal.onResize(({ cols, rows }) => {
        const msg = JSON.stringify({ columns: cols, rows: rows });
        this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
        if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
    })
);
```

The resize message format:
```
'1' + '{"columns":120,"rows":40}'
```

### Server: Processing Resize

```c
case RESIZE_TERMINAL:
    if (pss->process == NULL) break;
    json_object_put(
        parse_window_size(pss->buffer + 1, pss->len - 1,
                          &pss->process->columns, &pss->process->rows));
    pty_resize(pss->process);
    break;
```

```c
static json_object *parse_window_size(const char *buf, size_t len,
                                       uint16_t *cols, uint16_t *rows) {
  json_tokener *tok = json_tokener_new();
  json_object *obj = json_tokener_parse_ex(tok, buf, len);
  struct json_object *o = NULL;

  if (json_object_object_get_ex(obj, "columns", &o))
      *cols = (uint16_t)json_object_get_int(o);
  if (json_object_object_get_ex(obj, "rows", &o))
      *rows = (uint16_t)json_object_get_int(o);

  json_tokener_free(tok);
  return obj;
}
```

### PTY Resize (Unix)

```c
bool pty_resize(pty_process *process) {
  if (process == NULL) return false;
  if (process->columns <= 0 || process->rows <= 0) return false;
  struct winsize size = {process->rows, process->columns, 0, 0};
  return ioctl(process->pty, TIOCSWINSZ, &size) == 0;
}
```

The `TIOCSWINSZ` ioctl sends a `SIGWINCH` signal to the foreground process group of the PTY, which causes programs like vim, less, etc. to query the new terminal size and redraw.

---

## Connection Lifecycle and Reconnection

### Connection Establishment

1. **Page loads**: Frontend fetches auth token from `/token` endpoint
2. **WebSocket opens**: `new WebSocket(wsUrl, ['tty'])` -- note the `tty` subprotocol
3. **Socket binaryType**: Set to `'arraybuffer'` for efficient binary handling
4. **Client sends handshake**: `{"AuthToken":"...", "columns":120, "rows":40}`
5. **Server spawns PTY process** (if auth passes)
6. **Server sends initial messages**:
   - `SET_WINDOW_TITLE`: hostname and command
   - `SET_PREFERENCES`: JSON configuration
7. **After initial messages sent, server calls `pty_resume()`** to start reading PTY output
8. **Data streaming begins**

### Initial Message Sequence (Server Side)

```c
case LWS_CALLBACK_SERVER_WRITEABLE:
    if (!pss->initialized) {
        if (pss->initial_cmd_index == sizeof(initial_cmds)) {
            pss->initialized = true;
            pty_resume(pss->process);  // Start reading PTY ONLY after init
            break;
        }
        if (send_initial_message(wsi, pss->initial_cmd_index) < 0) {
            // error handling
        }
        pss->initial_cmd_index++;
        lws_callback_on_writable(wsi);  // Schedule next initial message
        break;
    }
```

Important: PTY output is NOT started until all initial messages have been sent. This ensures the client has the title and preferences before receiving terminal data.

### Reconnection Logic (Frontend)

```typescript
private onSocketClose(event: CloseEvent) {
    console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

    const { refreshToken, connect, doReconnect, overlayAddon } = this;
    overlayAddon.showOverlay('Connection Closed');
    this.dispose();  // Clean up all listeners

    if (event.code !== 1000 && doReconnect) {
        // Abnormal close: auto-reconnect
        overlayAddon.showOverlay('Reconnecting...');
        refreshToken().then(connect);
    } else if (this.closeOnDisconnect) {
        window.close();
    } else {
        // Normal close (1000): manual reconnect via Enter key
        const { terminal } = this;
        const keyDispose = terminal.onKey(e => {
            const event = e.domEvent;
            if (event.key === 'Enter') {
                keyDispose.dispose();
                overlayAddon.showOverlay('Reconnecting...');
                refreshToken().then(connect);
            }
        });
        overlayAddon.showOverlay('Press Enter to Reconnect');
    }
}
```

Key reconnection behaviors:
- **Close code 1000 (normal)**: Process exited cleanly. Shows "Press Enter to Reconnect".
- **Close code != 1000 (abnormal)**: Auto-reconnects by refreshing the auth token and establishing a new WebSocket.
- **On reconnect**: `terminal.reset()` clears the terminal, re-enables stdin, and shows "Reconnected" overlay.

```typescript
private onSocketOpen() {
    // ...
    if (this.opened) {
        terminal.reset();                         // Clear terminal state
        terminal.options.disableStdin = false;    // Re-enable input
        overlayAddon.showOverlay('Reconnected', 300);
    } else {
        this.opened = true;
    }

    this.doReconnect = this.reconnect;
    this.initListeners();  // Re-register all event listeners
    terminal.focus();
}
```

### Connection Close (Server Side)

When the WebSocket closes, the server kills the PTY process:

```c
case LWS_CALLBACK_CLOSED:
    // ...
    if (pss->process != NULL) {
        ((pty_ctx_t *)pss->process->ctx)->ws_closed = true;
        if (process_running(pss->process)) {
            pty_pause(pss->process);
            lwsl_notice("killing process, pid: %d\n", pss->process->pid);
            pty_kill(pss->process, server->sig_code);
        }
    }
```

**Important**: There is NO state restoration on reconnect. A reconnect spawns a NEW PTY process. ttyd does not maintain terminal state between connections -- each connection gets a fresh shell. This is a deliberate simplification.

---

## Key Architectural Decisions

### 1. Single-Byte Command Prefix Protocol

The protocol is one byte for the command type, followed by raw payload. No length prefix, no checksums, no sequence numbers, no message IDs. WebSocket already provides framing, ordering, and integrity, so ttyd doesn't duplicate it.

**Why it works**: WebSocket guarantees message boundaries, ordering, and integrity. The application layer only needs to identify message types.

### 2. Binary WebSocket Frames Throughout

All messages use `LWS_WRITE_BINARY` / `binaryType = 'arraybuffer'`. No text frame encoding/decoding overhead. This is critical for terminal data which is arbitrary bytes, not valid UTF-8.

### 3. Read-One-Write-One PTY Pacing

The server reads one chunk from the PTY, stops reading, writes it to WebSocket, then resumes. This provides inherent backpressure without complex buffering:

```
read -> stop -> WS write -> resume -> read -> stop -> ...
```

Benefits:
- Memory usage is bounded (only one PTY buffer in flight at a time)
- No accumulation of stale data in server-side buffers
- Natural pacing that adapts to network speed

### 4. Client-Initiated Flow Control (PAUSE/RESUME)

The client tells the server when to stop/start sending data, based on xterm.js's rendering backlog. This is the right place for this decision -- only the client knows how fast it can render.

Parameters: 100KB write threshold, highWater=10 pending writes, lowWater=4.

### 5. libuv Event Loop

Using libuv for the event loop provides:
- Cross-platform async I/O (Windows ConPTY + Unix PTY)
- Non-blocking pipe reads/writes
- Thread-safe async notifications (for process exit)
- Efficient timer and signal handling

### 6. libwebsockets for WebSocket

libwebsockets handles:
- HTTP serving (the index.html, token endpoint)
- WebSocket upgrade negotiation
- WebSocket framing, masking, ping/pong
- SSL/TLS termination
- Compression (per-message deflate)
- Connection management and per-session state (`pss_tty`)

### 7. No State Persistence

ttyd explicitly does NOT persist terminal state across reconnections. Each connection spawns a fresh process. This eliminates complexity around:
- Scrollback buffer management
- Terminal emulator state serialization
- Race conditions during reconnection
- Stale state cleanup

The trade-off is that reconnection loses all context. For ttyd's use case (sharing terminals), this is acceptable.

### 8. Deferred PTY Start

The PTY process output is paused (`process->paused = true` after spawn) until:
1. All initial messages (title, preferences) are sent to the client
2. Client has time to configure itself based on preferences

Only then does the server call `pty_resume()`. This prevents the race condition where PTY output arrives before the client is ready to handle it.

### 9. WebSocket Subprotocol

```typescript
this.socket = new WebSocket(this.options.wsUrl, ['tty']);
```

The `tty` subprotocol is used during the WebSocket handshake. This allows the server to reject non-ttyd WebSocket connections and helps with reverse proxy routing.

### 10. Token-Based Authentication

Rather than sending credentials in the WebSocket URL (which would be logged), ttyd:
1. Client fetches a token from `/token` (over HTTPS)
2. Client sends the token in the first WebSocket message as `{"AuthToken": "..."}`
3. Server validates the token before spawning the PTY

---

## Summary: What Makes ttyd Reliable

| Aspect | Decision | Impact |
|--------|----------|--------|
| Protocol simplicity | 1-byte command prefix | Zero parsing overhead, no bugs in complex parsers |
| Binary frames | arraybuffer throughout | No UTF-8 encoding issues with raw terminal data |
| PTY read pacing | Read-stop-write-resume | Bounded memory, natural backpressure |
| Client flow control | PAUSE/RESUME commands | Prevents browser rendering overload |
| No state persistence | Fresh process per connection | Eliminates state sync complexity |
| Deferred start | PTY paused until client ready | No data loss during initialization |
| Fragment reassembly | Server accumulates until final | Handles large messages correctly |
| Event-driven I/O | libuv + libwebsockets | Efficient, non-blocking, cross-platform |

---

## Source Code References

- Backend protocol handler: `src/protocol.c` (~250 lines)
- Server configuration and main: `src/server.c`
- PTY management: `src/pty.c` + `src/pty.h`
- Protocol constants: `src/server.h`
- Frontend xterm wrapper: `html/src/components/terminal/xterm/index.ts` (~400 lines)
- Frontend app entry: `html/src/components/app.tsx`
- Frontend terminal component: `html/src/components/terminal/index.tsx`

Repository: https://github.com/tsl0922/ttyd
