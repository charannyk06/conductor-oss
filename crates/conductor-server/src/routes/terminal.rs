use anyhow::{anyhow, Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::pending;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::routes::config::access_control_enabled;
use crate::state::{tmux_runtime_metadata, tmux_session_exists, AppState};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<sha2::Sha256>;

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const ATTACH_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_REMOTE_SESSION_SECRET";
static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions/{id}/terminal/ws", get(terminal_websocket))
        .route("/api/sessions/{id}/terminal/token", get(terminal_token))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    cols: Option<u16>,
    rows: Option<u16>,
    token: Option<String>,
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
    Resize {
        cols: u16,
        rows: u16,
    },
}

enum TerminalAttachEvent {
    Output(Vec<u8>),
    Exit(i32),
    Error(String),
}

struct TmuxAttachClient {
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}

impl TmuxAttachClient {
    fn spawn(
        socket_path: PathBuf,
        tmux_session: String,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, mpsc::UnboundedReceiver<TerminalAttachEvent>)> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut command = CommandBuilder::new("tmux");
        command.env("TERM", "xterm-256color");
        command.arg("-S");
        command.arg(socket_path.to_string_lossy().to_string());
        command.arg("attach-session");
        command.arg("-t");
        command.arg(tmux_session);

        let mut child = pair
            .slave
            .spawn_command(command)
            .context("Failed to spawn tmux attach client")?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer: Arc<Mutex<Option<Box<dyn Write + Send>>>> =
            Arc::new(Mutex::new(Some(pair.master.take_writer()?)));
        let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
            Arc::new(Mutex::new(Some(pair.master)));

        let (events_tx, events_rx) = mpsc::unbounded_channel::<TerminalAttachEvent>();

        let output_tx = events_tx.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if output_tx
                            .send(TerminalAttachEvent::Output(buffer[..read].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(err) => {
                        let _ = output_tx.send(TerminalAttachEvent::Error(format!(
                            "Failed to read tmux terminal output: {err}"
                        )));
                        break;
                    }
                }
            }
        });

        let exit_tx = events_tx.clone();
        let master_for_cleanup = Arc::clone(&master);
        std::thread::spawn(move || {
            let result = child.wait();
            if let Ok(mut guard) = master_for_cleanup.lock() {
                guard.take();
            }
            match result {
                Ok(status) => {
                    let _ = exit_tx.send(TerminalAttachEvent::Exit(status.exit_code() as i32));
                }
                Err(err) => {
                    let _ = exit_tx.send(TerminalAttachEvent::Error(format!(
                        "Tmux terminal client exited unexpectedly: {err}"
                    )));
                }
            }
        });

        Ok((Self { writer, master }, events_rx))
    }

    async fn write_raw(&self, bytes: &[u8]) -> Result<()> {
        let writer = Arc::clone(&self.writer);
        let payload = bytes.to_vec();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut guard = writer
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let writer = guard
                .as_mut()
                .ok_or_else(|| anyhow!("Terminal writer is no longer available"))?;
            writer.write_all(&payload)?;
            writer.flush()?;
            Ok(())
        })
        .await
        .context("Failed to join terminal write task")?
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let master = Arc::clone(&self.master);
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = master
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let master = guard
                .as_ref()
                .ok_or_else(|| anyhow!("Terminal is no longer attached"))?;
            master.resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })?;
            Ok(())
        })
        .await
        .context("Failed to join terminal resize task")?
    }

    async fn close(self) {
        let writer = Arc::clone(&self.writer);
        let master = Arc::clone(&self.master);
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut guard) = writer.lock() {
                guard.take();
            }
            if let Ok(mut guard) = master.lock() {
                guard.take();
            }
        })
        .await;
    }
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

    if let Err(err) = authorize_terminal_access(&state, &id, query.token.as_deref()).await {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    let cols = query.cols.unwrap_or(DEFAULT_TERMINAL_COLS).max(1);
    let rows = query.rows.unwrap_or(DEFAULT_TERMINAL_ROWS).max(1);
    ws.on_upgrade(move |socket| handle_terminal_socket(socket, state, id, cols, rows))
}

async fn terminal_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if state.get_session(&id).await.is_none() {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    }

    let access = state.config.read().await.access.clone();
    let token = if should_issue_terminal_token(&access) {
        create_terminal_token(&id).ok()
    } else {
        None
    };

    Json(json!({ "token": token })).into_response()
}

async fn handle_terminal_socket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session_id: String,
    mut cols: u16,
    mut rows: u16,
) {
    if socket
        .send(Message::Text(server_ready_event(&session_id).into()))
        .await
        .is_err()
    {
        return;
    }

    let mut attach_client: Option<TmuxAttachClient> = None;
    let mut attach_events: Option<mpsc::UnboundedReceiver<TerminalAttachEvent>> = None;
    let mut attach_retry = tokio::time::interval(ATTACH_RETRY_INTERVAL);
    attach_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = attach_retry.tick(), if attach_client.is_none() => {
                match maybe_attach_tmux_client(&state, &session_id, cols, rows).await {
                    Ok(Some((client, events_rx))) => {
                        attach_client = Some(client);
                        attach_events = Some(events_rx);
                    }
                    Ok(None) => {}
                    Err(err) => {
                        if socket.send(Message::Text(server_error_event(&session_id, err.to_string()).into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            attach_event = async {
                match attach_events.as_mut() {
                    Some(receiver) => receiver.recv().await,
                    None => pending().await,
                }
            } => {
                match attach_event {
                    Some(TerminalAttachEvent::Output(bytes)) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalAttachEvent::Exit(exit_code)) => {
                        attach_client = None;
                        attach_events = None;
                        if socket.send(Message::Text(server_exit_event(&session_id, exit_code).into())).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalAttachEvent::Error(err)) => {
                        attach_client = None;
                        attach_events = None;
                        if socket.send(Message::Text(server_error_event(&session_id, err).into())).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        attach_client = None;
                        attach_events = None;
                    }
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(payload))) => {
                        match serde_json::from_str::<TerminalClientMessage>(&payload) {
                            Ok(command) => {
                                let response = match handle_client_message(
                                    &state,
                                    &session_id,
                                    &mut attach_client,
                                    &mut cols,
                                    &mut rows,
                                    command,
                                )
                                .await
                                {
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
        }
    }

    if let Some(client) = attach_client {
        client.close().await;
    }
}

async fn maybe_attach_tmux_client(
    state: &Arc<AppState>,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<
    Option<(
        TmuxAttachClient,
        mpsc::UnboundedReceiver<TerminalAttachEvent>,
    )>,
> {
    let session = match state.get_session(session_id).await {
        Some(session) => session,
        None => return Ok(None),
    };

    let Some((socket_path, tmux_session)) = tmux_runtime_metadata(&session) else {
        return Ok(None);
    };

    if !tmux_session_exists(&socket_path, &tmux_session).await? {
        return Ok(None);
    }

    let client = TmuxAttachClient::spawn(socket_path, tmux_session, cols, rows)?;
    Ok(Some(client))
}

async fn handle_client_message(
    state: &Arc<AppState>,
    session_id: &str,
    attach_client: &mut Option<TmuxAttachClient>,
    cols: &mut u16,
    rows: &mut u16,
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
            if let Some(client) = attach_client.as_ref() {
                client.write_raw(chunk.as_bytes()).await?;
            } else if state.ensure_session_live(session_id).await? {
                state.send_raw_to_session(session_id, chunk).await?;
            } else {
                return Err(anyhow!("Terminal is not currently attached"));
            }
            Ok(Some(server_ack_event(session_id, "keys")))
        }
        TerminalClientMessage::Resize {
            cols: next_cols,
            rows: next_rows,
        } => {
            *cols = next_cols.max(1);
            *rows = next_rows.max(1);
            if let Some(client) = attach_client.as_ref() {
                client.resize(*cols, *rows).await?;
            }
            Ok(None)
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

async fn authorize_terminal_access(
    state: &Arc<AppState>,
    session_id: &str,
    token: Option<&str>,
) -> Result<()> {
    let access = state.config.read().await.access.clone();
    if !access_control_enabled(&access) {
        return Ok(());
    }

    let token = token.ok_or_else(|| anyhow!("Terminal token is required"))?;
    if verify_terminal_token(session_id, token)? {
        return Ok(());
    }

    Err(anyhow!("Invalid terminal token"))
}

fn verify_terminal_token(session_id: &str, token: &str) -> Result<bool> {
    let secret = terminal_token_secret();

    let (expires_at_raw, provided_signature) = token
        .split_once('.')
        .ok_or_else(|| anyhow!("Malformed terminal token"))?;
    let expires_at = expires_at_raw
        .parse::<i64>()
        .context("Invalid terminal token expiry")?;
    if chrono::Utc::now().timestamp() > expires_at {
        return Ok(false);
    }

    let payload = format!("{session_id}:{expires_at_raw}");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    let expected_signature = hex::encode(mac.finalize().into_bytes());
    Ok(constant_time_equal(
        expected_signature.as_bytes(),
        provided_signature.as_bytes(),
    ))
}

fn create_terminal_token(session_id: &str) -> Result<String> {
    let secret = terminal_token_secret();
    let expires_at = chrono::Utc::now().timestamp() + 60;
    let payload = format!("{session_id}:{expires_at}");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    Ok(format!("{expires_at}.{signature}"))
}

fn terminal_token_secret() -> String {
    std::env::var(TERMINAL_TOKEN_SECRET_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| PROCESS_TERMINAL_TOKEN_SECRET.clone())
}

fn should_issue_terminal_token(access: &conductor_core::config::DashboardAccessConfig) -> bool {
    access_control_enabled(access)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    let mut mismatch = 0_u8;
    for (lhs, rhs) in left.iter().zip(right.iter()) {
        mismatch |= lhs ^ rhs;
    }
    mismatch == 0
}

fn server_ready_event(session_id: &str) -> String {
    json!({
        "type": "ready",
        "sessionId": session_id,
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

fn server_exit_event(session_id: &str, exit_code: i32) -> String {
    json!({
        "type": "exit",
        "sessionId": session_id,
        "exitCode": exit_code,
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
    fn verify_terminal_token_accepts_valid_signature() {
        let _guard = crate::routes::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        unsafe {
            std::env::set_var(TERMINAL_TOKEN_SECRET_ENV, "test-secret");
        }

        let expires_at = chrono::Utc::now().timestamp() + 60;
        let payload = format!("session-123:{expires_at}");
        let mut mac = HmacSha256::new_from_slice(b"test-secret").unwrap();
        mac.update(payload.as_bytes());
        let token = format!("{expires_at}.{}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_terminal_token("session-123", &token).unwrap());

        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }
    }

    #[test]
    fn terminal_token_is_not_required_for_local_auth_only_configs() {
        let _guard = crate::routes::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
            std::env::remove_var("CONDUCTOR_REMOTE_ACCESS_TOKEN");
        }

        let access = conductor_core::config::DashboardAccessConfig {
            require_auth: true,
            ..conductor_core::config::DashboardAccessConfig::default()
        };

        assert!(access_control_enabled(&access));
        assert!(should_issue_terminal_token(&access));
    }

    #[test]
    fn terminal_token_round_trip_works_without_env_secret() {
        let _guard = crate::routes::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }

        let token = create_terminal_token("session-123").expect("token should be created");
        assert!(verify_terminal_token("session-123", &token).expect("token should verify"));
    }
}
