# ttyd Protocol Analysis: Reference Implementation vs Conductor OSS

## Executive Summary

This document provides a comprehensive analysis of the ttyd WebSocket terminal protocol
as implemented in the reference `tsl0922/ttyd` project, compared against the Conductor OSS
implementation. The analysis covers the binary protocol format, flow control mechanism,
xterm.js integration, and identifies discrepancies in Conductor's implementation.

---

## 1. Protocol Constants (from `src/server.h`)

The ttyd protocol uses single ASCII character bytes as command prefixes. Crucially,
**client-to-server and server-to-client commands share the same byte values but have
different meanings based on direction**.

### Server-to-Client Messages

| Constant           | Char | Byte (hex) | Description                    |
|--------------------|------|------------|--------------------------------|
| `OUTPUT`           | `'0'`| `0x30`     | Terminal output data           |
| `SET_WINDOW_TITLE` | `'1'`| `0x31`     | Set the window/tab title       |
| `SET_PREFERENCES`  | `'2'`| `0x32`     | JSON preferences for the client|

### Client-to-Server Messages

| Constant           | Char | Byte (hex) | Description                    |
|--------------------|------|------------|--------------------------------|
| `INPUT`            | `'0'`| `0x30`     | Keyboard/terminal input data   |
| `RESIZE_TERMINAL`  | `'1'`| `0x31`     | JSON `{columns, rows}`        |
| `PAUSE`            | `'2'`| `0x32`     | Pause PTY output (backpressure)|
| `RESUME`           | `'3'`| `0x33`     | Resume PTY output              |
| `JSON_DATA`        | `'{'`| `0x7B`     | Initial auth/dimensions JSON   |

### Key Insight

The `JSON_DATA` command is special -- it is detected by the opening brace `{` character
of the JSON payload itself. This is used only for the initial handshake message containing
`AuthToken`, `columns`, and `rows`.

---

## 2. Reference Implementation: Client-Side (`html/src/components/terminal/xterm/index.ts`)

### 2.1 Command Enum

```typescript
enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
}
```

### 2.2 WebSocket Connection

```typescript
public connect() {
    this.socket = new WebSocket(this.options.wsUrl, ['tty']);
    const { socket, register } = this;

    socket.binaryType = 'arraybuffer';
    register(addEventListener(socket, 'open', this.onSocketOpen));
    register(addEventListener(socket, 'message', this.onSocketData));
    register(addEventListener(socket, 'close', this.onSocketClose));
    register(addEventListener(socket, 'error', () => (this.doReconnect = false)));
}
```

**Key details:**
- Uses WebSocket subprotocol `['tty']`
- Binary type is `arraybuffer`
- Error handler disables reconnect

### 2.3 Handshake (onSocketOpen)

```typescript
private onSocketOpen() {
    const { textEncoder, terminal, overlayAddon } = this;
    const msg = JSON.stringify({
        AuthToken: this.token,
        columns: terminal.cols,
        rows: terminal.rows
    });
    this.socket?.send(textEncoder.encode(msg));

    if (this.opened) {
        terminal.reset();
        terminal.options.disableStdin = false;
        overlayAddon.showOverlay('Reconnected', 300);
    } else {
        this.opened = true;
    }

    this.doReconnect = this.reconnect;
    this.initListeners();
    terminal.focus();
}
```

**Key details:**
- First message is raw JSON (no command prefix) -- the `{` is the `JSON_DATA` command
- Includes `AuthToken` for authentication
- On reconnect, resets terminal state

### 2.4 Message Handling (onSocketData)

```typescript
private onSocketData(event: MessageEvent) {
    const { textDecoder } = this;
    const rawData = event.data as ArrayBuffer;
    const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
    const data = rawData.slice(1);

    switch (cmd) {
        case Command.OUTPUT:
            this.writeFunc(data);
            break;
        case Command.SET_WINDOW_TITLE:
            this.title = textDecoder.decode(data);
            document.title = this.title;
            break;
        case Command.SET_PREFERENCES:
            this.applyPreferences({
                ...this.options.clientOptions,
                ...JSON.parse(textDecoder.decode(data)),
                ...this.parseOptsFromUrlQuery(window.location.search),
            });
            break;
        default:
            console.warn(`[ttyd] unknown command: ${cmd}`);
            break;
    }
}
```

**Key details:**
- Reads first byte as command character
- Uses `String.fromCharCode()` for comparison (char-based, not byte-based)
- Calls `this.writeFunc(data)` -- NOT `this.writeData()` directly
- `writeFunc` is initially `(data) => this.writeData(new Uint8Array(data))`
- `writeFunc` gets reassigned when zmodem/trzsz is enabled

### 2.5 Flow Control (writeData)

This is the most critical method for performance:

```typescript
public writeData(data: string | Uint8Array) {
    const { terminal, textEncoder } = this;
    const { limit, highWater, lowWater } = this.options.flowControl;

    this.written += data.length;
    if (this.written > limit) {
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

**Critical flow control behavior:**

1. **Accumulate bytes**: Track `this.written` across multiple messages
2. **Below threshold**: Just call `terminal.write(data)` with NO callback (no flow control overhead)
3. **Above threshold** (`this.written > limit`):
   - Call `terminal.write(data, callback)` WITH a completion callback
   - Increment `this.pending` (tracks in-flight writes)
   - Reset `this.written = 0`
   - In the callback: decrement pending, send RESUME if pending drops below lowWater
   - After write call: send PAUSE if pending exceeds highWater
4. **PAUSE command**: Sent as `textEncoder.encode(Command.PAUSE)` = `textEncoder.encode('2')` = byte `0x32`
5. **RESUME command**: Sent as `textEncoder.encode(Command.RESUME)` = `textEncoder.encode('3')` = byte `0x33`

**Important nuance**: PAUSE and RESUME are sent as the string character encoded via TextEncoder,
NOT as raw byte arrays. `textEncoder.encode('2')` produces `Uint8Array([0x32])` which is the
same as `new Uint8Array([0x32])`, so the result is identical -- but the reference uses TextEncoder
for consistency.

### 2.6 Sending Input (sendData)

```typescript
public sendData(data: string | Uint8Array) {
    const { socket, textEncoder } = this;
    if (socket?.readyState !== WebSocket.OPEN) return;

    if (typeof data === 'string') {
        const payload = new Uint8Array(data.length * 3 + 1);
        payload[0] = Command.INPUT.charCodeAt(0);
        const stats = textEncoder.encodeInto(data, payload.subarray(1));
        socket.send(payload.subarray(0, (stats.written as number) + 1));
    } else {
        const payload = new Uint8Array(data.length + 1);
        payload[0] = Command.INPUT.charCodeAt(0);
        payload.set(data, 1);
        socket.send(payload);
    }
}
```

**Key details:**
- Uses `Command.INPUT.charCodeAt(0)` = `'0'.charCodeAt(0)` = `0x30`
- Pre-allocates `data.length * 3 + 1` for worst-case UTF-8 expansion
- Uses `encodeInto()` for zero-copy efficiency
- Sends only the actually-written portion via `subarray()`

### 2.7 Resize

```typescript
terminal.onResize(({ cols, rows }) => {
    const msg = JSON.stringify({ columns: cols, rows: rows });
    this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
    if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
});
```

**Key detail**: Resize sends `textEncoder.encode('1' + jsonString)` -- the command character
is prepended to the JSON string before encoding. This is different from Conductor's approach
of constructing a separate byte array.

---

## 3. Reference Implementation: Server-Side (`src/protocol.c`)

### 3.1 Initial Messages (Server -> Client)

On connection established, server sends two messages in sequence:
1. `SET_WINDOW_TITLE` (byte `'1'` + hostname string)
2. `SET_PREFERENCES` (byte `'2'` + JSON preferences string)

```c
static char initial_cmds[] = {SET_WINDOW_TITLE, SET_PREFERENCES};
```

The server pauses the PTY until all initial messages are sent:
```c
case LWS_CALLBACK_SERVER_WRITEABLE:
    if (!pss->initialized) {
        // Send initial_cmds one by one
        // After all sent: pss->initialized = true; pty_resume(pss->process);
    }
```

### 3.2 Output (Server -> Client)

```c
static void wsi_output(struct lws *wsi, pty_buf_t *buf) {
    char *message = xmalloc(LWS_PRE + 1 + buf->len);
    char *ptr = message + LWS_PRE;
    *ptr = OUTPUT;                        // First byte: '0' (0x30)
    memcpy(ptr + 1, buf->base, buf->len); // Rest: raw PTY output
    lws_write(wsi, ptr, buf->len + 1, LWS_WRITE_BINARY);
}
```

### 3.3 Receiving Client Messages

```c
case LWS_CALLBACK_RECEIVE:
    const char command = pss->buffer[0];
    switch (command) {
        case INPUT:            // '0' - write to PTY
        case RESIZE_TERMINAL:  // '1' - resize PTY
        case PAUSE:            // '2' - pause PTY reads
        case RESUME:           // '3' - resume PTY reads
        case JSON_DATA:        // '{' - initial auth+dimensions
    }
```

### 3.4 Flow Control (Server-Side)

- **PAUSE**: Calls `pty_pause(pss->process)` -- stops reading from PTY fd
- **RESUME**: Calls `pty_resume(pss->process)` -- resumes reading from PTY fd
- After sending output, the server calls `pty_resume()` to request more data

This means the server-side flow control is at the file descriptor level -- it literally
stops reading from the PTY when the client sends PAUSE.

---

## 4. Conductor OSS Implementation Comparison

### 4.1 What Conductor Gets Right

1. **Command byte values**: Correctly uses `0x30`, `0x31`, `0x32`, `0x33`
2. **Binary WebSocket frames**: Correctly uses `arraybuffer` binary type
3. **Input encoding**: Matches the reference `encodeInto()` approach
4. **Resize format**: Correctly sends `{columns, rows}` JSON
5. **Handshake**: Correctly sends raw JSON as first message (JSON_DATA)

### 4.2 Discrepancies Found

#### Issue 1: Flow Control is Fundamentally Different

**Reference implementation**: Flow control uses xterm.js's `terminal.write(data, callback)`
completion callback to track when data has been rendered. The PAUSE/RESUME cycle is:

```
1. Data arrives from server
2. Write to xterm with callback
3. Increment pending counter
4. If pending > highWater: SEND PAUSE
5. When xterm finishes rendering: callback fires
6. Decrement pending counter
7. If pending < lowWater: SEND RESUME
```

**Conductor implementation**: Flow control is based on counting incoming messages and
bytes, NOT on xterm.js write completion:

```
1. Data arrives from server
2. Increment bytesWritten and pendingWrites
3. Write to xterm (decoding to string first)
4. If bytesWritten > threshold AND pendingWrites > highWater: SEND PAUSE
5. markWriteComplete() called from hook's write callback
```

**The problem**: Conductor increments `pendingWrites` on every incoming message regardless,
and the flow control check is coupled to the byte threshold. The reference only enters the
flow control path when accumulated bytes exceed the limit, and it tracks *xterm rendering
completion* not just *message receipt*.

#### Issue 2: Output Data Written as String Instead of Uint8Array

**Reference**: Passes `Uint8Array` to xterm.js:
```typescript
private writeFunc = (data: ArrayBuffer) => this.writeData(new Uint8Array(data));
// writeData calls: terminal.write(data)  // data is Uint8Array
```

**Conductor**: Decodes to string first, then writes:
```typescript
client.setOnData((data) => {
    if (typeof data === 'string') {
        terminal.write(data, callback);
    } else {
        const str = new TextDecoder().decode(data);
        terminal.write(str, callback);
    }
});
```

And in `handleOutput()`:
```typescript
const str = this.textDecoder.decode(data, { stream: true });
this.onData?.(str);
```

**Impact**: The string decode step is unnecessary overhead. xterm.js natively handles
`Uint8Array` input and can process it more efficiently than decoded strings.

#### Issue 3: PAUSE/RESUME Sent as Raw Byte Arrays

**Reference**: Sends PAUSE/RESUME via `textEncoder.encode(Command.PAUSE)`:
```typescript
this.socket?.send(textEncoder.encode(Command.RESUME));  // encode('3')
```

**Conductor**: Sends as raw `Uint8Array`:
```typescript
const payload = new Uint8Array([CMD_PAUSE]);  // [0x32]
this.socket?.send(payload);
```

**Impact**: Functionally identical (both produce a single byte `0x32` or `0x33`), but
the Conductor approach is actually slightly more explicit. No functional issue here.

#### Issue 4: Missing WebSocket Subprotocol

**Reference**: Connects with subprotocol `['tty']`:
```typescript
this.socket = new WebSocket(this.options.wsUrl, ['tty']);
```

**Conductor**: Connects without subprotocol:
```typescript
this.socket = new WebSocket(wsUrl);
```

**Impact**: The ttyd server may check for the `tty` subprotocol. Since Conductor has its
own backend this is irrelevant, but worth noting for protocol compatibility.

#### Issue 5: handleMessage Uses Wrong Constants for Server Messages

**Conductor's handleMessage**:
```typescript
switch (cmd) {
    case CMD_OUTPUT:   // 0x30 - correct
        this.handleOutput(payload);
        break;
    case CMD_RESIZE:   // 0x31 - WRONG NAME, should be SET_WINDOW_TITLE
        this.handleWindowTitle(payload);
        break;
    case CMD_PREFS:    // 0x32 - WRONG NAME, should be SET_PREFERENCES
        this.handlePreferences(payload);
        break;
}
```

While the byte values are correct (`0x31` for title, `0x32` for prefs), the constant
names are misleading. `CMD_RESIZE` (0x31) is being used to match the server's
`SET_WINDOW_TITLE` (also 0x31). The code works but the naming creates confusion because
`CMD_RESIZE` is defined as a client-to-server command, not a server-to-client one.

---

## 5. Recommended Fixes for Conductor

### Fix 1: Align Flow Control with Reference

```typescript
// In ttydClient.ts handleOutput:
private handleOutput(data: Uint8Array): void {
    this.bytesWritten += data.length;

    if (this.bytesWritten > this.flowControl.writeThreshold) {
        // Pass raw Uint8Array to callback, let it write to xterm with completion tracking
        this.onData?.(data, () => {
            this.pendingWrites = Math.max(this.pendingWrites - 1, 0);
            if (this.pendingWrites < this.flowControl.lowWater) {
                this.sendResume();
            }
        });
        this.pendingWrites++;
        this.bytesWritten = 0;
        if (this.pendingWrites > this.flowControl.highWater) {
            this.sendPause();
        }
    } else {
        // Below threshold: write without flow control overhead
        this.onData?.(data);
    }
}
```

### Fix 2: Write Uint8Array Directly to xterm.js

```typescript
// In useTtydConnection.ts:
client.setOnData((data, writeCallback) => {
    // xterm.js handles Uint8Array natively -- no string decode needed
    if (writeCallback) {
        terminal.write(data, writeCallback);
    } else {
        terminal.write(data);
    }
});
```

### Fix 3: Separate Server and Client Command Constants

```typescript
// Server-to-client commands
const SERVER_OUTPUT = 0x30;           // '0'
const SERVER_SET_WINDOW_TITLE = 0x31; // '1'
const SERVER_SET_PREFERENCES = 0x32;  // '2'

// Client-to-server commands
const CLIENT_INPUT = 0x30;            // '0'
const CLIENT_RESIZE_TERMINAL = 0x31;  // '1'
const CLIENT_PAUSE = 0x32;            // '2'
const CLIENT_RESUME = 0x33;           // '3'
```

---

## 6. Complete Flow Diagram

```
CLIENT                                          SERVER
  |                                                |
  |--- WebSocket Connect (subprotocol: 'tty') ---->|
  |                                                |
  |--- JSON_DATA {'{'} --------------------------->|
  |    {AuthToken, columns, rows}                  |
  |                                                |-- spawn PTY process
  |                                                |-- pause PTY reads
  |                                                |
  |<--- SET_WINDOW_TITLE ('1' + title) ------------|
  |<--- SET_PREFERENCES ('2' + json) --------------|
  |                                                |-- resume PTY reads
  |                                                |
  |<--- OUTPUT ('0' + pty_data) -------------------|<-- PTY output
  |   terminal.write(data)                         |
  |                                                |
  |<--- OUTPUT ('0' + pty_data) -------------------|<-- PTY output
  |<--- OUTPUT ('0' + pty_data) -------------------|<-- PTY output
  |   [accumulated bytes > limit]                  |
  |   terminal.write(data, callback)               |
  |   pending++                                    |
  |   [pending > highWater]                        |
  |--- PAUSE ('2') ------------------------------->|-- pty_pause()
  |                                                |   (stop reading PTY fd)
  |   [xterm render complete, callback fires]      |
  |   pending--                                    |
  |   [pending < lowWater]                         |
  |--- RESUME ('3') ------------------------------>|-- pty_resume()
  |                                                |   (resume reading PTY fd)
  |                                                |
  |--- INPUT ('0' + keystrokes) ------------------>|-- pty_write()
  |                                                |
  |--- RESIZE_TERMINAL ('1' + json) -------------->|-- pty_resize()
  |    {columns, rows}                             |
  |                                                |
  |<--- [WebSocket close] ------------------------ |-- process exits
```

---

## 7. Source Files Analyzed

| File | Repository | Purpose |
|------|-----------|---------|
| `html/src/components/terminal/xterm/index.ts` | tsl0922/ttyd | Client WebSocket + xterm.js integration |
| `html/src/components/terminal/index.tsx` | tsl0922/ttyd | Preact Terminal component lifecycle |
| `src/server.h` | tsl0922/ttyd | Protocol constants + server structures |
| `src/protocol.c` | tsl0922/ttyd | Server WebSocket handler + PTY bridge |
| `packages/web/.../ttydClient.ts` | conductor-oss | Conductor's ttyd client implementation |
| `packages/web/.../useTtydConnection.ts` | conductor-oss | Conductor's React hook for ttyd |

---

## 8. Default Flow Control Values

The reference ttyd project does not hardcode the flow control values in the TypeScript client.
They are passed in via `XtermOptions.flowControl` from the parent component. Typical defaults
observed in deployments:

| Parameter | Purpose | Typical Value |
|-----------|---------|---------------|
| `limit` | Bytes accumulated before engaging flow control | ~100,000 (100KB) |
| `highWater` | Pending writes threshold to send PAUSE | ~10 |
| `lowWater` | Pending writes threshold to send RESUME | ~4 |

Conductor uses these same values in `DEFAULT_FLOW_CONTROL`, which is correct.
