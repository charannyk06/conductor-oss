use anyhow::{anyhow, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::{trim_lines_tail, AppState};

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/sessions/{id}/terminal/ws", get(terminal_websocket))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    lines: Option<usize>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientMessage {
    Ping,
    Send {
        message: String,
        #[serde(default)]
        attachments: Vec<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
    },
    Keys {
        keys: Option<String>,
        special: Option<String>,
    },
}

async fn terminal_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if state.get_session(&id).await.is_none() {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    }

    let lines = query.lines.unwrap_or(500);
    ws.on_upgrade(move |socket| handle_terminal_socket(socket, state, id, lines))
}

async fn handle_terminal_socket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session_id: String,
    lines: usize,
) {
    let initial_payload = state
        .get_session(&session_id)
        .await
        .map(|session| server_snapshot_event(&session_id, &session.output, lines))
        .unwrap_or_else(|| {
            server_error_event(
                &session_id,
                format!("Session {session_id} is no longer available"),
            )
        });

    if socket
        .send(Message::Text(initial_payload.into()))
        .await
        .is_err()
    {
        return;
    }

    let mut output_updates = state.output_updates.subscribe();

    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(payload))) => {
                        match serde_json::from_str::<TerminalClientMessage>(&payload) {
                            Ok(command) => {
                                let response = match handle_client_message(&state, &session_id, command).await {
                                    Ok(Some(value)) => Some(value),
                                    Ok(None) => None,
                                    Err(err) => Some(server_error_event(&session_id, err.to_string())),
                                };
                                if let Some(response) = response {
                                    if socket.send(Message::Text(response.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(err) => {
                                if socket
                                    .send(Message::Text(server_error_event(&session_id, format!("Invalid terminal message: {err}")).into()))
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
                    Some(Ok(Message::Binary(_))) => {
                        if socket
                            .send(Message::Text(server_error_event(&session_id, "Binary terminal messages are not supported").into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            update = output_updates.recv() => {
                match update {
                    Ok((updated_session_id, line)) if updated_session_id == session_id => {
                        if socket
                            .send(Message::Text(server_delta_event(&session_id, &line).into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        if socket
                            .send(Message::Text(server_refresh_event(&session_id, count).into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn handle_client_message(
    state: &Arc<AppState>,
    session_id: &str,
    message: TerminalClientMessage,
) -> Result<Option<String>> {
    match message {
        TerminalClientMessage::Ping => Ok(Some(server_pong_event(session_id))),
        TerminalClientMessage::Send {
            message,
            attachments,
            model,
            reasoning_effort,
        } => {
            if message.trim().is_empty() && attachments.is_empty() {
                return Err(anyhow!("Message or attachments are required"));
            }

            let is_live = state.ensure_session_live(session_id).await?;
            if is_live {
                state
                    .send_to_session(
                        session_id,
                        message,
                        attachments,
                        model,
                        reasoning_effort,
                        "terminal_ws",
                    )
                    .await?;
            } else {
                let session = state
                    .get_session(session_id)
                    .await
                    .ok_or_else(|| anyhow!("Session {session_id} not found"))?;
                let resumable = matches!(session.status.as_str(), "needs_input" | "stuck" | "done");
                if !resumable {
                    return Err(anyhow!(
                        "Session {session_id} is not accepting follow-up input"
                    ));
                }
                state
                    .resume_session_with_prompt(
                        session_id,
                        message,
                        attachments,
                        model,
                        reasoning_effort,
                        "terminal_ws",
                    )
                    .await?;
            }

            Ok(Some(server_ack_event(session_id, "send")))
        }
        TerminalClientMessage::Keys { keys, special } => {
            let chunk = resolve_terminal_keys(keys, special)?;
            state.send_raw_to_session(session_id, chunk).await?;
            Ok(Some(server_ack_event(session_id, "keys")))
        }
    }
}

fn resolve_terminal_keys(keys: Option<String>, special: Option<String>) -> Result<String> {
    if let Some(keys) = keys {
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
        other => other,
    };

    Ok(mapped.to_string())
}

fn server_snapshot_event(session_id: &str, output: &str, lines: usize) -> String {
    json!({
        "type": "snapshot",
        "sessionId": session_id,
        "output": trim_lines_tail(output, lines),
    })
    .to_string()
}

fn server_delta_event(session_id: &str, line: &str) -> String {
    json!({
        "type": "delta",
        "sessionId": session_id,
        "line": line,
    })
    .to_string()
}

fn server_ack_event(session_id: &str, action: &str) -> String {
    json!({
        "type": "ack",
        "sessionId": session_id,
        "action": action,
    })
    .to_string()
}

fn server_refresh_event(session_id: &str, missed: u64) -> String {
    json!({
        "type": "refresh",
        "sessionId": session_id,
        "reason": "lagged",
        "missed": missed,
    })
    .to_string()
}

fn server_pong_event(session_id: &str) -> String {
    json!({
        "type": "pong",
        "sessionId": session_id,
    })
    .to_string()
}

fn server_error_event(session_id: &str, error: impl Into<String>) -> String {
    json!({
        "type": "error",
        "sessionId": session_id,
        "error": error.into(),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_terminal_keys_prefers_literal_keys() {
        let value = resolve_terminal_keys(Some("hello".to_string()), Some("Enter".to_string()))
            .expect("literal keys should win");
        assert_eq!(value, "hello");
    }

    #[test]
    fn resolve_terminal_keys_maps_special_sequences() {
        let enter = resolve_terminal_keys(None, Some("Enter".to_string())).unwrap();
        let ctrl_c = resolve_terminal_keys(None, Some("C-c".to_string())).unwrap();
        let arrow_up = resolve_terminal_keys(None, Some("ArrowUp".to_string())).unwrap();

        assert_eq!(enter, "\r");
        assert_eq!(ctrl_c, "\u{3}");
        assert_eq!(arrow_up, "\u{1b}[A");
    }

    #[test]
    fn snapshot_event_trims_output_to_tail_lines() {
        let payload = server_snapshot_event("session-1", "one\ntwo\nthree\n", 2);
        let decoded: Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(decoded["type"], "snapshot");
        assert_eq!(decoded["sessionId"], "session-1");
        assert_eq!(decoded["output"], "two\nthree");
    }

    #[test]
    fn terminal_client_message_uses_tagged_protocol() {
        let decoded: TerminalClientMessage = serde_json::from_value(json!({
            "type": "send",
            "message": "follow up",
            "attachments": ["notes.md"],
            "reasoning_effort": "high"
        }))
        .unwrap();

        assert_eq!(
            decoded,
            TerminalClientMessage::Send {
                message: "follow up".to_string(),
                attachments: vec!["notes.md".to_string()],
                model: None,
                reasoning_effort: Some("high".to_string()),
            }
        );
    }
}
