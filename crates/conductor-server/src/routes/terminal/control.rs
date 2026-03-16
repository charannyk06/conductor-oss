use crate::routes::terminal::bootstrap::{
    append_server_timing_metric, elapsed_duration_ms, set_terminal_header, timed_error_response,
};
use crate::state::{AppState, TerminalInputStatus, TerminalSupervisor};
use anyhow::{anyhow, Result};
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Path, Query, State,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub token: Option<String>,
    pub sequence: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TerminalResizeBody {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalControlMessage {
    Ping,
    Batch {
        operations: Vec<TerminalControlBatchOperation>,
    },
    Keys {
        keys: Option<String>,
        special: Option<String>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalControlBatchOperation {
    Keys {
        keys: Option<String>,
        special: Option<String>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
}

/// Deprecated: Use the unified bidirectional `/terminal/ws` endpoint instead.
/// This endpoint will be removed in a future release.
pub async fn terminal_control_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    tracing::warn!(
        session_id = %id,
        "Deprecated: /terminal/control/ws is deprecated. Use the unified /terminal/ws endpoint for bidirectional control.",
    );
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
    ws.on_upgrade(move |socket| handle_terminal_control_socket(socket, state, id, cols, rows))
}

pub async fn terminal_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalResizeBody>,
) -> Response {
    let started_at = Instant::now();
    if state.get_session(&id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    }

    let supervisor = TerminalSupervisor::new(state.clone());
    if let Err(err) = supervisor
        .authorize_terminal_access(&id, None, &headers)
        .await
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response();
    }

    let cols = body.cols.max(1);
    let rows = body.rows.max(1);
    match supervisor.resize_terminal(&id, cols, rows).await {
        Ok(()) => {
            let mut response = Json(json!({
                "ok": true,
                "sessionId": id,
                "cols": cols,
                "rows": rows,
            }))
            .into_response();
            let headers = response.headers_mut();
            append_server_timing_metric(
                headers,
                "terminal_resize",
                elapsed_duration_ms(started_at),
            );
            set_terminal_header(
                headers,
                crate::state::TERMINAL_RESIZE_COLS_HEADER,
                &cols.to_string(),
            );
            set_terminal_header(
                headers,
                crate::state::TERMINAL_RESIZE_ROWS_HEADER,
                &rows.to_string(),
            );
            response
        }
        Err(err) => timed_error_response(
            StatusCode::BAD_REQUEST,
            err.to_string(),
            "terminal_resize",
            started_at,
        ),
    }
}

async fn handle_terminal_control_socket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session_id: String,
    mut cols: u16,
    mut rows: u16,
) {
    if socket
        .send(Message::Text(
            crate::routes::terminal::stream::server_ready_event(&session_id).into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    let supervisor = TerminalSupervisor::new(state.clone());
    let _ = supervisor
        .prepare_terminal_runtime(&session_id, Some(cols), Some(rows))
        .await;

    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    ping_interval.reset();

    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(message) = message else { break };
                match message {
                    Ok(Message::Text(payload)) => {
                        match serde_json::from_str::<TerminalControlMessage>(&payload) {
                            Ok(command) => {
                                let response = match handle_control_message(
                                    &state,
                                    &session_id,
                                    &mut cols,
                                    &mut rows,
                                    command,
                                )
                                .await
                                {
                                    Ok(Some(value)) => Some(value),
                                    Ok(None) => None,
                                    Err(err) => Some(crate::routes::terminal::stream::server_error_event(&session_id, err.to_string())),
                                };

                                if let Some(response) = response {
                                    if socket.send(Message::Text(response.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(err) => {
                                if socket
                                    .send(Message::Text(
                                        crate::routes::terminal::stream::server_error_event(
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
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(payload)) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(Message::Binary(_)) => {
                        if socket
                            .send(Message::Text(
                                crate::routes::terminal::stream::server_error_event(
                                    &session_id,
                                    "Binary terminal control messages are not supported",
                                )
                                .into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
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

pub(crate) async fn handle_control_message(
    state: &Arc<AppState>,
    session_id: &str,
    cols: &mut u16,
    rows: &mut u16,
    message: TerminalControlMessage,
) -> Result<Option<String>> {
    let supervisor = TerminalSupervisor::new(state.clone());
    match message {
        TerminalControlMessage::Ping => Ok(Some(
            crate::routes::terminal::stream::server_pong_event(session_id),
        )),
        TerminalControlMessage::Batch { operations } => {
            if operations.len() > MAX_TERMINAL_BATCH_OPERATIONS {
                anyhow::bail!(
                    "Batch contains too many operations ({} > {} limit)",
                    operations.len(),
                    MAX_TERMINAL_BATCH_OPERATIONS,
                );
            }
            let mut queue_full = false;
            for operation in operations {
                match operation {
                    TerminalControlBatchOperation::Keys { keys, special } => {
                        let chunk = resolve_terminal_keys(keys, special)?;
                        if matches!(
                            supervisor.send_terminal_input(session_id, chunk).await?,
                            TerminalInputStatus::QueueFull
                        ) {
                            queue_full = true;
                        }
                    }
                    TerminalControlBatchOperation::Resize {
                        cols: next_cols,
                        rows: next_rows,
                    } => {
                        *cols = next_cols.max(1);
                        *rows = next_rows.max(1);
                        supervisor.resize_terminal(session_id, *cols, *rows).await?;
                    }
                }
            }
            if queue_full {
                Ok(Some(
                    crate::routes::terminal::stream::server_input_queue_full_event(
                        session_id, "keys",
                    ),
                ))
            } else {
                Ok(None)
            }
        }
        TerminalControlMessage::Keys { keys, special } => {
            let chunk = resolve_terminal_keys(keys, special)?;
            match supervisor.send_terminal_input(session_id, chunk).await? {
                TerminalInputStatus::Accepted => Ok(None),
                TerminalInputStatus::QueueFull => Ok(Some(
                    crate::routes::terminal::stream::server_input_queue_full_event(
                        session_id, "keys",
                    ),
                )),
            }
        }
        TerminalControlMessage::Resize {
            cols: next_cols,
            rows: next_rows,
        } => {
            *cols = next_cols.max(1);
            *rows = next_rows.max(1);
            supervisor.resize_terminal(session_id, *cols, *rows).await?;
            Ok(None)
        }
    }
}

/// Maximum size of terminal keys input (64KB). Prevents memory exhaustion
/// from malicious clients sending oversized payloads via WebSocket.
const MAX_TERMINAL_KEYS_BYTES: usize = 64 * 1024;

/// Maximum number of operations in a single batch message.
const MAX_TERMINAL_BATCH_OPERATIONS: usize = 64;

pub fn resolve_terminal_keys(keys: Option<String>, special: Option<String>) -> Result<String> {
    if let Some(keys) = keys {
        if keys.len() > MAX_TERMINAL_KEYS_BYTES {
            anyhow::bail!(
                "Terminal keys input exceeds maximum size ({} bytes > {} limit)",
                keys.len(),
                MAX_TERMINAL_KEYS_BYTES,
            );
        }
        return Ok(keys);
    }

    let special = special.ok_or_else(|| anyhow!("keys or special is required"))?;
    let mapped = match special.as_str() {
        "Enter" => "\r",
        "Tab" => "\t",
        "Backspace" => "\u{7f}",
        "Escape" => "\u{1b}",
        "ArrowUp" => "\u{1b}[A",
        "ArrowDown" => "\u{1b}[B",
        "ArrowRight" => "\u{1b}[C",
        "ArrowLeft" => "\u{1b}[D",
        "C-c" => "\u{3}",
        "C-d" => "\u{4}",
        "C-z" => "\u{1a}",
        "C-a" => "\u{1}",
        "C-e" => "\u{5}",
        "C-k" => "\u{b}",
        "C-u" => "\u{15}",
        "C-w" => "\u{17}",
        "C-l" => "\u{c}",
        "C-r" => "\u{12}",
        "C-s" => "\u{13}",
        "C-q" => "\u{11}",
        "C-b" => "\u{2}",
        "C-f" => "\u{6}",
        "C-n" => "\u{e}",
        "C-p" => "\u{10}",
        "C-y" => "\u{19}",
        "Insert" => "\u{1b}[2~",
        "Delete" => "\u{1b}[3~",
        "Home" => "\u{1b}[H",
        "End" => "\u{1b}[F",
        "PageUp" => "\u{1b}[5~",
        "PageDown" => "\u{1b}[6~",
        "F1" => "\u{1b}OP",
        "F2" => "\u{1b}OQ",
        "F3" => "\u{1b}OR",
        "F4" => "\u{1b}OS",
        "F5" => "\u{1b}[15~",
        "F6" => "\u{1b}[17~",
        "F7" => "\u{1b}[18~",
        "F8" => "\u{1b}[19~",
        "F9" => "\u{1b}[20~",
        "F10" => "\u{1b}[21~",
        "F11" => "\u{1b}[23~",
        "F12" => "\u{1b}[24~",
        "M-ArrowUp" => "\u{1b}[1;3A",
        "M-ArrowDown" => "\u{1b}[1;3B",
        "M-ArrowRight" => "\u{1b}[1;3C",
        "M-ArrowLeft" => "\u{1b}[1;3D",
        "S-ArrowUp" => "\u{1b}[1;2A",
        "S-ArrowDown" => "\u{1b}[1;2B",
        "S-ArrowRight" => "\u{1b}[1;2C",
        "S-ArrowLeft" => "\u{1b}[1;2D",
        "C-ArrowUp" => "\u{1b}[1;5A",
        "C-ArrowDown" => "\u{1b}[1;5B",
        "C-ArrowRight" => "\u{1b}[1;5C",
        "C-ArrowLeft" => "\u{1b}[1;5D",
        "S-Tab" => "\u{1b}[Z",
        "S-Home" => "\u{1b}[1;2H",
        "S-End" => "\u{1b}[1;2F",
        "C-Home" => "\u{1b}[1;5H",
        "C-End" => "\u{1b}[1;5F",
        "S-F1" => "\u{1b}[1;2P",
        "S-F2" => "\u{1b}[1;2Q",
        "S-F3" => "\u{1b}[1;2R",
        "S-F4" => "\u{1b}[1;2S",
        "S-F5" => "\u{1b}[15;2~",
        "S-F6" => "\u{1b}[17;2~",
        "S-F7" => "\u{1b}[18;2~",
        "S-F8" => "\u{1b}[19;2~",
        "S-F9" => "\u{1b}[20;2~",
        "S-F10" => "\u{1b}[21;2~",
        "S-F11" => "\u{1b}[23;2~",
        "S-F12" => "\u{1b}[24;2~",
        other => other,
    };

    Ok(mapped.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_terminal_keys_accepts_normal_input() {
        let result = resolve_terminal_keys(Some("hello".to_string()), None);
        assert_eq!(result.unwrap(), "hello");
    }

    #[test]
    fn resolve_terminal_keys_rejects_oversized_input() {
        let oversized = "x".repeat(MAX_TERMINAL_KEYS_BYTES + 1);
        let result = resolve_terminal_keys(Some(oversized), None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("exceeds maximum size"));
    }

    #[test]
    fn resolve_terminal_keys_accepts_at_limit() {
        let at_limit = "x".repeat(MAX_TERMINAL_KEYS_BYTES);
        let result = resolve_terminal_keys(Some(at_limit.clone()), None);
        assert_eq!(result.unwrap(), at_limit);
    }

    #[test]
    fn resolve_terminal_keys_maps_special_keys() {
        assert_eq!(
            resolve_terminal_keys(None, Some("Enter".to_string())).unwrap(),
            "\r"
        );
        assert_eq!(
            resolve_terminal_keys(None, Some("C-c".to_string())).unwrap(),
            "\u{3}"
        );
        assert_eq!(
            resolve_terminal_keys(None, Some("ArrowUp".to_string())).unwrap(),
            "\u{1b}[A"
        );
    }

    #[test]
    fn resolve_terminal_keys_requires_keys_or_special() {
        let result = resolve_terminal_keys(None, None);
        assert!(result.is_err());
    }

    #[test]
    fn batch_operations_limit_constant_is_reasonable() {
        assert!(MAX_TERMINAL_BATCH_OPERATIONS >= 16);
        assert!(MAX_TERMINAL_BATCH_OPERATIONS <= 256);
    }
}
