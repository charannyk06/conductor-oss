use crate::routes::terminal::control::{TerminalControlMessage, TerminalQuery};
use crate::routes::terminal::snapshot::build_terminal_restore_snapshot;
use crate::state::{
    AppState, TerminalModeState, TerminalRestoreSnapshot, TerminalStreamChunk,
    TerminalStreamEvent, TerminalSupervisor,
};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{
    sse::{Event as SseEvent, KeepAlive, Sse},
    IntoResponse, Response,
};
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::json;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{self as stream, StreamExt};

// ---------------------------------------------------------------------------
// Raw binary WebSocket protocol (ttyd-style)
// ---------------------------------------------------------------------------
//
// Server → Client:
//   Binary frames: [type: u8] [payload...]
//     0x00 = stream output (raw PTY bytes)
//     0x01 = restore snapshot (raw ANSI bytes with modes prepended)
//   Text frames: JSON control events (ready, exit, error, recovery, pong, input_queue_full)
//
// Client → Server:
//   Binary frames: [type: u8] [payload...]
//     0x00 = terminal input (UTF-8 text)
//     0x01 = resize (JSON: {"cols":N,"rows":N})
//     0x02 = ping/keepalive
//   Text frames: JSON control messages (legacy, still accepted)

const WS_MSG_INPUT: u8 = 0x00;
const WS_MSG_RESIZE: u8 = 0x01;
const WS_MSG_PING: u8 = 0x02;

const WS_OUT_STREAM: u8 = 0x00;
const WS_OUT_RESTORE: u8 = 0x01;

// ---------------------------------------------------------------------------
// SSE endpoint (fallback transport — unchanged)
// ---------------------------------------------------------------------------

pub async fn terminal_stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(session) = state.get_session(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    };

    let supervisor = TerminalSupervisor::new(state.clone());
    if let Err(err) = supervisor
        .authorize_terminal_stream_access(&id, query.token.as_deref(), &headers)
        .await
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response();
    }

    let cols = query
        .cols
        .unwrap_or(crate::state::DEFAULT_TERMINAL_COLS)
        .max(1);
    let rows = query
        .rows
        .unwrap_or(crate::state::DEFAULT_TERMINAL_ROWS)
        .max(1);
    let resized = supervisor
        .prepare_terminal_runtime(&id, Some(cols), Some(rows))
        .await
        .unwrap_or(false);
    let handle = state.ensure_terminal_host(&id).await;

    let terminal_events = handle.terminal_tx.subscribe();
    let sequence_floor = Arc::new(AtomicU64::new(0));
    let mut initial_events = vec![Ok::<SseEvent, Infallible>(
        SseEvent::default().data(server_ready_event(&id)),
    )];

    // Allow the PTY process to handle SIGWINCH and redraw before snapshot capture.
    if resized {
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }

    if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await {
        sequence_floor.store(snapshot.sequence, Ordering::Relaxed);
        if should_send_initial_restore(&snapshot, query.sequence) {
            initial_events.push(Ok(SseEvent::default().data(server_terminal_restore_event(
                &id,
                &snapshot,
                crate::state::TerminalSnapshotReason::Attach,
                crate::state::LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
            ))));
        }
    }

    let session_id = id.clone();
    let state_for_updates = state.clone();
    let sequence_floor_for_updates = sequence_floor.clone();
    let updates = BroadcastStream::new(terminal_events)
        .then(move |result| {
            let session_id = session_id.clone();
            let state = state_for_updates.clone();
            let sequence_floor = sequence_floor_for_updates.clone();
            async move {
                match result {
                    Ok(TerminalStreamEvent::Stream(chunk)) => {
                        if should_skip_stream_chunk(
                            Some(sequence_floor.load(Ordering::Relaxed)),
                            chunk.sequence,
                        ) {
                            None
                        } else {
                            Some(Ok(SseEvent::default()
                                .data(server_terminal_stream_event(&session_id, &chunk))))
                        }
                    }
                    Ok(TerminalStreamEvent::Exit(exit_code)) => Some(Ok(
                        SseEvent::default().data(server_exit_event(&session_id, exit_code))
                    )),
                    Ok(TerminalStreamEvent::Error(err)) => Some(Ok(
                        SseEvent::default().data(server_error_event(&session_id, err))
                    )),
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(
                        skipped,
                    )) => {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if let Some(session) = state.get_session(&session_id).await {
                            if let Ok(Some(snapshot)) =
                                build_terminal_restore_snapshot(&state, &session).await
                            {
                                sequence_floor.store(snapshot.sequence, Ordering::Relaxed);
                                return Some(Ok(SseEvent::default().data(
                                    server_terminal_restore_event(
                                        &session_id,
                                        &snapshot,
                                        crate::state::TerminalSnapshotReason::Lagged,
                                        crate::state::LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
                                    ),
                                )));
                            }
                        }

                        Some(Ok(SseEvent::default().data(server_error_event(
                            &session_id,
                            format!("Terminal stream skipped {skipped} frames while catching up"),
                        ))))
                    }
                }
            }
        })
        .filter_map(|event| event);

    Sse::new(stream::iter(initial_events).chain(updates))
        .keep_alive(KeepAlive::default())
        .into_response()
}

// ---------------------------------------------------------------------------
// WebSocket endpoint (primary transport — raw binary protocol)
// ---------------------------------------------------------------------------

pub async fn terminal_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if state.get_session(&id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    }

    let supervisor = TerminalSupervisor::new(state.clone());
    if let Err(err) = supervisor
        .authorize_terminal_access(&id, query.token.as_deref(), &headers)
        .await
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response();
    }

    let cols = query
        .cols
        .unwrap_or(crate::state::DEFAULT_TERMINAL_COLS)
        .max(1);
    let rows = query
        .rows
        .unwrap_or(crate::state::DEFAULT_TERMINAL_ROWS)
        .max(1);
    let client_sequence = query.sequence;
    ws.on_upgrade(move |socket| {
        handle_terminal_socket(socket, state, id, cols, rows, client_sequence)
    })
}

async fn handle_terminal_socket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session_id: String,
    mut cols: u16,
    mut rows: u16,
    client_sequence: Option<u64>,
) {
    let supervisor = TerminalSupervisor::new(state.clone());

    // Send ready as text JSON — lets the client know the connection is live.
    if socket
        .send(Message::Text(server_ready_event(&session_id).into()))
        .await
        .is_err()
    {
        return;
    }

    let resized = supervisor
        .prepare_terminal_runtime(&session_id, Some(cols), Some(rows))
        .await
        .unwrap_or(false);
    let handle = state.ensure_terminal_host(&session_id).await;
    let mut terminal_events = Some(handle.terminal_tx.subscribe());
    let mut stream_sequence_floor = None;

    // After a resize the PTY process needs time to handle SIGWINCH and redraw.
    if resized {
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }

    // Send restore snapshot as raw binary (type 0x01 + ANSI modes prefix + payload).
    if let Some(session) = state.get_session(&session_id).await {
        if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await {
            if should_send_initial_restore(&snapshot, client_sequence) {
                let raw = encode_raw_restore_binary(
                    &snapshot,
                    crate::state::LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
                );
                if socket
                    .send(Message::Binary(raw.into()))
                    .await
                    .is_err()
                {
                    return;
                }
                stream_sequence_floor = Some(snapshot.sequence);
            } else {
                stream_sequence_floor = Some(snapshot.sequence);
            }
        }
    }

    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    ping_interval.reset();

    loop {
        tokio::select! {
            attach_event = async {
                match terminal_events.as_mut() {
                    Some(receiver) => Some(receiver.recv().await),
                    None => None,
                }
            } => {
                match attach_event {
                    // Stream: send raw PTY bytes (type 0x00 + raw bytes)
                    Some(Ok(TerminalStreamEvent::Stream(chunk))) => {
                        if should_skip_stream_chunk(stream_sequence_floor, chunk.sequence) {
                            continue;
                        }
                        let mut frame = Vec::with_capacity(1 + chunk.bytes.len());
                        frame.push(WS_OUT_STREAM);
                        frame.extend_from_slice(&chunk.bytes);
                        if socket
                            .send(Message::Binary(frame.into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(TerminalStreamEvent::Exit(exit_code))) => {
                        if socket.send(Message::Text(server_exit_event(&session_id, exit_code).into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TerminalStreamEvent::Error(err))) => {
                        if socket.send(Message::Text(server_error_event(&session_id, err).into())).await.is_err() {
                            break;
                        }
                    }
                    // Lag recovery: send recovery JSON then raw restore binary.
                    Some(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if let Some(session) = state.get_session(&session_id).await {
                            if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await
                            {
                                if socket
                                    .send(
                                        Message::Text(
                                            server_recovery_event(&session_id, skipped, &snapshot).into(),
                                        ),
                                    )
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                let raw = encode_raw_restore_binary(
                                    &snapshot,
                                    crate::state::LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
                                );
                                if socket
                                    .send(Message::Binary(raw.into()))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                stream_sequence_floor = Some(snapshot.sequence);
                            } else if socket
                                .send(Message::Text(server_error_event(&session_id, format!("Terminal stream skipped {skipped} frames while catching up")).into()))
                                .await
                            .is_err()
                            {
                                break;
                            }
                        } else if socket
                            .send(Message::Text(server_error_event(&session_id, format!("Terminal stream skipped {skipped} frames while catching up")).into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some(Err(broadcast::error::RecvError::Closed)) => {
                        break;
                    }
                    None => {
                        break;
                    }
                }
            }
            message = socket.recv() => {
                match message {
                    // Binary input from client (ttyd-style: type prefix byte)
                    Some(Ok(Message::Binary(payload))) => {
                        if let Err(err) = handle_binary_input(
                            &state,
                            &supervisor,
                            &session_id,
                            &mut cols,
                            &mut rows,
                            &mut socket,
                            &payload,
                        ).await {
                            if socket
                                .send(Message::Text(
                                    server_error_event(&session_id, err.to_string()).into(),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                    // Legacy text JSON input (still accepted for backward compat)
                    Some(Ok(Message::Text(payload))) => {
                        match serde_json::from_str::<TerminalControlMessage>(&payload) {
                            Ok(command) => {
                                match crate::routes::terminal::control::handle_control_message(
                                    &state,
                                    &session_id,
                                    &mut cols,
                                    &mut rows,
                                    command,
                                )
                                .await
                                {
                                    Ok(Some(response)) => {
                                        if socket.send(Message::Text(response.into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    Ok(None) => {}
                                    Err(err) => {
                                        if socket
                                            .send(Message::Text(
                                                server_error_event(&session_id, err.to_string()).into(),
                                            ))
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(err) => {
                                if socket
                                    .send(Message::Text(
                                        server_error_event(
                                            &session_id,
                                            format!("Invalid terminal control message: {err}"),
                                        )
                                        .into(),
                                    ))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) | None => break,
                }
            }
            _ = ping_interval.tick() => {
                if socket
                    .send(Message::Ping(vec![].into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}

/// Handle binary input from the client (ttyd-style protocol).
/// First byte is the message type, remainder is the payload.
async fn handle_binary_input(
    _state: &Arc<AppState>,
    supervisor: &TerminalSupervisor,
    session_id: &str,
    cols: &mut u16,
    rows: &mut u16,
    socket: &mut WebSocket,
    payload: &[u8],
) -> anyhow::Result<()> {
    if payload.is_empty() {
        return Ok(());
    }

    let msg_type = payload[0];
    let body = &payload[1..];

    match msg_type {
        WS_MSG_INPUT => {
            let input = String::from_utf8_lossy(body).into_owned();
            if input.is_empty() {
                return Ok(());
            }
            match supervisor.send_terminal_input(session_id, input).await? {
                crate::state::TerminalInputStatus::Accepted => Ok(()),
                crate::state::TerminalInputStatus::QueueFull => {
                    let _ = socket
                        .send(Message::Text(
                            server_input_queue_full_event(session_id, "keys").into(),
                        ))
                        .await;
                    Ok(())
                }
            }
        }
        WS_MSG_RESIZE => {
            #[derive(serde::Deserialize)]
            struct ResizePayload {
                cols: u16,
                rows: u16,
            }
            let resize: ResizePayload = serde_json::from_slice(body)?;
            *cols = resize.cols.max(1);
            *rows = resize.rows.max(1);
            supervisor.resize_terminal(session_id, *cols, *rows).await?;
            Ok(())
        }
        WS_MSG_PING => {
            let _ = socket
                .send(Message::Text(
                    server_pong_event(session_id).into(),
                ))
                .await;
            Ok(())
        }
        _ => {
            anyhow::bail!("Unknown binary message type: 0x{msg_type:02x}");
        }
    }
}

// ---------------------------------------------------------------------------
// Raw binary encoding helpers (ttyd-style)
// ---------------------------------------------------------------------------

/// Encode a restore snapshot as raw binary: [0x01] [ANSI modes prefix] [payload].
/// The ANSI modes prefix sets terminal modes (alt screen, cursor, etc.) so the
/// client can write the entire frame directly to xterm without parsing headers.
fn encode_raw_restore_binary(
    snapshot: &TerminalRestoreSnapshot,
    max_bytes: usize,
) -> Vec<u8> {
    let modes_prefix = encode_terminal_modes_ansi(&snapshot.modes);
    let payload = snapshot.render_restore_bytes(max_bytes);
    let mut frame = Vec::with_capacity(1 + modes_prefix.len() + payload.len());
    frame.push(WS_OUT_RESTORE);
    frame.extend_from_slice(&modes_prefix);
    frame.extend_from_slice(&payload);
    frame
}

/// Encode terminal modes as raw ANSI escape sequences. Mirrors the frontend's
/// `encodeTerminalModesPrefix()` so the server can produce ready-to-render bytes.
fn encode_terminal_modes_ansi(modes: &TerminalModeState) -> Vec<u8> {
    let mut ansi = String::with_capacity(128);

    // Alternate screen
    ansi.push_str(if modes.alternate_screen {
        "\x1b[?1049h"
    } else {
        "\x1b[?1049l"
    });

    // Application cursor
    ansi.push_str(if modes.application_cursor {
        "\x1b[?1h"
    } else {
        "\x1b[?1l"
    });

    // Application keypad
    ansi.push_str(if modes.application_keypad {
        "\x1b="
    } else {
        "\x1b>"
    });

    // Cursor visibility
    ansi.push_str(if modes.hide_cursor {
        "\x1b[?25l"
    } else {
        "\x1b[?25h"
    });

    // Bracketed paste
    ansi.push_str(if modes.bracketed_paste {
        "\x1b[?2004h"
    } else {
        "\x1b[?2004l"
    });

    // Reset all mouse modes first, then set the active one
    ansi.push_str("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l");

    match modes.mouse_protocol_mode.as_str() {
        "Press" | "PressRelease" => ansi.push_str("\x1b[?1000h"),
        "ButtonMotion" => ansi.push_str("\x1b[?1002h"),
        "AnyMotion" => ansi.push_str("\x1b[?1003h"),
        _ => {}
    }

    match modes.mouse_protocol_encoding.as_str() {
        "Utf8" => ansi.push_str("\x1b[?1005h"),
        "Sgr" => ansi.push_str("\x1b[?1006h"),
        "Urxvt" => ansi.push_str("\x1b[?1015h"),
        _ => {}
    }

    ansi.into_bytes()
}

// ---------------------------------------------------------------------------
// SSE event helpers (unchanged — used by SSE fallback)
// ---------------------------------------------------------------------------

pub fn server_control_event(session_id: &str, event: &str) -> String {
    json!({
        "type": "control",
        "event": event,
        "sessionId": session_id,
    })
    .to_string()
}

pub fn server_ready_event(session_id: &str) -> String {
    server_control_event(session_id, "ready")
}

pub fn server_recovery_event(
    session_id: &str,
    skipped: u64,
    snapshot: &TerminalRestoreSnapshot,
) -> String {
    json!({
        "type": "recovery",
        "sessionId": session_id,
        "reason": crate::state::TerminalSnapshotReason::Lagged.as_str(),
        "skipped": skipped,
        "sequence": snapshot.sequence,
        "snapshotVersion": snapshot.version,
        "cols": snapshot.cols,
        "rows": snapshot.rows,
        "modes": snapshot.modes,
    })
    .to_string()
}

pub fn server_terminal_restore_event(
    session_id: &str,
    snapshot: &TerminalRestoreSnapshot,
    reason: crate::state::TerminalSnapshotReason,
    max_bytes: usize,
) -> String {
    json!({
        "type": "restore",
        "sessionId": session_id,
        "sequence": snapshot.sequence,
        "snapshotVersion": snapshot.version,
        "reason": reason.as_str(),
        "cols": snapshot.cols,
        "rows": snapshot.rows,
        "modes": snapshot.modes,
        "payload": BASE64_STANDARD.encode(snapshot.render_restore_bytes(max_bytes)),
    })
    .to_string()
}

pub fn server_terminal_stream_event(session_id: &str, chunk: &TerminalStreamChunk) -> String {
    json!({
        "type": "stream",
        "sessionId": session_id,
        "sequence": chunk.sequence,
        "payload": BASE64_STANDARD.encode(&chunk.bytes),
    })
    .to_string()
}

pub fn server_exit_event(session_id: &str, exit_code: i32) -> String {
    json!({
        "type": "control",
        "event": "exit",
        "sessionId": session_id,
        "exitCode": exit_code,
    })
    .to_string()
}

pub fn server_input_queue_full_event(session_id: &str, action: &str) -> String {
    json!({
        "type": "control",
        "event": "input_queue_full",
        "sessionId": session_id,
        "action": action,
        "queueFull": true,
        "status": "queue_full",
    })
    .to_string()
}

pub fn server_pong_event(session_id: &str) -> String {
    server_control_event(session_id, "pong")
}

pub fn server_error_event(session_id: &str, error: impl Into<String>) -> String {
    json!({
        "type": "error",
        "sessionId": session_id,
        "error": error.into(),
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// CTP2 frame encoders (kept for SSE fallback backward compatibility)
// ---------------------------------------------------------------------------

pub fn encode_terminal_restore_frame(
    snapshot: &TerminalRestoreSnapshot,
    reason: crate::state::TerminalSnapshotReason,
    max_bytes: usize,
) -> Vec<u8> {
    let payload = snapshot.render_restore_bytes(max_bytes);
    let mut frame =
        Vec::with_capacity(20 + crate::state::TERMINAL_RESTORE_FRAME_MODE_BYTES + payload.len());
    frame.extend_from_slice(&crate::state::TERMINAL_FRAME_MAGIC);
    frame.push(crate::state::TERMINAL_FRAME_PROTOCOL_VERSION);
    frame.push(crate::state::TERMINAL_FRAME_KIND_RESTORE);
    frame.extend_from_slice(&snapshot.sequence.to_be_bytes());
    frame.push(snapshot.version);
    frame.push(reason.as_code());
    frame.extend_from_slice(&snapshot.cols.to_be_bytes());
    frame.extend_from_slice(&snapshot.rows.to_be_bytes());
    frame.push(terminal_mode_flags(snapshot));
    frame.push(terminal_mouse_protocol_mode_code(snapshot));
    frame.push(terminal_mouse_protocol_encoding_code(snapshot));
    frame.push(0);
    frame.extend_from_slice(&payload);
    frame
}

pub fn encode_terminal_stream_frame(chunk: &TerminalStreamChunk) -> Vec<u8> {
    let mut frame = Vec::with_capacity(14 + chunk.bytes.len());
    frame.extend_from_slice(&crate::state::TERMINAL_FRAME_MAGIC);
    frame.push(crate::state::TERMINAL_FRAME_PROTOCOL_VERSION);
    frame.push(crate::state::TERMINAL_FRAME_KIND_STREAM);
    frame.extend_from_slice(&chunk.sequence.to_be_bytes());
    frame.extend_from_slice(&chunk.bytes);
    frame
}

fn terminal_mode_flags(snapshot: &TerminalRestoreSnapshot) -> u8 {
    let mut flags = 0_u8;
    if snapshot.modes.alternate_screen {
        flags |= 1 << 0;
    }
    if snapshot.modes.application_keypad {
        flags |= 1 << 1;
    }
    if snapshot.modes.application_cursor {
        flags |= 1 << 2;
    }
    if snapshot.modes.hide_cursor {
        flags |= 1 << 3;
    }
    if snapshot.modes.bracketed_paste {
        flags |= 1 << 4;
    }
    flags
}

fn terminal_mouse_protocol_mode_code(snapshot: &TerminalRestoreSnapshot) -> u8 {
    match snapshot.modes.mouse_protocol_mode.as_str() {
        "Press" => 1,
        "PressRelease" => 2,
        "ButtonMotion" => 3,
        "AnyMotion" => 4,
        _ => 0,
    }
}

fn terminal_mouse_protocol_encoding_code(snapshot: &TerminalRestoreSnapshot) -> u8 {
    match snapshot.modes.mouse_protocol_encoding.as_str() {
        "Utf8" => 1,
        "Sgr" => 2,
        "Urxvt" => 3,
        _ => 0,
    }
}

pub fn should_send_initial_restore(
    snapshot: &TerminalRestoreSnapshot,
    client_sequence: Option<u64>,
) -> bool {
    client_sequence
        .map(|sequence| sequence != snapshot.sequence)
        .unwrap_or(true)
}

pub fn should_skip_stream_chunk(sequence_floor: Option<u64>, chunk_sequence: u64) -> bool {
    sequence_floor
        .map(|sequence| chunk_sequence <= sequence)
        .unwrap_or(false)
}
