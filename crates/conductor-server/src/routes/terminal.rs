use anyhow::{anyhow, Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::path::{Path as StdPath, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{self as stream, StreamExt};

use crate::routes::config::{
    access_control_enabled, proxy_request_authorized, resolve_access_identity, AccessRole,
};
use crate::routes::ttyd_protocol::{self, ClientMessage};
use crate::state::{
    sanitize_terminal_text, trim_lines_tail, AppState, SessionRecord, TerminalRestoreSnapshot,
    TerminalStreamChunk, TerminalStreamEvent, DETACHED_LOG_PATH_METADATA_KEY,
    TERMINAL_RESTORE_SNAPSHOT_FORMAT,
};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<sha2::Sha256>;

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const DEFAULT_TERMINAL_SNAPSHOT_LINES: usize = 10_000;
const MAX_TERMINAL_SNAPSHOT_LINES: usize = 12000;
const MAX_TERMINAL_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const LIVE_TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
const READ_ONLY_TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_REMOTE_SESSION_SECRET";
const TERMINAL_TOKEN_TTL_SECONDS: i64 = 60;
const TERMINAL_FRAME_PROTOCOL_VERSION: u8 = 2;
const TERMINAL_FRAME_MAGIC: [u8; 4] = *b"CTP2";
const TERMINAL_FRAME_KIND_RESTORE: u8 = 1;
const TERMINAL_FRAME_KIND_STREAM: u8 = 2;
const TERMINAL_RESTORE_FRAME_MODE_BYTES: usize = 4;
const SERVER_TIMING_HEADER: &str = "server-timing";
const TERMINAL_SNAPSHOT_SOURCE_HEADER: &str = "x-conductor-terminal-snapshot-source";
const TERMINAL_SNAPSHOT_LIVE_HEADER: &str = "x-conductor-terminal-snapshot-live";
const TERMINAL_SNAPSHOT_RESTORED_HEADER: &str = "x-conductor-terminal-snapshot-restored";
const TERMINAL_SNAPSHOT_FORMAT_HEADER: &str = "x-conductor-terminal-snapshot-format";
const TERMINAL_RESIZE_COLS_HEADER: &str = "x-conductor-terminal-resize-cols";
const TERMINAL_RESIZE_ROWS_HEADER: &str = "x-conductor-terminal-resize-rows";
static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());

#[derive(Copy, Clone, PartialEq, Eq)]
enum TerminalTokenScope {
    Stream,
    Control,
}

impl TerminalTokenScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stream => "stream",
            Self::Control => "control",
        }
    }
}

#[derive(Copy, Clone)]
enum TerminalSnapshotReason {
    Attach,
    Lagged,
}

impl TerminalSnapshotReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Lagged => "lagged",
        }
    }

    fn as_code(self) -> u8 {
        match self {
            Self::Attach => 1,
            Self::Lagged => 2,
        }
    }
}

/// WebSocket routes that must bypass CorsLayer to avoid 101 response interference.
pub fn ws_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions/{id}/terminal/ws", get(terminal_websocket))
        .route(
            "/api/sessions/{id}/terminal/control/ws",
            get(terminal_control_websocket),
        )
}

/// Non-WebSocket terminal routes (HTTP/SSE) that go through normal CORS middleware.
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/sessions/{id}/terminal/stream-token",
            get(terminal_stream_token),
        )
        .route("/api/sessions/{id}/terminal/token", get(terminal_token))
        .route(
            "/api/sessions/{id}/terminal/resize",
            axum::routing::post(terminal_resize),
        )
        .route(
            "/api/sessions/{id}/terminal/snapshot",
            get(terminal_snapshot),
        )
        .route("/api/sessions/{id}/terminal/stream", get(terminal_stream))
        .route("/api/sessions/{id}/terminal/connection", get(terminal_connection))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

fn elapsed_duration_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1000.0
}

fn append_server_timing_metric(headers: &mut HeaderMap, metric_name: &str, duration_ms: f64) {
    let value = format!("{metric_name};dur={duration_ms:.1}");
    if let Ok(header_value) = HeaderValue::from_str(&value) {
        headers.append(HeaderName::from_static(SERVER_TIMING_HEADER), header_value);
    }
}

fn set_terminal_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), header_value);
    }
}

fn set_terminal_bool_header(headers: &mut HeaderMap, name: &'static str, value: bool) {
    set_terminal_header(headers, name, if value { "true" } else { "false" });
}

fn timed_error_response(
    status: StatusCode,
    message: impl Into<String>,
    metric_name: &str,
    started_at: Instant,
) -> Response {
    let mut response = error(status, message).into_response();
    append_server_timing_metric(
        response.headers_mut(),
        metric_name,
        elapsed_duration_ms(started_at),
    );
    response
}

fn build_terminal_snapshot_response(payload: Value, started_at: Instant) -> Response {
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .map(str::to_string);
    let live = payload.get("live").and_then(Value::as_bool);
    let restored = payload.get("restored").and_then(Value::as_bool);
    let format = payload
        .get("format")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut response = Json(payload).into_response();
    let headers = response.headers_mut();
    append_server_timing_metric(
        headers,
        "terminal_snapshot",
        elapsed_duration_ms(started_at),
    );
    if let Some(source) = source.as_deref() {
        set_terminal_header(headers, TERMINAL_SNAPSHOT_SOURCE_HEADER, source);
    }
    if let Some(live) = live {
        set_terminal_bool_header(headers, TERMINAL_SNAPSHOT_LIVE_HEADER, live);
    }
    if let Some(restored) = restored {
        set_terminal_bool_header(headers, TERMINAL_SNAPSHOT_RESTORED_HEADER, restored);
    }
    if let Some(format) = format.as_deref() {
        set_terminal_header(headers, TERMINAL_SNAPSHOT_FORMAT_HEADER, format);
    }
    response
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    cols: Option<u16>,
    rows: Option<u16>,
    token: Option<String>,
    sequence: Option<u64>,
    /// When set to "ttyd", the WebSocket uses bidirectional binary mode:
    /// output frames are `['0' (0x30)][raw PTY bytes]`, input frames `['0' (0x30)][bytes]`
    /// send keystrokes, `['1' (0x31)][JSON{columns,rows}]` sends a resize,
    /// `['2' (0x32)]` pauses output, and `['3' (0x33)]` resumes output.
    protocol: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerminalSnapshotQuery {
    lines: Option<usize>,
    live: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerminalResizeBody {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalControlMessage {
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
enum TerminalControlBatchOperation {
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

    let bidirectional = query.protocol.as_deref() == Some("ttyd");

    // Bidirectional mode sends keystrokes, so require operator-level access.
    if bidirectional {
        if let Err(err) = authorize_terminal_access(&state, &id, query.token.as_deref()).await {
            return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
        }
    } else if let Err(err) =
        authorize_terminal_stream_socket_access(&state, &id, query.token.as_deref()).await
    {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    let cols = query.cols.unwrap_or(DEFAULT_TERMINAL_COLS).max(1);
    let rows = query.rows.unwrap_or(DEFAULT_TERMINAL_ROWS).max(1);
    let client_sequence = query.sequence;

    ws.on_upgrade(move |socket| {
        handle_terminal_socket(socket, state, id, cols, rows, client_sequence, bidirectional)
    })
}

async fn terminal_control_websocket(
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
    ws.on_upgrade(move |socket| handle_terminal_control_socket(socket, state, id, cols, rows))
}

async fn terminal_token(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    build_terminal_token_response(state, id, TerminalTokenScope::Control).await
}

async fn terminal_stream_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    build_terminal_token_response(state, id, TerminalTokenScope::Stream).await
}

async fn build_terminal_token_response(
    state: Arc<AppState>,
    id: String,
    scope: TerminalTokenScope,
) -> Response {
    if state.get_session(&id).await.is_none() {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    }

    let access = state.config.read().await.access.clone();
    let token_required = should_issue_terminal_token(&access);
    let token = if token_required {
        create_scoped_terminal_token(&id, scope).ok()
    } else {
        None
    };

    Json(json!({
        "token": token,
        "required": token_required,
        "expiresInSeconds": token.as_ref().map(|_| TERMINAL_TOKEN_TTL_SECONDS),
    }))
    .into_response()
}

async fn terminal_connection(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(err) = authorize_terminal_access(&state, &id, None).await {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    let Some(_session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    // Get control token for bidirectional TTyD mode
    let access = state.config.read().await.access.clone();
    let token_required = should_issue_terminal_token(&access);
    let control_token = if token_required {
        create_scoped_terminal_token(&id, TerminalTokenScope::Control).ok()
    } else {
        None
    };

    // Build TTyD WebSocket URL with token and protocol parameter
    let pty_ws_url = if control_token.is_some() || !token_required {
        let token_param = control_token
            .as_ref()
            .map(|t| format!("&token={}", t))
            .unwrap_or_default();
        Some(format!(
            "/api/sessions/{}/terminal/ws?protocol=ttyd{}",
            id, token_param
        ))
    } else {
        None
    };

    // Also build stream token and stream WebSocket URL
    let stream_token = if token_required {
        create_scoped_terminal_token(&id, TerminalTokenScope::Stream).ok()
    } else {
        None
    };

    let stream_token_param = stream_token
        .as_ref()
        .map(|t| format!("&token={}", t))
        .unwrap_or_default();
    let stream_ws_url = if stream_token_param.is_empty() {
        format!("/api/sessions/{}/terminal/stream", id)
    } else {
        format!(
            "/api/sessions/{}/terminal/stream?{}",
            id,
            stream_token_param.trim_start_matches('&')
        )
    };

    Json(json!({
        "ptyWsUrl": pty_ws_url,
        "stream": {
            "wsUrl": stream_ws_url,
        },
        "control": {
            "interactive": true,
        }
    }))
    .into_response()
}

async fn terminal_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalSnapshotQuery>,
) -> Response {
    let started_at = Instant::now();
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    let lines = query
        .lines
        .unwrap_or(DEFAULT_TERMINAL_SNAPSHOT_LINES)
        .clamp(25, MAX_TERMINAL_SNAPSHOT_LINES);
    let max_bytes = if terminal_snapshot_live_requested(query.live.as_deref()) {
        LIVE_TERMINAL_SNAPSHOT_MAX_BYTES
    } else {
        READ_ONLY_TERMINAL_SNAPSHOT_MAX_BYTES
    };
    let live_requested = terminal_snapshot_live_requested(query.live.as_deref());

    match build_terminal_snapshot(&state, &session, lines, max_bytes, live_requested).await {
        Ok(snapshot) => build_terminal_snapshot_response(snapshot, started_at),
        Err(err) => timed_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            err.to_string(),
            "terminal_snapshot",
            started_at,
        ),
    }
}

async fn terminal_stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if let Err(err) =
        authorize_terminal_stream_access(&state, &id, query.token.as_deref(), &headers).await
    {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    let cols = query.cols.unwrap_or(DEFAULT_TERMINAL_COLS).max(1);
    let rows = query.rows.unwrap_or(DEFAULT_TERMINAL_ROWS).max(1);
    let _ = state.ensure_session_live(&id).await;
    let handle = state.ensure_terminal_host(&id).await;
    let _ = state.resize_live_terminal(&id, cols, rows).await;

    let terminal_events = handle.terminal_tx.subscribe();
    let sequence_floor = Arc::new(AtomicU64::new(0));
    let mut initial_events = vec![Ok::<SseEvent, Infallible>(
        SseEvent::default().data(server_ready_event(&id)),
    )];

    if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await {
        sequence_floor.store(snapshot.sequence, Ordering::Relaxed);
        if should_send_initial_restore(&snapshot, query.sequence) {
            initial_events.push(Ok(SseEvent::default().data(server_terminal_restore_event(
                &id,
                &snapshot,
                TerminalSnapshotReason::Attach,
                LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
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
                        if let Some(session) = state.get_session(&session_id).await {
                            if let Ok(Some(snapshot)) =
                                build_terminal_restore_snapshot(&state, &session).await
                            {
                                sequence_floor.store(snapshot.sequence, Ordering::Relaxed);
                                return Some(Ok(SseEvent::default().data(
                                    server_terminal_restore_event(
                                        &session_id,
                                        &snapshot,
                                        TerminalSnapshotReason::Lagged,
                                        LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
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

async fn terminal_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<TerminalResizeBody>,
) -> Response {
    let started_at = Instant::now();
    if state.get_session(&id).await.is_none() {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    }

    let cols = body.cols.max(1);
    let rows = body.rows.max(1);
    match state.resize_live_terminal(&id, cols, rows).await {
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
            set_terminal_header(headers, TERMINAL_RESIZE_COLS_HEADER, &cols.to_string());
            set_terminal_header(headers, TERMINAL_RESIZE_ROWS_HEADER, &rows.to_string());
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

    let snapshot = trim_utf8_tail_string(trim_lines_tail(&session.output, lines), max_bytes);
    Ok(json!({
        "snapshot": snapshot,
        "source": if session.output.trim().is_empty() { "empty" } else { "session_output" },
        "live": false,
        "restored": !session.output.trim().is_empty(),
    }))
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
    let Some(bytes) = read_terminal_log_bytes(path).await? else {
        return Ok(None);
    };
    let snapshot = trim_utf8_tail_string(
        trim_lines_tail(String::from_utf8_lossy(&bytes).as_ref(), lines),
        max_bytes,
    );
    if snapshot.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(snapshot))
    }
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

fn trim_utf8_tail_string(value: String, max_bytes: usize) -> String {
    String::from_utf8_lossy(&trim_utf8_tail_bytes(value.into_bytes(), max_bytes)).into_owned()
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

fn encode_terminal_restore_frame(
    snapshot: &TerminalRestoreSnapshot,
    reason: TerminalSnapshotReason,
    max_bytes: usize,
) -> Vec<u8> {
    let payload = snapshot.render_restore_bytes(max_bytes);
    let mut frame = Vec::with_capacity(20 + TERMINAL_RESTORE_FRAME_MODE_BYTES + payload.len());
    frame.extend_from_slice(&TERMINAL_FRAME_MAGIC);
    frame.push(TERMINAL_FRAME_PROTOCOL_VERSION);
    frame.push(TERMINAL_FRAME_KIND_RESTORE);
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

fn encode_terminal_stream_frame(chunk: &TerminalStreamChunk) -> Vec<u8> {
    let mut frame = Vec::with_capacity(14 + chunk.bytes.len());
    frame.extend_from_slice(&TERMINAL_FRAME_MAGIC);
    frame.push(TERMINAL_FRAME_PROTOCOL_VERSION);
    frame.push(TERMINAL_FRAME_KIND_STREAM);
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

fn should_send_initial_restore(
    snapshot: &TerminalRestoreSnapshot,
    client_sequence: Option<u64>,
) -> bool {
    client_sequence
        .map(|sequence| sequence != snapshot.sequence)
        .unwrap_or(true)
}

fn should_skip_stream_chunk(sequence_floor: Option<u64>, chunk_sequence: u64) -> bool {
    sequence_floor
        .map(|sequence| chunk_sequence <= sequence)
        .unwrap_or(false)
}

/// Wrap raw PTY bytes in a ttyd-style output frame: `['0' (0x30)][bytes]`.
fn encode_ttyd_output_frame(bytes: &[u8]) -> Vec<u8> {
    ttyd_protocol::encode_output(bytes)
}

async fn handle_terminal_socket(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    client_sequence: Option<u64>,
    bidirectional: bool,
) {
    // For bidirectional (ttyd) mode, wait for client JSON_DATA handshake first.
    // Per ttyd protocol the handshake carries {columns, rows} for initial sizing.
    let (cols, rows) = if bidirectional {
        let mut handshake_cols = cols;
        let mut handshake_rows = rows;
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), socket.recv()).await {
                Ok(Some(Ok(msg))) => {
                    if let Message::Binary(data) = &msg {
                        if !data.is_empty() && data[0] == b'{' {
                            // Parse cols/rows from the handshake JSON
                            if let Ok(json_str) = std::str::from_utf8(data) {
                                if let Ok(value) = serde_json::from_str::<Value>(json_str) {
                                    if let Some(c) = value.get("columns").and_then(Value::as_u64) {
                                        handshake_cols = (c as u16).max(1);
                                    }
                                    if let Some(r) = value.get("rows").and_then(Value::as_u64) {
                                        handshake_rows = (r as u16).max(1);
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
                Ok(Some(Err(_))) | Ok(None) | Err(_) => return,
            }
        }

        // ttyd protocol: respond with SET_WINDOW_TITLE and SET_PREFERENCES
        let title_frame = ttyd_protocol::encode_window_title(&session_id);
        if socket
            .send(Message::Binary(title_frame.into()))
            .await
            .is_err()
        {
            return;
        }

        let prefs_frame = ttyd_protocol::encode_preferences(&ttyd_protocol::default_preferences());
        if socket
            .send(Message::Binary(prefs_frame.into()))
            .await
            .is_err()
        {
            return;
        }

        (handshake_cols, handshake_rows)
    } else {
        if socket
            .send(Message::Text(server_ready_event(&session_id).into()))
            .await
            .is_err()
        {
            return;
        }
        (cols, rows)
    };

    let _ = state.ensure_session_live(&session_id).await;
    let handle = state.ensure_terminal_host(&session_id).await;
    let _ = state.resize_live_terminal(&session_id, cols, rows).await;
    let mut terminal_events = Some(handle.terminal_tx.subscribe());
    let mut stream_sequence_floor = None;
    if let Some(session) = state.get_session(&session_id).await {
        if let Ok(Some(snapshot)) = build_terminal_restore_snapshot(&state, &session).await {
            if should_send_initial_restore(&snapshot, client_sequence) {
                if bidirectional {
                    // In bidirectional mode, do NOT replay raw history bytes.
                    // History contains ANSI cursor positioning for the terminal
                    // width that was active when the bytes were written. Replaying
                    // them at the client's current width produces garbled TUI output.
                    // Instead, clear the screen and force SIGWINCH so the running
                    // agent repaints its TUI at the correct dimensions.
                    let clear_frame = encode_ttyd_output_frame(b"\x1b[2J\x1b[H");
                    if socket.send(Message::Binary(clear_frame.into())).await.is_err() {
                        return;
                    }
                    let _ = state.resize_live_terminal(&session_id, cols, rows).await;
                } else {
                    let restore_frame = encode_terminal_restore_frame(
                        &snapshot,
                        TerminalSnapshotReason::Attach,
                        LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
                    );
                    if socket
                        .send(Message::Binary(restore_frame.into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                stream_sequence_floor = Some(snapshot.sequence);
            } else {
                stream_sequence_floor = Some(snapshot.sequence);
            }
        }
    }

    // For bidirectional (ttyd) mode, batch stream output chunks into fewer,
    // larger WebSocket frames. The PTY read loop uses a 4KB buffer, so a
    // single TUI update from Claude Code (8-20KB of ANSI sequences) arrives
    // as multiple small broadcast events. Sending each as a separate WebSocket
    // message causes xterm.js to render intermediate partial states — visible
    // as garbled/flickering output. Batching at ~16ms (one display frame)
    // ensures complete TUI updates land as a single message.
    let mut batch_buffer: Vec<u8> = Vec::new();
    let mut batch_interval = tokio::time::interval(std::time::Duration::from_millis(16));
    batch_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Skip the first immediate tick so we don't flush an empty buffer.
    batch_interval.reset();

    loop {
        tokio::select! {
            biased;

            // Drain all pending stream events first (accumulate into batch).
            attach_event = async {
                match terminal_events.as_mut() {
                    Some(receiver) => Some(receiver.recv().await),
                    None => None,
                }
            } => {
                match attach_event {
                    Some(Ok(TerminalStreamEvent::Stream(chunk))) => {
                        if should_skip_stream_chunk(stream_sequence_floor, chunk.sequence) {
                            continue;
                        }
                        if bidirectional {
                            // Accumulate in batch buffer — flushed by the interval tick below.
                            batch_buffer.extend_from_slice(&chunk.bytes);
                            // Safety valve: flush immediately if batch exceeds 128KB to
                            // bound memory usage during high-throughput bursts.
                            if batch_buffer.len() >= 131_072 {
                                let frame = encode_ttyd_output_frame(&batch_buffer);
                                batch_buffer.clear();
                                if socket.send(Message::Binary(frame.into())).await.is_err() {
                                    break;
                                }
                            }
                        } else {
                            let frame = encode_terminal_stream_frame(&chunk);
                            if socket
                                .send(Message::Binary(frame.into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
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
                                if bidirectional {
                                    // Clear screen and force SIGWINCH so the agent repaints
                                    // at the correct dimensions (same as initial attach).
                                    let clear_frame = encode_ttyd_output_frame(b"\x1b[2J\x1b[H");
                                    if socket
                                        .send(Message::Binary(clear_frame.into()))
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                    let _ = state.resize_live_terminal(&session_id, cols, rows).await;
                                } else {
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
                                    let restore_frame = encode_terminal_restore_frame(
                                        &snapshot,
                                        TerminalSnapshotReason::Lagged,
                                        LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
                                    );
                                    if socket
                                        .send(Message::Binary(restore_frame.into()))
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
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
            // Flush the accumulated batch buffer to the client on the ~16ms interval.
            // The guard ensures we only wake for this branch when there is actual data.
            _ = batch_interval.tick(), if !batch_buffer.is_empty() => {
                let frame = encode_ttyd_output_frame(&batch_buffer);
                batch_buffer.clear();
                if socket.send(Message::Binary(frame.into())).await.is_err() {
                    break;
                }
            }

            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(data))) if bidirectional && !data.is_empty() => {
                        if let Some(client_msg) = ClientMessage::from_websocket_frame(&data) {
                            match client_msg {
                                ClientMessage::Input(bytes) => {
                                    if let Ok(input_str) = String::from_utf8(bytes.clone()) {
                                        let _ = state.send_raw_to_session(&session_id, input_str).await;
                                    } else {
                                        // Non-UTF8 bytes are lossy-converted (U+FFFD replaces
                                        // invalid sequences). In practice keyboard input is
                                        // always UTF-8, so this path only fires for corrupt data.
                                        let input_str = String::from_utf8_lossy(&bytes).to_string();
                                        let _ = state.send_raw_to_session(&session_id, input_str).await;
                                    }
                                }
                                ClientMessage::Resize { columns, rows } => {
                                    let _ = state.resize_live_terminal(&session_id, columns.max(1), rows.max(1)).await;
                                }
                                ClientMessage::Pause => {
                                    // TODO: implement per-session flow control — gate batch
                                    // flushing with an AtomicBool toggled here. Currently the
                                    // server keeps sending output regardless of PAUSE.
                                    tracing::debug!(session_id = %session_id, "Client pause requested (not yet enforced)");
                                }
                                ClientMessage::Resume => {
                                    // TODO: clear the paused flag so batch flushing resumes.
                                    tracing::debug!(session_id = %session_id, "Client resume requested (not yet enforced)");
                                }
                                ClientMessage::Handshake(_) => {
                                    // Handshake should be the first message
                                    tracing::debug!(session_id = %session_id, "Handshake received during session");
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Text(text))) if bidirectional => {
                        // Accept text frames as raw input in bidirectional mode
                        let _ = state.send_raw_to_session(&session_id, text.to_string()).await;
                    }
                    Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                        if socket
                            .send(
                                Message::Text(
                                    server_error_event(
                                        &session_id,
                                        "Terminal stream is output-only; use HTTP control routes for input and resize",
                                    )
                                    .into(),
                                ),
                            )
                            .await
                            .is_err()
                        {
                            break;
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
        }
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
        .send(Message::Text(server_ready_event(&session_id).into()))
        .await
        .is_err()
    {
        return;
    }

    let _ = state.ensure_session_live(&session_id).await;
    let _ = state.resize_live_terminal(&session_id, cols, rows).await;

    while let Some(message) = socket.recv().await {
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
                        server_error_event(
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
}

async fn handle_control_message(
    state: &Arc<AppState>,
    session_id: &str,
    cols: &mut u16,
    rows: &mut u16,
    message: TerminalControlMessage,
) -> Result<Option<String>> {
    match message {
        TerminalControlMessage::Ping => Ok(Some(server_pong_event(session_id))),
        TerminalControlMessage::Batch { operations } => {
            for operation in operations {
                match operation {
                    TerminalControlBatchOperation::Keys { keys, special } => {
                        let chunk = resolve_terminal_keys(keys, special)?;
                        if state.ensure_session_live(session_id).await? {
                            state.send_raw_to_session(session_id, chunk).await?;
                        } else {
                            return Err(anyhow!("Terminal is not currently attached"));
                        }
                    }
                    TerminalControlBatchOperation::Resize {
                        cols: next_cols,
                        rows: next_rows,
                    } => {
                        *cols = next_cols.max(1);
                        *rows = next_rows.max(1);
                        state.resize_live_terminal(session_id, *cols, *rows).await?;
                    }
                }
            }
            Ok(None)
        }
        TerminalControlMessage::Keys { keys, special } => {
            let chunk = resolve_terminal_keys(keys, special)?;
            if state.ensure_session_live(session_id).await? {
                state.send_raw_to_session(session_id, chunk).await?;
            } else {
                return Err(anyhow!("Terminal is not currently attached"));
            }
            Ok(None)
        }
        TerminalControlMessage::Resize {
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

pub(crate) fn resolve_terminal_keys(
    keys: Option<String>,
    special: Option<String>,
) -> Result<String> {
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

async fn authorize_terminal_stream_socket_access(
    state: &Arc<AppState>,
    session_id: &str,
    token: Option<&str>,
) -> Result<()> {
    let access = state.config.read().await.access.clone();
    if !access_control_enabled(&access) {
        return Ok(());
    }

    let token = token.ok_or_else(|| anyhow!("Terminal token is required"))?;
    if verify_terminal_stream_token(session_id, token)? {
        return Ok(());
    }

    Err(anyhow!("Invalid terminal token"))
}

async fn authorize_terminal_stream_access(
    state: &Arc<AppState>,
    session_id: &str,
    token: Option<&str>,
    headers: &HeaderMap,
) -> Result<()> {
    let access = state.config.read().await.access.clone();
    if !access_control_enabled(&access) {
        return Ok(());
    }

    let identity = resolve_access_identity(headers, &access).await;
    if proxy_request_authorized(headers) {
        if !identity.authenticated {
            return Err(anyhow!("Proxy access is not authenticated"));
        }

        if matches!(identity.role, Some(role) if role.allows(AccessRole::Viewer)) {
            return Ok(());
        }
    }

    authorize_terminal_stream_socket_access(state, session_id, token).await
}

fn verify_scoped_terminal_token(
    session_id: &str,
    token: &str,
    accepted_scopes: &[TerminalTokenScope],
) -> Result<bool> {
    let secret = terminal_token_secret();

    let (raw_payload, provided_signature) = token
        .split_once('.')
        .ok_or_else(|| anyhow!("Malformed terminal token"))?;
    let (scope, expires_at_raw, payload) =
        if let Some((scope_raw, expires_at_raw)) = raw_payload.split_once(':') {
            let scope = match scope_raw {
                "stream" => TerminalTokenScope::Stream,
                "control" => TerminalTokenScope::Control,
                _ => return Ok(false),
            };
            (
                scope,
                expires_at_raw,
                format!("{session_id}:{scope_raw}:{expires_at_raw}"),
            )
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

    let expires_at = expires_at_raw
        .parse::<i64>()
        .context("Invalid terminal token expiry")?;
    if chrono::Utc::now().timestamp() > expires_at {
        return Ok(false);
    }

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    let expected_signature = hex::encode(mac.finalize().into_bytes());
    Ok(constant_time_equal(
        expected_signature.as_bytes(),
        provided_signature.as_bytes(),
    ))
}

fn verify_terminal_token(session_id: &str, token: &str) -> Result<bool> {
    verify_scoped_terminal_token(session_id, token, &[TerminalTokenScope::Control])
}

fn verify_terminal_stream_token(session_id: &str, token: &str) -> Result<bool> {
    verify_scoped_terminal_token(
        session_id,
        token,
        &[TerminalTokenScope::Stream, TerminalTokenScope::Control],
    )
}

fn create_scoped_terminal_token(session_id: &str, scope: TerminalTokenScope) -> Result<String> {
    let secret = terminal_token_secret();
    let expires_at = chrono::Utc::now().timestamp() + TERMINAL_TOKEN_TTL_SECONDS;
    let payload = format!("{session_id}:{}:{expires_at}", scope.as_str());
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    Ok(format!("{}:{expires_at}.{signature}", scope.as_str()))
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

fn server_control_event(session_id: &str, event: &str) -> String {
    json!({
        "type": "control",
        "event": event,
        "sessionId": session_id,
    })
    .to_string()
}

fn server_ready_event(session_id: &str) -> String {
    server_control_event(session_id, "ready")
}

fn server_recovery_event(
    session_id: &str,
    skipped: u64,
    snapshot: &TerminalRestoreSnapshot,
) -> String {
    json!({
        "type": "recovery",
        "sessionId": session_id,
        "reason": TerminalSnapshotReason::Lagged.as_str(),
        "skipped": skipped,
        "sequence": snapshot.sequence,
        "snapshotVersion": snapshot.version,
        "cols": snapshot.cols,
        "rows": snapshot.rows,
        "modes": snapshot.modes,
    })
    .to_string()
}

fn server_terminal_restore_event(
    session_id: &str,
    snapshot: &TerminalRestoreSnapshot,
    reason: TerminalSnapshotReason,
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

fn server_terminal_stream_event(session_id: &str, chunk: &TerminalStreamChunk) -> String {
    json!({
        "type": "stream",
        "sessionId": session_id,
        "sequence": chunk.sequence,
        "payload": BASE64_STANDARD.encode(&chunk.bytes),
    })
    .to_string()
}

fn server_exit_event(session_id: &str, exit_code: i32) -> String {
    json!({
        "type": "control",
        "event": "exit",
        "sessionId": session_id,
        "exitCode": exit_code,
    })
    .to_string()
}

fn server_pong_event(session_id: &str) -> String {
    server_control_event(session_id, "pong")
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
    use axum::body::Body;
    use axum::http::Request;
    use conductor_core::config::ConductorConfig;
    use conductor_db::Database;
    use conductor_executors::executor::ExecutorInput;
    use std::sync::Arc;
    use tokio::fs;
    use tokio::sync::{mpsc, oneshot};
    use tower::util::ServiceExt;
    use uuid::Uuid;

    async fn build_test_state() -> (Arc<AppState>, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("conductor-terminal-route-test-{}", Uuid::new_v4()));
        let config = ConductorConfig {
            workspace: root.clone(),
            ..ConductorConfig::default()
        };
        let db = Database::in_memory()
            .await
            .expect("in-memory db should initialize");
        let state = AppState::new(root.join("conductor.yaml"), config, db).await;
        (state, root)
    }

    async fn seed_live_terminal_session(state: &Arc<AppState>, session_id: &str) -> SessionRecord {
        let session = SessionRecord::builder(
            session_id.to_string(),
            "demo".to_string(),
            "codex".to_string(),
            "Validate terminal restore".to_string(),
        )
        .build();
        state
            .sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        let (input_tx, _input_rx) = mpsc::channel::<ExecutorInput>(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        state
            .attach_terminal_runtime(&session.id, input_tx, None, kill_tx)
            .await;
        state
            .emit_terminal_text(&session.id, "first line\r\nprompt> ")
            .await;

        session
    }

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
    fn terminal_control_message_batch_deserializes() {
        let payload = serde_json::json!({
            "type": "batch",
            "operations": [
                { "type": "keys", "keys": "abc" },
                { "type": "resize", "cols": 120, "rows": 40 }
            ]
        });
        let message: TerminalControlMessage =
            serde_json::from_value(payload).expect("batch control message should deserialize");

        assert_eq!(
            message,
            TerminalControlMessage::Batch {
                operations: vec![
                    TerminalControlBatchOperation::Keys {
                        keys: Some("abc".to_string()),
                        special: None,
                    },
                    TerminalControlBatchOperation::Resize {
                        cols: 120,
                        rows: 40
                    },
                ],
            }
        );
    }

    #[test]
    fn server_control_event_includes_event_name() {
        let payload = server_ready_event("session-123");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("control payload should be valid json");

        assert_eq!(parsed["type"], "control");
        assert_eq!(parsed["sessionId"], "session-123");
        assert_eq!(parsed["event"], "ready");
    }

    #[test]
    fn server_recovery_event_includes_snapshot_metadata() {
        let snapshot = TerminalRestoreSnapshot {
            version: 1,
            sequence: 17,
            cols: 132,
            rows: 40,
            has_output: true,
            modes: Default::default(),
            history: b"hello".to_vec(),
            screen: b"prompt> ".to_vec(),
        };

        let payload = server_recovery_event("session-123", 9, &snapshot);
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("recovery payload should be valid json");

        assert_eq!(parsed["type"], "recovery");
        assert_eq!(parsed["sessionId"], "session-123");
        assert_eq!(parsed["reason"], "lagged");
        assert_eq!(parsed["skipped"], 9);
        assert_eq!(parsed["sequence"], 17);
        assert_eq!(parsed["cols"], 132);
        assert_eq!(parsed["rows"], 40);
        assert_eq!(parsed["modes"]["alternateScreen"], false);
    }

    #[test]
    fn server_terminal_restore_event_encodes_snapshot_payload() {
        let snapshot = TerminalRestoreSnapshot {
            version: 1,
            sequence: 17,
            cols: 132,
            rows: 40,
            has_output: true,
            modes: Default::default(),
            history: b"hello".to_vec(),
            screen: b"prompt> ".to_vec(),
        };

        let payload = server_terminal_restore_event(
            "session-123",
            &snapshot,
            TerminalSnapshotReason::Lagged,
            4096,
        );
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("restore payload should be valid json");

        assert_eq!(parsed["type"], "restore");
        assert_eq!(parsed["sessionId"], "session-123");
        assert_eq!(parsed["sequence"], 17);
        assert_eq!(parsed["reason"], "lagged");
        assert_eq!(parsed["modes"]["alternateScreen"], false);
        assert_eq!(
            parsed["payload"],
            BASE64_STANDARD.encode(snapshot.render_restore_bytes(4096))
        );
    }

    #[test]
    fn server_terminal_stream_event_encodes_chunk_payload() {
        let payload = server_terminal_stream_event(
            "session-123",
            &TerminalStreamChunk {
                sequence: 23,
                bytes: b"hello".to_vec(),
            },
        );
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("stream payload should be valid json");

        assert_eq!(parsed["type"], "stream");
        assert_eq!(parsed["sessionId"], "session-123");
        assert_eq!(parsed["sequence"], 23);
        assert_eq!(parsed["payload"], BASE64_STANDARD.encode("hello"));
    }

    #[test]
    fn encode_terminal_restore_frame_prefixes_snapshot_metadata() {
        let snapshot = TerminalRestoreSnapshot {
            version: 1,
            sequence: 42,
            cols: 100,
            rows: 28,
            has_output: true,
            modes: Default::default(),
            history: b"hello\r\n".to_vec(),
            screen: b"prompt> ".to_vec(),
        };

        let frame = encode_terminal_restore_frame(&snapshot, TerminalSnapshotReason::Lagged, 4096);

        assert_eq!(&frame[..4], &TERMINAL_FRAME_MAGIC);
        assert_eq!(frame[4], TERMINAL_FRAME_PROTOCOL_VERSION);
        assert_eq!(frame[5], TERMINAL_FRAME_KIND_RESTORE);
        assert_eq!(u64::from_be_bytes(frame[6..14].try_into().unwrap()), 42);
        assert_eq!(frame[14], 1);
        assert_eq!(frame[15], TerminalSnapshotReason::Lagged.as_code());
        assert_eq!(u16::from_be_bytes(frame[16..18].try_into().unwrap()), 100);
        assert_eq!(u16::from_be_bytes(frame[18..20].try_into().unwrap()), 28);
        assert_eq!(frame[20], 0);
        assert_eq!(frame[21], 0);
        assert_eq!(frame[22], 0);
        assert_eq!(frame[23], 0);
        assert_eq!(&frame[24..], &snapshot.render_restore_bytes(4096));
    }

    #[test]
    fn encode_terminal_stream_frame_prefixes_sequence() {
        let chunk = TerminalStreamChunk {
            sequence: 7,
            bytes: b"hello".to_vec(),
        };

        let frame = encode_terminal_stream_frame(&chunk);

        assert_eq!(&frame[..4], &TERMINAL_FRAME_MAGIC);
        assert_eq!(frame[4], TERMINAL_FRAME_PROTOCOL_VERSION);
        assert_eq!(frame[5], TERMINAL_FRAME_KIND_STREAM);
        assert_eq!(u64::from_be_bytes(frame[6..14].try_into().unwrap()), 7);
        assert_eq!(&frame[14..], b"hello");
    }

    #[test]
    fn should_send_initial_restore_when_client_sequence_is_missing_or_stale() {
        let snapshot = TerminalRestoreSnapshot {
            version: 1,
            sequence: 9,
            cols: 100,
            rows: 28,
            has_output: true,
            modes: Default::default(),
            history: b"hello\r\n".to_vec(),
            screen: b"prompt> ".to_vec(),
        };

        assert!(should_send_initial_restore(&snapshot, None));
        assert!(should_send_initial_restore(&snapshot, Some(8)));
        assert!(!should_send_initial_restore(&snapshot, Some(9)));
        assert!(should_send_initial_restore(&snapshot, Some(10)));
    }

    #[test]
    fn should_skip_stream_chunk_when_restore_or_attach_already_covers_it() {
        assert!(!should_skip_stream_chunk(None, 1));
        assert!(should_skip_stream_chunk(Some(9), 9));
        assert!(should_skip_stream_chunk(Some(9), 8));
        assert!(!should_skip_stream_chunk(Some(9), 10));
    }

    #[test]
    fn terminal_snapshot_live_requested_accepts_booleanish_query_values() {
        assert!(terminal_snapshot_live_requested(Some("1")));
        assert!(terminal_snapshot_live_requested(Some("true")));
        assert!(terminal_snapshot_live_requested(Some("YES")));
        assert!(!terminal_snapshot_live_requested(Some("0")));
        assert!(!terminal_snapshot_live_requested(Some("false")));
        assert!(!terminal_snapshot_live_requested(None));
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

        let token = create_scoped_terminal_token("session-123", TerminalTokenScope::Control)
            .expect("token should be created");
        assert!(verify_terminal_token("session-123", &token).expect("token should verify"));
    }

    #[tokio::test]
    async fn build_terminal_snapshot_prefers_live_terminal_store_and_marks_session_live() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-live").await;

        let payload = build_terminal_snapshot(&state, &session, 200, 4096, true)
            .await
            .expect("snapshot should build");

        assert_eq!(payload["source"], "terminal_state");
        assert_eq!(payload["live"], true);
        assert_eq!(payload["restored"], true);
        let snapshot = payload["snapshot"]
            .as_str()
            .expect("snapshot should be a string");
        assert!(snapshot.contains("\u{1b}[?1049"));
        assert!(snapshot.contains("prompt> "));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn build_terminal_snapshot_falls_back_to_detached_log_transcript_when_restore_state_is_blank(
    ) {
        let (state, root) = build_test_state().await;
        let log_path = root.join("direct-session.log");
        fs::write(
            &log_path,
            b"\x1b[90mstatus\x1b[0m\r\nplain transcript line\r\nprompt> ",
        )
        .await
        .expect("detached log should write");

        let mut session = SessionRecord::builder(
            "session-log-fallback".to_string(),
            "demo".to_string(),
            "codex".to_string(),
            "Validate transcript fallback".to_string(),
        )
        .build();
        session.metadata.insert(
            DETACHED_LOG_PATH_METADATA_KEY.to_string(),
            log_path.to_string_lossy().to_string(),
        );
        state
            .sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        state
            .persist_terminal_restore_snapshot(
                &session.id,
                &TerminalRestoreSnapshot {
                    version: 1,
                    sequence: 9,
                    cols: 120,
                    rows: 32,
                    has_output: true,
                    modes: Default::default(),
                    history: Vec::new(),
                    screen: b"\x1b[2J\x1b[H".to_vec(),
                },
            )
            .await
            .expect("restore snapshot should persist");

        let payload = build_terminal_snapshot(&state, &session, 200, 4096, true)
            .await
            .expect("snapshot should build");

        assert_eq!(payload["source"], "terminal_state");
        assert_eq!(
            payload["transcript"].as_str(),
            Some("status\nplain transcript line\nprompt>")
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn build_terminal_restore_snapshot_keeps_history_and_utf8_boundaries_under_budget() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-restore").await;
        state
            .emit_terminal_text(&session.id, "emoji: 🙂🙂🙂🙂🙂")
            .await;

        let restored = build_terminal_restore_snapshot(&state, &session)
            .await
            .expect("restore snapshot should build")
            .expect("restore snapshot should exist");

        let rendered = restored.render_bytes(96);
        assert!(rendered.len() <= 96);
        let rendered_text = String::from_utf8_lossy(&rendered);
        assert!(rendered_text.contains("emoji:"));

        let current = state
            .current_terminal_restore_snapshot(&session.id)
            .await
            .expect("live restore snapshot should exist");

        assert_eq!(restored.sequence, current.sequence);
        assert_eq!(restored.cols, current.cols);
        assert_eq!(restored.rows, current.rows);
        assert_eq!(restored.has_output, current.has_output);
        assert_eq!(restored.history, current.history);
        assert_eq!(restored.screen, current.screen);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn terminal_snapshot_route_exposes_benchmark_headers() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-http").await;

        let response = router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/sessions/{}/terminal/snapshot?lines=200&live=1",
                        session.id
                    ))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(TERMINAL_SNAPSHOT_SOURCE_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("terminal_state")
        );
        assert_eq!(
            response
                .headers()
                .get(TERMINAL_SNAPSHOT_LIVE_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        assert_eq!(
            response
                .headers()
                .get(TERMINAL_SNAPSHOT_RESTORED_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        assert!(response
            .headers()
            .get(HeaderName::from_static(SERVER_TIMING_HEADER))
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .contains("terminal_snapshot;dur="));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn terminal_stream_route_rejects_unauthorized_remote_requests() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-stream-auth").await;
        state.config.write().await.access.require_auth = true;

        let response = router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri(format!("/api/sessions/{}/terminal/stream", session.id))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn terminal_stream_route_accepts_forwarded_proxy_identity() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-stream-proxy").await;
        state.config.write().await.access.require_auth = true;

        let response = router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri(format!("/api/sessions/{}/terminal/stream", session.id))
                    .header("x-conductor-proxy-authorized", "true")
                    .header("x-conductor-access-authenticated", "true")
                    .header("x-conductor-access-role", "viewer")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let _ = std::fs::remove_dir_all(root);
    }
}
