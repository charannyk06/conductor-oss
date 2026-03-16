/// WebSocket handler implementing the full ttyd protocol.
///
/// Handles the bidirectional binary WebSocket communication between
/// the browser terminal (xterm.js) and the native PTY session.
use crate::protocol::{self, ClientMessage};
use crate::session::TtydSession;
use axum::extract::ws::{Message, WebSocket};
use std::sync::Arc;

/// Configuration sent to the client as SET_PREFS after handshake.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TtydPrefs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    #[serde(rename = "disableLeaveAlert", skip_serializing_if = "Option::is_none")]
    pub disable_leave_alert: Option<bool>,
}

impl Default for TtydPrefs {
    fn default() -> Self {
        Self {
            font_size: None,
            font_family: None,
            cursor_style: None,
            cursor_blink: None,
            disable_leave_alert: Some(true),
        }
    }
}

/// Run the ttyd WebSocket protocol for a session.
///
/// This is the main loop: it handles the client handshake, sends prefs,
/// and then enters the bidirectional I/O loop forwarding PTY output to
/// the client and client input to the PTY.
pub async fn handle_ttyd_websocket(
    mut socket: WebSocket,
    session: Arc<TtydSession>,
    prefs: TtydPrefs,
) {
    // Wait for client handshake or proceed directly.
    // Some clients send a JSON handshake first with dimensions.
    // We handle it in the main loop — any initial JSON message triggers
    // a resize before we start streaming.

    // Send terminal preferences as SET_PREFS
    let prefs_json = serde_json::to_string(&prefs).unwrap_or_default();
    let prefs_frame = protocol::encode_prefs(&prefs_json);
    if socket
        .send(Message::Binary(prefs_frame.into()))
        .await
        .is_err()
    {
        return;
    }

    // Subscribe to PTY output
    let mut output_rx = session.subscribe_output();

    // Main I/O loop
    loop {
        tokio::select! {
            // PTY output -> client
            output = output_rx.recv() => {
                match output {
                    Ok(chunk) => {
                        if session.is_paused() {
                            session.buffer_output(chunk).await;
                            continue;
                        }
                        let frame = protocol::encode_output(&chunk);
                        if socket.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::debug!(
                            session_id = %session.session_id,
                            skipped = n,
                            "Output receiver lagged, some output was lost"
                        );
                        // Continue — we'll get the next chunk.
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // PTY closed, send any remaining output and exit.
                        break;
                    }
                }
            }

            // Client -> PTY
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if let Some(client_msg) = protocol::parse_client_message(&data) {
                            handle_client_message(&session, &mut socket, client_msg).await;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        // Text messages might be JSON control messages
                        if let Some(client_msg) = protocol::parse_client_message(text.as_bytes()) {
                            handle_client_message(&session, &mut socket, client_msg).await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    tracing::debug!(session_id = %session.session_id, "ttyd WebSocket connection closed");
}

async fn handle_client_message(
    session: &Arc<TtydSession>,
    socket: &mut WebSocket,
    msg: ClientMessage,
) {
    match msg {
        ClientMessage::Input(data) => {
            let _ = session.send_input(data).await;
        }
        ClientMessage::Resize { columns, rows } => {
            session.resize(columns, rows).await;
        }
        ClientMessage::Pause => {
            session.set_paused(true);
        }
        ClientMessage::Resume => {
            session.set_paused(false);
            // Flush buffered output
            let chunks = session.flush_pause_buffer().await;
            for chunk in chunks {
                let frame = protocol::encode_output(&chunk);
                if socket.send(Message::Binary(frame.into())).await.is_err() {
                    return;
                }
            }
        }
        ClientMessage::Handshake(handshake) => {
            // Apply initial dimensions from the handshake
            if let (Some(cols), Some(rows)) = (handshake.columns, handshake.rows) {
                session.resize(cols, rows).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_prefs() {
        let prefs = TtydPrefs::default();
        let json = serde_json::to_string(&prefs).unwrap();
        assert!(json.contains("disableLeaveAlert"));
    }
}
