use anyhow::{anyhow, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, LazyLock};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

use crate::routes::config::access_control_enabled;
use crate::state::{
    sanitize_terminal_text, trim_lines_tail, AppState, SessionRecord, TerminalRestoreSnapshot,
    DETACHED_LOG_PATH_METADATA_KEY, TERMINAL_RESTORE_SNAPSHOT_FORMAT,
};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<sha2::Sha256>;

const DEFAULT_TERMINAL_SNAPSHOT_LINES: usize = 10_000;
const MAX_TERMINAL_SNAPSHOT_LINES: usize = 12_000;
const MAX_TERMINAL_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_TERMINAL_SESSION_SECRET";
const TERMINAL_TOKEN_TTL_SECONDS: i64 = 300;
const MAX_TERMINAL_CLIENT_MESSAGE_BYTES: usize = 256 * 1024;
static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());

#[derive(Copy, Clone, PartialEq, Eq)]
enum TerminalTokenScope {
    Control,
}

impl TerminalTokenScope {
    fn as_str(self) -> &'static str {
        match self {
            TerminalTokenScope::Control => "control",
        }
    }
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerminalSnapshotQuery {
    lines: Option<usize>,
    live: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientMessage {
    Hello { cols: u16, rows: u16 },
    Resize { cols: u16, rows: u16 },
    Input { data: String },
    Ping,
}

#[derive(Debug, Deserialize)]
struct LegacyTtydResizeMessage {
    columns: u16,
    rows: u16,
}

enum ParsedTerminalClientMessage {
    Message(TerminalClientMessage),
    Ignore,
    Unsupported,
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

pub(crate) fn resolve_terminal_keys(
    keys: Option<String>,
    special: Option<String>,
) -> Result<String> {
    if let Some(keys) = keys {
        return Ok(keys);
    }

    match special
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("enter") => Ok("\r".to_string()),
        Some("tab") => Ok("\t".to_string()),
        Some("escape") => Ok("\u{1b}".to_string()),
        Some("backspace") => Ok("\u{7f}".to_string()),
        Some("ctrl-c") => Ok("\u{3}".to_string()),
        Some(other) => Err(anyhow!(format!("Unsupported special key: {other}"))),
        None => Err(anyhow!("keys or special is required")),
    }
}

pub fn ws_router() -> Router<Arc<AppState>> {
    Router::new().route(
        "/api/sessions/{id}/terminal/ws",
        get(terminal_native_websocket),
    )
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions/{id}/terminal/token", get(terminal_token))
        .route(
            "/api/sessions/{id}/terminal/snapshot",
            get(terminal_snapshot),
        )
}

fn terminal_snapshot_path(session_id: &str) -> String {
    format!("/api/sessions/{session_id}/terminal/snapshot?live=1")
}

fn terminal_output_path(session_id: &str) -> String {
    format!("/api/sessions/{session_id}/output")
}

fn terminal_ws_proxy_path(session_id: &str, token: Option<&str>) -> String {
    match token {
        Some(token) if !token.trim().is_empty() => {
            format!("/api/sessions/{session_id}/terminal/ws?token={token}")
        }
        _ => format!("/api/sessions/{session_id}/terminal/ws"),
    }
}

fn build_terminal_token_payload(
    session_id: &str,
    interactive: bool,
    token_required: bool,
    token: Option<&str>,
) -> Value {
    let ws_url = if interactive {
        Some(terminal_ws_proxy_path(session_id, token))
    } else {
        None
    };

    json!({
        "token": token,
        "required": token_required,
        "expiresInSeconds": if interactive && token_required { Some(TERMINAL_TOKEN_TTL_SECONDS) } else { None },
        "interactive": interactive,
        "reason": if interactive { Value::Null } else { Value::String("Session is not running".to_string()) },
        "wsUrl": ws_url,
        "ttydWsUrl": ws_url,
        "snapshotUrl": terminal_snapshot_path(session_id),
        "outputUrl": terminal_output_path(session_id),
    })
}

async fn terminal_token(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(_session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    let access = state.config.read().await.access.clone();
    let token_required = should_issue_terminal_token(&access);
    let interactive = state.ensure_session_live(&id).await.unwrap_or(false);
    let token = if interactive && token_required {
        match create_scoped_terminal_token(&id, TerminalTokenScope::Control) {
            Ok(token) => Some(token),
            Err(err) => {
                return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
            }
        }
    } else {
        None
    };

    Json(build_terminal_token_payload(
        &id,
        interactive,
        token_required,
        token.as_deref(),
    ))
    .into_response()
}

async fn terminal_native_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(_session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if let Err(err) = authorize_terminal_access(&state, &id, &headers, query.token.as_deref()).await
    {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    match state.ensure_session_live(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return error(StatusCode::CONFLICT, format!("Session {id} is not running"))
                .into_response();
        }
        Err(err) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to attach live terminal: {err}"),
            )
            .into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_native_terminal_socket(state, id, socket))
}

fn legacy_resize_message_to_client_message(
    resize: LegacyTtydResizeMessage,
    client_ready: bool,
) -> TerminalClientMessage {
    if client_ready {
        TerminalClientMessage::Resize {
            cols: resize.columns,
            rows: resize.rows,
        }
    } else {
        TerminalClientMessage::Hello {
            cols: resize.columns,
            rows: resize.rows,
        }
    }
}

fn parse_terminal_client_text_message(
    text: &str,
    client_ready: bool,
) -> ParsedTerminalClientMessage {
    if let Ok(message) = serde_json::from_str::<TerminalClientMessage>(text) {
        return ParsedTerminalClientMessage::Message(message);
    }

    if let Ok(resize) = serde_json::from_str::<LegacyTtydResizeMessage>(text) {
        return ParsedTerminalClientMessage::Message(legacy_resize_message_to_client_message(
            resize,
            client_ready,
        ));
    }

    ParsedTerminalClientMessage::Unsupported
}

fn parse_terminal_client_binary_message(
    data: &[u8],
    client_ready: bool,
) -> ParsedTerminalClientMessage {
    if data.is_empty() {
        return ParsedTerminalClientMessage::Ignore;
    }

    match data[0] {
        b'0' => match std::str::from_utf8(&data[1..]) {
            Ok(payload) => ParsedTerminalClientMessage::Message(TerminalClientMessage::Input {
                data: payload.to_string(),
            }),
            Err(_) => ParsedTerminalClientMessage::Unsupported,
        },
        b'1' => match serde_json::from_slice::<LegacyTtydResizeMessage>(&data[1..]) {
            Ok(resize) => ParsedTerminalClientMessage::Message(
                legacy_resize_message_to_client_message(resize, client_ready),
            ),
            Err(_) => ParsedTerminalClientMessage::Unsupported,
        },
        b'2' | b'3' => ParsedTerminalClientMessage::Ignore,
        b'{' => match std::str::from_utf8(data) {
            Ok(text) => parse_terminal_client_text_message(text, client_ready),
            Err(_) => ParsedTerminalClientMessage::Unsupported,
        },
        _ => match std::str::from_utf8(data) {
            Ok(text) => parse_terminal_client_text_message(text, client_ready),
            Err(_) => ParsedTerminalClientMessage::Unsupported,
        },
    }
}

async fn handle_native_terminal_socket(
    state: Arc<AppState>,
    session_id: String,
    mut client_socket: WebSocket,
) {
    let handle = state.ensure_terminal_host(&session_id).await;
    let mut terminal_rx = handle.terminal_tx.subscribe();
    let mut last_sequence_sent = 0_u64;
    let mut client_ready = false;

    loop {
        tokio::select! {
            client_message = client_socket.recv() => {
                match client_message {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > MAX_TERMINAL_CLIENT_MESSAGE_BYTES {
                            break;
                        }
                        match parse_terminal_client_text_message(&text, client_ready) {
                            ParsedTerminalClientMessage::Message(message) => {
                                if handle_native_terminal_client_message(
                                    &state,
                                    &session_id,
                                    &mut client_socket,
                                    &mut client_ready,
                                    &mut last_sequence_sent,
                                    Some(message),
                                ).await.is_err() {
                                    break;
                                }
                            }
                            ParsedTerminalClientMessage::Ignore => {}
                            ParsedTerminalClientMessage::Unsupported => {
                                if handle_native_terminal_client_message(
                                    &state,
                                    &session_id,
                                    &mut client_socket,
                                    &mut client_ready,
                                    &mut last_sequence_sent,
                                    None,
                                ).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if data.len() > MAX_TERMINAL_CLIENT_MESSAGE_BYTES {
                            break;
                        }
                        match parse_terminal_client_binary_message(&data, client_ready) {
                            ParsedTerminalClientMessage::Message(message) => {
                                if handle_native_terminal_client_message(
                                    &state,
                                    &session_id,
                                    &mut client_socket,
                                    &mut client_ready,
                                    &mut last_sequence_sent,
                                    Some(message),
                                ).await.is_err() {
                                    break;
                                }
                            }
                            ParsedTerminalClientMessage::Ignore => {}
                            ParsedTerminalClientMessage::Unsupported => {
                                if handle_native_terminal_client_message(
                                    &state,
                                    &session_id,
                                    &mut client_socket,
                                    &mut client_ready,
                                    &mut last_sequence_sent,
                                    None,
                                ).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if client_socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = terminal_rx.recv(), if client_ready => {
                match event {
                    Ok(crate::state::TerminalStreamEvent::Stream(chunk)) => {
                        if chunk.sequence <= last_sequence_sent {
                            continue;
                        }
                        last_sequence_sent = chunk.sequence;
                        if client_socket.send(Message::Binary(chunk.bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(crate::state::TerminalStreamEvent::Exit(exit_code)) => {
                        let _ = client_socket.send(Message::Text(json!({
                            "type": "exit",
                            "exitCode": exit_code,
                        }).to_string().into())).await;
                        let _ = client_socket.send(Message::Close(None)).await;
                        break;
                    }
                    Ok(crate::state::TerminalStreamEvent::Error(message)) => {
                        let _ = client_socket.send(Message::Text(json!({
                            "type": "error",
                            "message": message,
                        }).to_string().into())).await;
                        let _ = client_socket.send(Message::Close(None)).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if resend_terminal_snapshot(&state, &session_id, &mut client_socket, &mut last_sequence_sent)
                            .await
                            .is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn handle_native_terminal_client_message(
    state: &Arc<AppState>,
    session_id: &str,
    client_socket: &mut WebSocket,
    client_ready: &mut bool,
    last_sequence_sent: &mut u64,
    message: Option<TerminalClientMessage>,
) -> Result<()> {
    match message {
        Some(TerminalClientMessage::Hello { cols, rows }) => {
            let cols = cols.clamp(1, 4096);
            let rows = rows.clamp(1, 2048);
            let _ = state.resize_live_terminal(session_id, cols, rows).await;
            resend_terminal_snapshot(state, session_id, client_socket, last_sequence_sent).await?;
            *client_ready = true;
            let cwd = state
                .get_session(session_id)
                .await
                .and_then(|session| session.metadata.get("agentCwd").cloned());
            client_socket
                .send(Message::Text(
                    json!({
                        "type": "ready",
                        "sequence": *last_sequence_sent,
                        "cwd": cwd,
                    })
                    .to_string()
                    .into(),
                ))
                .await?;
        }
        Some(TerminalClientMessage::Resize { cols, rows }) => {
            let cols = cols.clamp(1, 4096);
            let rows = rows.clamp(1, 2048);
            let _ = state.resize_live_terminal(session_id, cols, rows).await;
        }
        Some(TerminalClientMessage::Input { data }) => {
            state.send_raw_to_session(session_id, data).await?;
        }
        Some(TerminalClientMessage::Ping) => {
            client_socket
                .send(Message::Text(json!({ "type": "pong" }).to_string().into()))
                .await?;
        }
        None => {
            client_socket
                .send(Message::Text(
                    json!({
                        "type": "error",
                        "message": "Unsupported terminal client message",
                    })
                    .to_string()
                    .into(),
                ))
                .await?;
        }
    }

    Ok(())
}

async fn resend_terminal_snapshot(
    state: &Arc<AppState>,
    session_id: &str,
    client_socket: &mut WebSocket,
    last_sequence_sent: &mut u64,
) -> Result<()> {
    if let Some(snapshot) = state.current_terminal_restore_snapshot(session_id).await {
        let bytes = snapshot.render_restore_bytes(TERMINAL_SNAPSHOT_MAX_BYTES);
        if !bytes.is_empty() {
            *last_sequence_sent = snapshot.sequence;
            client_socket.send(Message::Binary(bytes.into())).await?;
        }
        return Ok(());
    }

    if let Some(transcript) = state
        .current_terminal_transcript(
            session_id,
            DEFAULT_TERMINAL_SNAPSHOT_LINES,
            TERMINAL_SNAPSHOT_MAX_BYTES,
        )
        .await
    {
        if !transcript.trim().is_empty() {
            client_socket
                .send(Message::Binary(transcript.into_bytes().into()))
                .await?;
        }
    }

    Ok(())
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
    let live_requested = terminal_snapshot_live_requested(query.live.as_deref());

    match build_terminal_snapshot(
        &state,
        &session,
        lines,
        TERMINAL_SNAPSHOT_MAX_BYTES,
        live_requested,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

async fn build_terminal_snapshot(
    state: &AppState,
    session: &SessionRecord,
    lines: usize,
    max_bytes: usize,
    live_requested: bool,
) -> Result<Value> {
    if let Some(snapshot) = build_terminal_restore_snapshot(state, session).await? {
        let live = state.terminal_runtime_attached(&session.id).await;
        let restore_bytes = if live_requested {
            snapshot.render_restore_bytes(max_bytes)
        } else {
            snapshot.render_bytes(max_bytes)
        };
        let transcript = state
            .current_terminal_transcript(&session.id, lines, max_bytes)
            .await
            .unwrap_or_else(|| snapshot.transcript(lines, max_bytes));
        let transcript = if transcript.trim().is_empty() {
            terminal_snapshot_transcript_fallback(session, lines, max_bytes).await?
        } else {
            transcript
        };
        return Ok(json!({
            "snapshot": String::from_utf8_lossy(&restore_bytes),
            "transcript": transcript,
            "source": "terminal_state",
            "format": TERMINAL_RESTORE_SNAPSHOT_FORMAT,
            "snapshotVersion": snapshot.version,
            "sequence": snapshot.sequence,
            "cols": snapshot.cols,
            "rows": snapshot.rows,
            "modes": snapshot.modes,
            "historyBytes": snapshot.history_len(),
            "screenBytes": snapshot.screen_len(),
            "live": live,
            "restored": true,
        }));
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

async fn terminal_snapshot_transcript_fallback(
    session: &SessionRecord,
    lines: usize,
    max_bytes: usize,
) -> Result<String> {
    if let Some(path) = session
        .metadata
        .get(DETACHED_LOG_PATH_METADATA_KEY)
        .map(PathBuf::from)
    {
        if let Some(transcript) = read_terminal_log_transcript(&path, lines, max_bytes).await? {
            return Ok(transcript);
        }
    }

    Ok(trim_utf8_tail_string(
        trim_lines_tail(&session.output, lines),
        max_bytes,
    ))
}

async fn read_terminal_log_transcript(
    path: &StdPath,
    lines: usize,
    max_bytes: usize,
) -> Result<Option<String>> {
    let Some(bytes) = read_terminal_log_bytes(path).await? else {
        return Ok(None);
    };

    let sanitized = sanitize_terminal_text(String::from_utf8_lossy(&bytes).as_ref());
    let transcript = normalize_terminal_transcript(trim_utf8_tail_string(
        trim_lines_tail(&sanitized, lines),
        max_bytes,
    ));
    if transcript.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(transcript))
    }
}

async fn read_terminal_log_bytes(path: &StdPath) -> Result<Option<Vec<u8>>> {
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
    if String::from_utf8_lossy(&bytes).trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(bytes))
    }
}

fn normalize_terminal_transcript(value: String) -> String {
    let mut normalized = Vec::new();
    let mut previous_non_empty: Option<String> = None;
    let mut emitted_blank = false;

    for raw_line in value.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            if normalized.is_empty() || emitted_blank {
                continue;
            }
            normalized.push(String::new());
            emitted_blank = true;
            continue;
        }

        if previous_non_empty.as_deref() == Some(line) {
            continue;
        }

        normalized.push(line.to_string());
        previous_non_empty = Some(line.to_string());
        emitted_blank = false;
    }

    while normalized.last().is_some_and(|line| line.is_empty()) {
        normalized.pop();
    }

    normalized.join("\n")
}

fn trim_utf8_tail_string(value: String, max_bytes: usize) -> String {
    let bytes = value.into_bytes();
    if max_bytes == 0 || bytes.len() <= max_bytes {
        return String::from_utf8_lossy(&bytes).into_owned();
    }

    let start = utf8_safe_tail_start(&bytes, bytes.len().saturating_sub(max_bytes));
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn utf8_safe_tail_start(bytes: &[u8], preferred_start: usize) -> usize {
    let mut start = preferred_start.min(bytes.len());
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start += 1;
    }
    start.min(bytes.len())
}

fn terminal_snapshot_live_requested(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn bearer_authorization_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let rest = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

async fn authorize_terminal_access(
    state: &AppState,
    session_id: &str,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<()> {
    let access = state.config.read().await.access.clone();
    if !should_issue_terminal_token(&access) {
        return Ok(());
    }

    let token = query_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| bearer_authorization_token(headers))
        .ok_or_else(|| anyhow!("Terminal token is required"))?;

    if verify_terminal_token(session_id, &token)? {
        return Ok(());
    }

    Err(anyhow!("Invalid terminal token"))
}

fn should_issue_terminal_token(access: &conductor_core::config::DashboardAccessConfig) -> bool {
    access_control_enabled(access)
}

fn verify_terminal_token(session_id: &str, token: &str) -> Result<bool> {
    verify_scoped_terminal_token(session_id, token, &[TerminalTokenScope::Control])
}

fn verify_scoped_terminal_token(
    session_id: &str,
    token: &str,
    accepted_scopes: &[TerminalTokenScope],
) -> Result<bool> {
    let secret = terminal_token_secret();
    let Some((payload, signature)) = token.split_once('.') else {
        return Ok(false);
    };

    let raw_payload = payload.trim();
    let raw_signature = signature.trim();
    if raw_payload.is_empty() || raw_signature.is_empty() {
        return Ok(false);
    }

    let (scope, expires_at_raw, signed_payload) =
        if let Some((scope_raw, expires_at_raw)) = raw_payload.split_once(':') {
            let scope = match scope_raw {
                "control" => TerminalTokenScope::Control,
                _ => return Ok(false),
            };
            (scope, expires_at_raw, format!("{session_id}:{raw_payload}"))
        } else {
            (
                TerminalTokenScope::Control,
                raw_payload,
                format!("{session_id}:{raw_payload}"),
            )
        };

    if !accepted_scopes.contains(&scope) {
        return Ok(false);
    }

    let expires_at = expires_at_raw.parse::<i64>().ok();
    if expires_at.is_some_and(|value| value < chrono::Utc::now().timestamp()) {
        return Ok(false);
    }

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(signed_payload.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    Ok(expected.eq_ignore_ascii_case(raw_signature))
}

fn create_scoped_terminal_token(session_id: &str, scope: TerminalTokenScope) -> Result<String> {
    let secret = terminal_token_secret();
    let expires_at = chrono::Utc::now().timestamp() + TERMINAL_TOKEN_TTL_SECONDS;
    let payload = format!("{}:{expires_at}", scope.as_str());
    let signed_payload = format!("{session_id}:{payload}");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(signed_payload.as_bytes());
    Ok(format!(
        "{payload}.{}",
        hex::encode(mac.finalize().into_bytes())
    ))
}

fn terminal_token_secret() -> String {
    std::env::var(TERMINAL_TOKEN_SECRET_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PROCESS_TERMINAL_TOKEN_SECRET.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_token_round_trip_works() {
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }

        let token = create_scoped_terminal_token("session-123", TerminalTokenScope::Control)
            .expect("token should be created");
        assert!(verify_terminal_token("session-123", &token).expect("token should verify"));
    }

    #[test]
    fn terminal_token_rejects_wrong_session() {
        let token = create_scoped_terminal_token("session-123", TerminalTokenScope::Control)
            .expect("token should be created");
        assert!(!verify_terminal_token("session-456", &token).expect("verification should run"));
    }

    #[test]
    fn build_terminal_token_payload_keeps_legacy_ttyd_alias() {
        let payload = build_terminal_token_payload("session-123", true, true, Some("token-123"));
        assert_eq!(
            payload.get("wsUrl").and_then(Value::as_str),
            Some("/api/sessions/session-123/terminal/ws?token=token-123")
        );
        assert_eq!(
            payload.get("ttydWsUrl").and_then(Value::as_str),
            Some("/api/sessions/session-123/terminal/ws?token=token-123")
        );
    }

    #[test]
    fn legacy_ttyd_resize_maps_to_hello_before_ready() {
        let parsed = parse_terminal_client_binary_message(b"1{\"columns\":120,\"rows\":40}", false);
        match parsed {
            ParsedTerminalClientMessage::Message(TerminalClientMessage::Hello { cols, rows }) => {
                assert_eq!((cols, rows), (120, 40));
            }
            _ => panic!("expected legacy ttyd resize to map to hello"),
        }
    }

    #[test]
    fn legacy_ttyd_input_maps_to_native_input_message() {
        let parsed = parse_terminal_client_binary_message(b"0ls -la", true);
        match parsed {
            ParsedTerminalClientMessage::Message(TerminalClientMessage::Input { data }) => {
                assert_eq!(data, "ls -la");
            }
            _ => panic!("expected legacy ttyd input to map to native input"),
        }
    }
}
