# Terminal Frame Protocol

Conductor Phase 2 uses explicit websocket frame classes for live terminal sessions:

- Text `control` frames for lifecycle events such as `ready`, `ack`, `pong`, and `exit`
- Text `recovery` frames when the backend detects lag and is about to resend restore state
- Text `error` frames for protocol or runtime failures
- Binary `restore` frames for a full terminal restore snapshot
- Binary `stream` frames for incremental terminal output

This removes the old implicit contract where a JSON `"snapshot"` message meant "the next binary payload should be treated as a restore snapshot".

## Binary Frames

All binary frames use this prefix:

```text
0..4   magic   "CTP2"
4      u8      protocol version (currently 1)
5      u8      frame kind
6..14  u64be   terminal sequence
```

Frame kinds:

- `1`: `restore`
- `2`: `stream`

### Restore Frame

After the shared prefix, restore frames append:

```text
14     u8      restore snapshot version
15     u8      restore reason (1 = attach, 2 = lagged)
16..18 u16be   cols
18..20 u16be   rows
20..   bytes   ANSI restore payload
```

The restore payload is the same rendered ANSI state that the backend persists for restart-safe terminal recovery.

### Stream Frame

After the shared prefix, stream frames append:

```text
14..   bytes   incremental terminal output
```

## Recovery Flow

When a websocket subscriber lags behind the backend broadcast buffer:

1. The server sends a text `recovery` frame with `reason: "lagged"` and the skipped count.
2. The server immediately follows with a binary `restore` frame.
3. The client resets xterm with that restore payload and then continues applying later `stream` frames.

## Backend State Contract

The backend now routes terminal output through one state update path:

1. Append terminal bytes to the capture log.
2. Update the in-memory terminal state store.
3. Persist the restore snapshot.
4. Emit a structured `stream` event with the same sequence number used by the restore snapshot.

That keeps restore persistence and live streaming aligned to the same terminal truth.
