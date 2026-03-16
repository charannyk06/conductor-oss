use crate::routes::terminal::snapshot::build_terminal_snapshot;
use crate::state::{AppState, TerminalRuntimeState, TerminalSupervisor};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Deserialize)]
pub struct TerminalBootstrapQuery {
    pub lines: Option<usize>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalBootstrapPayload {
    connection: crate::state::TerminalConnectionPayload,
    snapshot: serde_json::Value,
    runtime: TerminalRuntimeState,
}

pub fn elapsed_duration_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1000.0
}

pub fn append_server_timing_metric(headers: &mut HeaderMap, metric_name: &str, duration_ms: f64) {
    let value = format!("{metric_name};dur={duration_ms:.1}");
    if let Ok(header_value) = HeaderValue::from_str(&value) {
        headers.append(
            HeaderName::from_static(crate::state::SERVER_TIMING_HEADER),
            header_value,
        );
    }
}

pub fn set_terminal_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), header_value);
    }
}

pub fn set_terminal_bool_header(headers: &mut HeaderMap, name: &'static str, value: bool) {
    set_terminal_header(headers, name, if value { "true" } else { "false" });
}

pub fn timed_error_response(
    status: StatusCode,
    message: impl Into<String>,
    metric_name: &str,
    started_at: Instant,
) -> Response {
    let mut response = (status, Json(json!({ "error": message.into() }))).into_response();
    append_server_timing_metric(
        response.headers_mut(),
        metric_name,
        elapsed_duration_ms(started_at),
    );
    response
}

pub fn apply_terminal_connection_headers(
    headers: &mut HeaderMap,
    payload: &crate::state::TerminalConnectionPayload,
    started_at: Instant,
    token_duration_ms: f64,
) {
    append_server_timing_metric(
        headers,
        "terminal_connection",
        elapsed_duration_ms(started_at),
    );
    append_server_timing_metric(headers, "terminal_token", token_duration_ms);
    set_terminal_header(
        headers,
        "x-conductor-terminal-transport",
        match payload.transport {
            crate::state::TerminalConnectionTransport::Websocket => "websocket",
            crate::state::TerminalConnectionTransport::Eventstream => "eventstream",
        },
    );
    set_terminal_bool_header(
        headers,
        "x-conductor-terminal-interactive",
        payload.interactive,
    );
    set_terminal_header(
        headers,
        "x-conductor-terminal-connection-path",
        match payload.connection_path {
            crate::state::TerminalConnectionPath::Direct => "direct",
            crate::state::TerminalConnectionPath::ManagedRemote => "managed_remote",
            crate::state::TerminalConnectionPath::DashboardProxy => "dashboard_proxy",
            crate::state::TerminalConnectionPath::AuthLimited => "auth_limited",
        },
    );
}

pub async fn terminal_connection(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
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
    let _ = supervisor.prepare_terminal_runtime(&id, None, None).await;

    let token_started_at = Instant::now();
    let connection = match supervisor
        .build_terminal_connection_payload(&id, &headers)
        .await
    {
        Ok(payload) => payload,
        Err(err) => {
            return timed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                err.to_string(),
                "terminal_connection",
                started_at,
            )
        }
    };
    let token_duration_ms = elapsed_duration_ms(token_started_at);

    let mut response =
        Json(serde_json::to_value(&connection).unwrap_or_else(|_| json!({}))).into_response();
    apply_terminal_connection_headers(
        response.headers_mut(),
        &connection,
        started_at,
        token_duration_ms,
    );
    response
}

/// Fast bootstrap endpoint that returns connection info + runtime state
/// WITHOUT building the snapshot. The snapshot is delivered as the first
/// WS binary frame during the WebSocket handshake, avoiding the 100-500ms
/// blocking wait.
pub async fn terminal_fast_bootstrap(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let started_at = Instant::now();
    let Some(session) = state.get_session(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    };

    let supervisor = TerminalSupervisor::new(state.clone());
    let _ = supervisor.prepare_terminal_runtime(&id, None, None).await;
    let token_started_at = Instant::now();
    let connection = match supervisor
        .build_terminal_connection_payload(&id, &headers)
        .await
    {
        Ok(payload) => payload,
        Err(err) => {
            return timed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                err.to_string(),
                "terminal_connection",
                started_at,
            )
        }
    };
    let token_duration_ms = elapsed_duration_ms(token_started_at);
    let runtime = state.describe_terminal_runtime(&session).await;

    let mut response = Json(json!({
        "connection": serde_json::to_value(&connection).unwrap_or_else(|_| json!({})),
        "runtime": serde_json::to_value(&runtime).unwrap_or_else(|_| json!({})),
    }))
    .into_response();
    apply_terminal_connection_headers(
        response.headers_mut(),
        &connection,
        started_at,
        token_duration_ms,
    );
    response
}

pub async fn terminal_bootstrap(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalBootstrapQuery>,
    headers: HeaderMap,
) -> Response {
    let started_at = Instant::now();
    let Some(session) = state.get_session(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    };

    let supervisor = TerminalSupervisor::new(state.clone());
    let _ = supervisor.prepare_terminal_runtime(&id, None, None).await;

    let token_started_at = Instant::now();
    let connection = match supervisor
        .build_terminal_connection_payload(&id, &headers)
        .await
    {
        Ok(payload) => payload,
        Err(err) => {
            return timed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                err.to_string(),
                "terminal_connection",
                started_at,
            )
        }
    };
    let token_duration_ms = elapsed_duration_ms(token_started_at);

    let lines = query
        .lines
        .unwrap_or(crate::state::DEFAULT_TERMINAL_SNAPSHOT_LINES)
        .clamp(25, crate::state::MAX_TERMINAL_SNAPSHOT_LINES);
    let snapshot = match build_terminal_snapshot(
        &state,
        &session,
        lines,
        crate::state::LIVE_TERMINAL_SNAPSHOT_MAX_BYTES,
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(err) => {
            return timed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                err.to_string(),
                "terminal_snapshot",
                started_at,
            )
        }
    };
    let runtime = state.describe_terminal_runtime(&session).await;

    let mut response = Json(TerminalBootstrapPayload {
        connection: connection.clone(),
        snapshot,
        runtime,
    })
    .into_response();
    apply_terminal_connection_headers(
        response.headers_mut(),
        &connection,
        started_at,
        token_duration_ms,
    );
    append_server_timing_metric(
        response.headers_mut(),
        "terminal_snapshot",
        elapsed_duration_ms(started_at),
    );
    response
}
