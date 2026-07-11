# Terminal WebSocket Protocol

The supported browser terminal path uses the ttyd-compatible WebSocket framing implemented in `crates/conductor-server/src/routes/ttyd_protocol.rs`. This file documents the live contract; the previously described `CTP2` envelope is not implemented and must not be used by clients.

## Negotiation and authentication

- The local backend exposes the authenticated terminal-token endpoint and terminal WebSocket facade.
- ttyd-compatible clients request the `tty` WebSocket subprotocol.
- Hosted paired-device sessions receive a short-lived, terminal-scoped relay JWT. The browser and bridge connect to the relay's terminal-specific paths; the relay forwards WebSocket frames without changing the terminal protocol.
- The bridge's long-lived pairing credential is used only on the bridge side. It must never be sent to a browser or placed in a dashboard URL.

## Client-to-server frames

The first byte selects the command:

| Byte | Command | Payload |
|------|---------|---------|
| `{` | Handshake | UTF-8 JSON object containing `columns` and `rows`; an upstream ttyd connection may also include `AuthToken` |
| `0` | Input | Raw terminal input bytes |
| `1` | Resize | UTF-8 JSON object containing `columns` and `rows` |
| `2` | Pause | No payload |
| `3` | Resume | No payload |

Dimensions are positive and bounded by the backend. Oversized or malformed frames are rejected.

## Server-to-client frames

| Byte | Command | Payload |
|------|---------|---------|
| `0` | Output | Raw terminal output or an ANSI restore snapshot |
| `1` | Window title | UTF-8 title |
| `2` | Preferences | UTF-8 JSON preferences |

On initial handshake the backend sends preferences and the current restore snapshot before streaming later output. When a subscriber lags or resumes after a pause, the backend sends the current ANSI restore snapshot as an output frame. There is no separate binary restore-envelope header.

## Relay control versus terminal data

The paired-device control channel uses tagged JSON messages from `conductor-types`, including `terminal_proxy_start`. After a terminal-specific relay connection is established, its WebSocket carries the ttyd-compatible frames above directly. Control-channel JSON and terminal-data frames are deliberately separate contracts.

## Change discipline

The Rust implementation is authoritative. Any command-byte change must update, in the same PR:

- `crates/conductor-server/src/routes/ttyd_protocol.rs`
- relay pause/resume/resize handling in `crates/conductor-relay/src/relay.rs`
- bridge translation in `bridge-cmd/relay/client.go`
- the browser clients in `packages/web/src/components/sessions/`
- cross-language contract tests and this document

Do not add a second frame format without explicit negotiation and end-to-end tests covering local and paired-device paths.
