use anyhow::{anyhow, Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::pending;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::broadcast;

use crate::routes::config::access_control_enabled;
use crate::state::{
    capture_tmux_pane, tmux_runtime_metadata, tmux_session_exists, trim_lines_tail, AppState,
    SessionRecord, TerminalRestoreSnapshot, TerminalStreamEvent, TERMINAL_RESTORE_SNAPSHOT_FORMAT,
    TMUX_LOG_PATH_METADATA_KEY,
};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<sha2::Sha256>;

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const DEFAULT_TERMINAL_SNAPSHOT_LINES: usize = 1200;
const MAX_TERMINAL_SNAPSHOT_LINES: usize = 12000;
const MAX_TERMINAL_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const LIVE_TERMINAL_SNAPSHOT_MAX_BYTES: usize = 128 * 1024;
const READ_ONLY_TERMINAL_SNAPSHOT_MAX_BYTES: usize = 384 * 1024;
const ATTACH_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_REMOTE_SESSION_SECRET";
static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions/{id}/terminal/ws", get(terminal_websocket))
        .route("/api/sessions/{id}/terminal/token", get(terminal_token))
        .route(
            "/api/sessions/{id}/terminal/resize",
            axum::routing::post(terminal_resize),
        )
        .route(
            "/api/sessions/{id}/terminal/snapshot",
            get(terminal_snapshot),
        )
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

#[derive(Debug, Deserialize)]
struct TerminalSnapshotQuery {
    lines: Option<usize>,
    live: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TerminalResizeBody {
    cols: u16,
    rows: u16,
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

async fn terminal_token(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
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

async fn terminal_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalSnapshotQuery>,
) -> Response {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    let lines = query
        .lines
        .unwrap_or(DEFAULT_TERMINAL_SNAPSHOT_LINES)
        .clamp(25, MAX_TERMINAL_SNAPSHOT_LINES);
    let max_bytes = if query.live.unwrap_or(false) {
        LIVE_TERMINAL_SNAPSHOT_MAX_BYTES
    } else {
        READ_ONLY_TERMINAL_SNAPSHOT_MAX_BYTES
    };

    match build_terminal_snapshot(&state, &session, lines, max_bytes).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

async fn terminal_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<TerminalResizeBody>,
) -> Response {
    if state.get_session(&id).await.is_none() {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    }

    match state
        .resize_live_terminal(&id, body.cols.max(1), body.rows.max(1))
        .await
    {
        Ok(()) => Json(json!({ "ok": true, "sessionId": id })).into_response(),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    }
}

async fn build_terminal_snapshot(
    state: &AppState,
    session: &SessionRecord,
    lines: usize,
    max_bytes: usize,
) -> Result<Value> {
    if let Some(snapshot) = build_terminal_restore_snapshot(state, session).await? {
        let live = state.terminal_runtime_attached(&session.id).await;
        let restore_bytes = snapshot.render_bytes(max_bytes);
        return Ok(json!({
            "snapshot": String::from_utf8_lossy(&restore_bytes),
            "source": "terminal_state",
            "format": TERMINAL_RESTORE_SNAPSHOT_FORMAT,
            "snapshotVersion": snapshot.version,
            "sequence": snapshot.sequence,
            "cols": snapshot.cols,
            "rows": snapshot.rows,
            "historyBytes": snapshot.history_len(),
            "screenBytes": snapshot.screen_len(),
            "live": live,
            "restored": true,
        }));
    }

    if let Some((socket_path, tmux_session)) = tmux_runtime_metadata(session) {
        if tmux_session_exists(&socket_path, &tmux_session)
            .await
            .unwrap_or(false)
        {
            if let Ok(snapshot) = capture_tmux_pane(&socket_path, &tmux_session, lines).await {
                if !snapshot.trim().is_empty() {
                    return Ok(json!({
                        "snapshot": snapshot,
                        "source": "tmux_live",
                        "live": true,
                        "restored": true,
                    }));
                }
            }
        }
    }

    let terminal_capture_path = state.session_terminal_capture_path(&session.id);
    if let Some(snapshot) = read_terminal_log_tail(&terminal_capture_path, lines, max_bytes).await?
    {
        let live = state.terminal_runtime_attached(&session.id).await;
        return Ok(json!({
            "snapshot": snapshot,
            "source": "terminal_capture",
            "live": live,
            "restored": true,
        }));
    }

    if let Some(log_path) = session
        .metadata
        .get(TMUX_LOG_PATH_METADATA_KEY)
        .map(PathBuf::from)
    {
        if let Some(snapshot) = read_terminal_log_tail(&log_path, lines, max_bytes).await? {
            return Ok(json!({
                "snapshot": snapshot,
                "source": "tmux_log",
                "live": false,
                "restored": true,
            }));
        }
    }

    let snapshot = trim_utf8_tail_string(trim_lines_tail(&session.output, lines), max_bytes);
    Ok(json!({
        "snapshot": snapshot,
        "source": if session.output.trim().is_empty() { "empty" } else { "session_output" },
        "live": false,
        "restored": !session.output.trim().is_empty(),
    }))
}

async fn build_terminal_restore_snapshot(
    state: &AppState,
    session: &SessionRecord,
) -> Result<Option<TerminalRestoreSnapshot>> {
    Ok(state.current_terminal_restore_snapshot(&session.id).await)
}

async fn read_terminal_log_tail(
    path: &StdPath,
    lines: usize,
    max_bytes: usize,
) -> Result<Option<String>> {
    let Some(bytes) = read_terminal_log_tail_bytes(path, lines, max_bytes).await? else {
        return Ok(None);
    };
    let snapshot = String::from_utf8_lossy(&bytes).to_string();
    if snapshot.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(snapshot))
    }
}

async fn read_terminal_log_tail_bytes(
    path: &StdPath,
    lines: usize,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };

    let len = file.metadata().await?.len();
    let start = len.saturating_sub(MAX_TERMINAL_LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).await?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    let snapshot = trim_utf8_tail_string(
        trim_lines_tail(String::from_utf8_lossy(&bytes).as_ref(), lines),
        max_bytes,
    )
    .into_bytes();
    if String::from_utf8_lossy(&snapshot).trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(snapshot))
    }
}

fn trim_utf8_tail_string(value: String, max_bytes: usize) -> String {
    String::from_utf8_lossy(&trim_utf8_tail_bytes(value.into_bytes(), max_bytes)).into_owned()
}

fn trim_utf8_tail_bytes(bytes: Vec<u8>, max_bytes: usize) -> Vec<u8> {
    if max_bytes == 0 || bytes.len() <= max_bytes {
        return bytes;
    }

    let start = utf8_safe_tail_start(&bytes, bytes.len().saturating_sub(max_bytes));
    bytes[start..].to_vec()
}

fn utf8_safe_tail_start(bytes: &[u8], preferred_start: usize) -> usize {
    let mut start = preferred_start.min(bytes.len());
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start += 1;
    }
    start.min(bytes.len())
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

    let _ = state.ensure_session_live(&session_id).await;
    let _ = state.resize_live_terminal(&session_id, cols, rows).await;
    if let Some(session) = state.get_session(&session_id).await {
        if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await {
            let restore_bytes = snapshot.render_bytes(LIVE_TERMINAL_SNAPSHOT_MAX_BYTES);
            if !restore_bytes.is_empty()
                && socket
                    .send(Message::Binary(restore_bytes.into()))
                    .await
                    .is_err()
            {
                return;
            }
        }
    }

    let mut terminal_events = state.subscribe_terminal_stream(&session_id).await;
    let mut attach_retry = tokio::time::interval(ATTACH_RETRY_INTERVAL);
    attach_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = attach_retry.tick(), if terminal_events.is_none() => {
                let _ = state.ensure_session_live(&session_id).await;
                if terminal_events.is_none() {
                    terminal_events = state.subscribe_terminal_stream(&session_id).await;
                    if terminal_events.is_some() {
                        let _ = state.resize_live_terminal(&session_id, cols, rows).await;
                    }
                }
            }
            attach_event = async {
                match terminal_events.as_mut() {
                    Some(receiver) => Some(receiver.recv().await),
                    None => pending().await,
                }
            } => {
                match attach_event {
                    Some(Ok(TerminalStreamEvent::Output(bytes))) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
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
                    Some(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                        if let Some(session) = state.get_session(&session_id).await {
                            if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await
                            {
                                let restore_bytes = snapshot.render_bytes(LIVE_TERMINAL_SNAPSHOT_MAX_BYTES);
                                if !restore_bytes.is_empty()
                                    && socket
                                        .send(Message::Binary(restore_bytes.into()))
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
                        } else if socket
                            .send(Message::Text(server_error_event(&session_id, format!("Terminal stream skipped {skipped} frames while catching up")).into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some(Err(broadcast::error::RecvError::Closed)) => {
                        terminal_events = None;
                    }
                    None => {
                        terminal_events = None;
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
}

async fn handle_client_message(
    state: &Arc<AppState>,
    session_id: &str,
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
            if state.ensure_session_live(session_id).await? {
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
            state.resize_live_terminal(session_id, *cols, *rows).await?;
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
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
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
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
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
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }

        let token = create_terminal_token("session-123").expect("token should be created");
        assert!(verify_terminal_token("session-123", &token).expect("token should verify"));
    }
}
