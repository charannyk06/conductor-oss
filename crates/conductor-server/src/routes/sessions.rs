use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{self as stream, StreamExt};

use crate::routes::boards::{resolve_board_task_identity, update_board_task_attempt_ref};
use crate::routes::terminal::resolve_terminal_keys;
use crate::state::{
    build_normalized_chat_feed, trim_lines_tail, AppState, SessionRecord, SessionStatus,
    SpawnRequest,
};
use uuid::Uuid;

type ApiResponse = (StatusCode, Json<Value>);

/// Simple token-bucket rate limiter for the spawn endpoint.
/// Allows `SPAWN_RATE_LIMIT` requests per `SPAWN_RATE_WINDOW_SECS` window.
const SPAWN_RATE_LIMIT: u64 = 10;
const SPAWN_RATE_WINDOW_SECS: u64 = 60;
const DEFAULT_FEED_WINDOW_LIMIT: usize = 120;
const MAX_FEED_WINDOW_LIMIT: usize = 240;

static SPAWN_RATE_COUNT: AtomicU64 = AtomicU64::new(0);
static SPAWN_RATE_WINDOW_START: AtomicU64 = AtomicU64::new(0);

fn spawn_rate_check() -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let window_start = SPAWN_RATE_WINDOW_START.load(Ordering::Relaxed);
    if now.saturating_sub(window_start) >= SPAWN_RATE_WINDOW_SECS {
        SPAWN_RATE_WINDOW_START.store(now, Ordering::Relaxed);
        SPAWN_RATE_COUNT.store(1, Ordering::Relaxed);
        return true;
    }
    let count = SPAWN_RATE_COUNT.fetch_add(1, Ordering::Relaxed);
    count < SPAWN_RATE_LIMIT
}

async fn spawn_rate_limit_middleware(
    request: axum::extract::Request,
    next: middleware::Next,
) -> impl IntoResponse {
    if !spawn_rate_check() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "Rate limit exceeded. Try again later." })),
        )
            .into_response();
    }
    next.run(request).await.into_response()
}

pub fn router() -> Router<Arc<AppState>> {
    let spawn_route = Router::new()
        .route("/api/spawn", post(spawn_session))
        .layer(middleware::from_fn(spawn_rate_limit_middleware));

    Router::new()
        .merge(spawn_route)
        .route("/api/sessions", get(list_sessions).post(spawn_session))
        .route("/api/bridges", get(list_bridges).post(register_bridge))
        .route("/api/bridges/{bridge_id}/heartbeat", post(heartbeat_bridge))
        .route(
            "/api/bridges/{bridge_id}/disconnect",
            post(disconnect_bridge),
        )
        .route("/api/sessions/spawn", post(spawn_session))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/conversation", get(get_conversation))
        .route("/api/sessions/{id}/feed", get(get_feed))
        .route("/api/sessions/{id}/feed/stream", get(feed_stream))
        .route("/api/sessions/{id}/output", get(get_output))
        .route("/api/sessions/{id}/output/stream", get(output_stream))
        .route("/api/sessions/{id}/input", post(send_to_session))
        .route("/api/sessions/{id}/send", post(send_to_session))
        .route("/api/sessions/{id}/interrupt", post(interrupt_session))
        .route("/api/sessions/{id}/kill", post(kill_session))
        .route("/api/sessions/{id}/archive", post(archive_session))
        .route("/api/sessions/{id}/retry", post(retry_session))
        .route("/api/sessions/{id}/restore", post(restore_session))
        .route("/api/sessions/{id}/feedback", post(submit_feedback))
        .route("/api/sessions/{id}/actions", post(apply_action))
        .route("/api/sessions/cleanup", post(cleanup_sessions))
        .route("/api/sessions/{id}/keys", post(send_keys))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn created(value: Value) -> ApiResponse {
    (StatusCode::CREATED, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

fn task_id_for_session(session: &SessionRecord) -> String {
    session
        .metadata
        .get("taskId")
        .cloned()
        .unwrap_or_else(|| format!("t-{}", session.id))
}

fn session_snapshot_signature(payload: &Value, session_id: &str) -> Option<String> {
    if payload
        .get("removedSessionIds")
        .and_then(Value::as_array)
        .is_some_and(|removed| {
            removed
                .iter()
                .any(|candidate| candidate.as_str() == Some(session_id))
        })
    {
        return Some("missing".to_string());
    }

    let sessions = payload.get("sessions")?.as_array()?;
    let matching = sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id));

    match matching {
        Some(session) => Some(format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            session
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("activity")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("lastActivityAt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("parserState")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("runtimeStatus")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            session
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )),
        None => Some("missing".to_string()),
    }
}

fn build_feed_delta_event(previous: &Value, next: &Value) -> Value {
    let previous_entries = previous
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_entries = next
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let can_append = previous_entries.len() <= next_entries.len()
        && previous_entries
            .iter()
            .zip(next_entries.iter())
            .all(|(left, right)| left == right);

    if can_append {
        return json!({
            "type": "append",
            "entries": next_entries.into_iter().skip(previous_entries.len()).collect::<Vec<_>>(),
            "totalEntries": next.get("totalEntries").cloned().unwrap_or(Value::Null),
            "windowLimit": next.get("windowLimit").cloned().unwrap_or(Value::Null),
            "truncated": next.get("truncated").cloned().unwrap_or(Value::Null),
            "sessionStatus": next.get("sessionStatus").cloned().unwrap_or(Value::Null),
            "parserState": next.get("parserState").cloned().unwrap_or(Value::Null),
            "runtimeStatus": next.get("runtimeStatus").cloned().unwrap_or(Value::Null),
            "source": next.get("source").cloned().unwrap_or(Value::Null),
            "error": next.get("error").cloned().unwrap_or(Value::Null),
        });
    }

    json!({
        "type": "replace",
        "payload": next,
    })
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    project: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeedQuery {
    limit: Option<usize>,
}

fn resolve_feed_window_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_FEED_WINDOW_LIMIT)
        .clamp(1, MAX_FEED_WINDOW_LIMIT)
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> ApiResponse {
    let mut sessions = state.snapshot_sessions().await;
    if let Some(project_id) = query
        .project
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sessions.retain(|session| session["projectId"] == project_id);
    }

    let stats = json!({
        "totalSessions": sessions.len(),
        "workingSessions": sessions.iter().filter(|session| session["activity"] == "active").count(),
        "openPRs": sessions.iter().filter(|session| !session["pr"].is_null()).count(),
        "needsAttention": sessions
            .iter()
            .filter(|session| {
                matches!(session["status"].as_str(), Some("needs_input" | "stuck" | "errored" | "bridge_offline"))
                    || matches!(session["activity"].as_str(), Some("waiting_input" | "blocked"))
            })
            .count(),
    });

    ok(json!({ "sessions": sessions, "stats": stats }))
}

async fn get_session(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> ApiResponse {
    match state.dashboard_session(&id).await {
        Some(session) => ok(session),
        None => error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnBody {
    project_id: String,
    bridge_id: Option<String>,
    prompt: Option<String>,
    #[serde(alias = "issue_id")]
    issue_id: Option<String>,
    agent: Option<String>,
    use_worktree: Option<bool>,
    permission_mode: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    branch: Option<String>,
    base_branch: Option<String>,
    attachments: Option<Vec<String>>,
}

async fn spawn_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SpawnBody>,
) -> ApiResponse {
    let prompt = body.prompt.unwrap_or_default();
    let linked_board_task = if let Some(task_link_key) = body
        .issue_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        resolve_board_task_identity(&state, &body.project_id, task_link_key).await
    } else {
        None
    };

    match state
        .spawn_session(SpawnRequest {
            project_id: body.project_id,
            bridge_id: body.bridge_id,
            prompt,
            issue_id: body.issue_id,
            agent: body.agent,
            use_worktree: body.use_worktree,
            permission_mode: body.permission_mode,
            model: body.model,
            reasoning_effort: body.reasoning_effort,
            branch: body.branch,
            base_branch: body.base_branch,
            task_id: linked_board_task
                .as_ref()
                .map(|(task_id, _)| task_id.clone()),
            task_ref: linked_board_task
                .as_ref()
                .and_then(|(_, task_ref)| task_ref.clone()),
            attempt_id: None,
            parent_task_id: None,
            retry_of_session_id: None,
            profile: None,
            brief_path: None,
            attachments: body.attachments.unwrap_or_default(),
            source: "spawn".to_string(),
        })
        .await
    {
        Ok(session) => {
            if let Some((task_id, _)) = linked_board_task {
                let _ = update_board_task_attempt_ref(
                    &state,
                    &body.project_id,
                    &task_id,
                    &session.id,
                    None,
                )
                .await;
            }

            let session_value = state.serialize_dashboard_session(&session).await;
            created(json!({ "session": session_value }))
        }
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRegistrationBody {
    bridge_id: String,
    hostname: String,
    os: String,
    capabilities: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeHeartbeatBody {
    hostname: Option<String>,
    os: Option<String>,
    capabilities: Option<Vec<String>>,
}

async fn list_bridges(State(state): State<Arc<AppState>>) -> ApiResponse {
    let bridges = state.list_bridges().await;
    ok(json!({ "bridges": bridges }))
}

async fn register_bridge(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BridgeRegistrationBody>,
) -> ApiResponse {
    let bridge = state
        .register_bridge(
            body.bridge_id,
            body.hostname,
            body.os,
            body.capabilities.unwrap_or_default(),
        )
        .await;
    created(json!({ "bridge": bridge }))
}

async fn heartbeat_bridge(
    State(state): State<Arc<AppState>>,
    Path(bridge_id): Path<String>,
    Json(body): Json<BridgeHeartbeatBody>,
) -> ApiResponse {
    match state
        .heartbeat_bridge(&bridge_id, body.hostname, body.os, body.capabilities)
        .await
    {
        Some(bridge) => ok(json!({ "bridge": bridge })),
        None => error(
            StatusCode::NOT_FOUND,
            format!("Bridge {bridge_id} not found"),
        ),
    }
}

async fn disconnect_bridge(
    State(state): State<Arc<AppState>>,
    Path(bridge_id): Path<String>,
) -> ApiResponse {
    match state.disconnect_bridge(&bridge_id).await {
        Some(bridge) => ok(json!({ "bridge": bridge })),
        None => error(
            StatusCode::NOT_FOUND,
            format!("Bridge {bridge_id} not found"),
        ),
    }
}

async fn get_conversation(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.get_session(&id).await {
        Some(session) => ok(json!({ "entries": session.conversation })),
        None => error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
    }
}

async fn get_feed(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<FeedQuery>,
) -> ApiResponse {
    let window_limit = resolve_feed_window_limit(query.limit);
    match state.get_session(&id).await {
        Some(session) => ok(session_feed_payload(&state, &session, window_limit).await),
        None => error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
    }
}

async fn feed_stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<FeedQuery>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let window_limit = resolve_feed_window_limit(query.limit);
    let initial_signature = state
        .get_session(&id)
        .await
        .map(|session| {
            [
                session.id,
                session.status.as_str().to_string(),
                session.activity.unwrap_or_default(),
                session.last_activity_at,
                session.summary.unwrap_or_default(),
            ]
            .join(":")
        })
        .unwrap_or_else(|| "missing".to_string());
    let initial_payload = match state.get_session(&id).await {
        Some(session) => session_feed_payload(&state, &session, window_limit).await,
        None => {
            json!({
                "entries": [],
                "totalEntries": 0,
                "windowLimit": window_limit,
                "truncated": false,
                "sessionStatus": Value::Null,
                "parserState": Value::Null,
                "runtimeStatus": Value::Null,
                "error": format!("Session {id} not found"),
            })
        }
    };
    let initial_stream = stream::iter(vec![Ok(
        SseEvent::default().data(initial_payload.to_string())
    )]);

    let feed_state = Arc::new(Mutex::new((initial_signature, initial_payload.clone())));
    let event_state = state.clone();
    let event_session_id = id.clone();
    let updates = BroadcastStream::new(state.event_snapshots.subscribe())
        .then(move |result| {
            let state = event_state.clone();
            let session_id = event_session_id.clone();
            let feed_state = feed_state.clone();
            async move {
                match result {
                    Ok(snapshot_json) => {
                        let Ok(payload) = serde_json::from_str::<Value>(&snapshot_json) else {
                            return Some(Ok(SseEvent::default().event("refresh").data(
                                json!({ "type": "refresh", "sessionId": session_id }).to_string(),
                            )));
                        };
                        let next_signature = session_snapshot_signature(&payload, &session_id)?;
                        let mut feed_state = feed_state.lock().await;
                        if next_signature == feed_state.0 {
                            return None;
                        }
                        feed_state.0 = next_signature;
                        let next_payload = match state.get_session(&session_id).await {
                            Some(session) => {
                                session_feed_payload(&state, &session, window_limit).await
                            }
                            None => json!({
                                "entries": [],
                                "totalEntries": 0,
                                "windowLimit": window_limit,
                                "truncated": false,
                                "sessionStatus": Value::Null,
                                "parserState": Value::Null,
                                "runtimeStatus": Value::Null,
                                "error": format!("Session {session_id} not found"),
                            }),
                        };
                        let delta = build_feed_delta_event(&feed_state.1, &next_payload);
                        feed_state.1 = next_payload;
                        Some(Ok(SseEvent::default().data(delta.to_string())))
                    }
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(
                        count,
                    )) => {
                        tracing::warn!("Feed SSE stream lagged by {count} messages");
                        Some(Ok(SseEvent::default().event("refresh").data(
                            json!({ "type": "refresh", "reason": "lagged", "missed": count })
                                .to_string(),
                        )))
                    }
                }
            }
        })
        .filter_map(|item| item);

    Sse::new(initial_stream.chain(updates)).keep_alive(KeepAlive::default())
}

async fn session_feed_payload(
    state: &AppState,
    session: &SessionRecord,
    window_limit: usize,
) -> Value {
    if let Some(payload) = state.cached_feed_payload(&session.id, window_limit).await {
        return payload;
    }

    let parser_state = session
        .metadata
        .get("parserState")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|kind| {
            json!({
                "kind": kind,
                "message": session.metadata.get("parserStateMessage").cloned().unwrap_or_default(),
                "command": session.metadata.get("parserStateCommand").cloned(),
            })
        });
    let runtime_status = state.session_runtime_status(session).await;

    let all_entries = build_normalized_chat_feed(session);
    let total_entries = all_entries.len();
    let entries = if total_entries > window_limit {
        all_entries
            .into_iter()
            .skip(total_entries - window_limit)
            .collect::<Vec<_>>()
    } else {
        all_entries
    };

    let payload = json!({
        "entries": entries,
        "totalEntries": total_entries,
        "windowLimit": window_limit,
        "truncated": total_entries > window_limit,
        "sessionStatus": session.status,
        "parserState": parser_state,
        "runtimeStatus": runtime_status,
        "source": if session.output.is_empty() { "conversation-only" } else { "runtime-output" },
    });

    state
        .store_feed_payload(&session.id, window_limit, payload.clone())
        .await;
    payload
}

#[derive(Debug, Deserialize)]
struct OutputQuery {
    lines: Option<usize>,
}

async fn get_output(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> ApiResponse {
    match state.get_session(&id).await {
        Some(session) => ok(json!({
            "output": trim_lines_tail(&session.output, query.lines.unwrap_or(500)),
        })),
        None => error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
    }
}

async fn output_stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let initial_output = state
        .get_session(&id)
        .await
        .map(|session| trim_lines_tail(&session.output, query.lines.unwrap_or(500)))
        .unwrap_or_default();
    let initial_stream = stream::iter(vec![Ok(
        SseEvent::default().data(json!({ "type": "output", "output": initial_output }).to_string())
    )]);
    // Delta updates: each broadcast carries only the new line, not the full output.
    let updates = BroadcastStream::new(state.output_updates.subscribe()).filter_map(
        move |result| match result {
            Ok((session_id, delta)) if session_id == id => Some(Ok(
                SseEvent::default().data(json!({ "type": "delta", "line": delta }).to_string())
            )),
            Ok(_) => None,
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(count)) => {
                tracing::warn!("Output stream SSE lagged by {count} messages");
                Some(Ok(SseEvent::default().event("refresh").data(
                    json!({ "type": "refresh", "reason": "lagged", "missed": count }).to_string(),
                )))
            }
        },
    );
    Sse::new(initial_stream.chain(updates)).keep_alive(KeepAlive::default())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendBody {
    message: String,
    attachments: Option<Vec<String>>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

async fn send_to_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<SendBody>,
) -> ApiResponse {
    let attachments = body.attachments.unwrap_or_default();

    if body.message.trim().is_empty() && attachments.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "Message or attachments are required",
        );
    }

    let is_live = match state.ensure_session_live(&id).await {
        Ok(value) => value,
        Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
    };

    if !is_live {
        let should_resume = state
            .get_session(&id)
            .await
            .map(|session| matches!(session.status.as_str(), "needs_input" | "stuck" | "done"))
            .unwrap_or(false);

        if should_resume {
            match state
                .resume_session_with_prompt(
                    &id,
                    body.message,
                    attachments,
                    body.model,
                    body.reasoning_effort,
                    "follow_up",
                )
                .await
            {
                Ok(()) => {
                    return ok(json!({
                        "ok": true,
                        "sessionId": id,
                        "restoredFrom": Value::Null,
                    }));
                }
                Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
            }
        }
    }

    match state
        .send_to_session(
            &id,
            body.message,
            attachments,
            body.model,
            body.reasoning_effort,
            "follow_up",
        )
        .await
    {
        Ok(()) => ok(json!({
            "ok": true,
            "sessionId": id,
            "restoredFrom": Value::Null,
        })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn kill_session(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> ApiResponse {
    match state.kill_session(&id).await {
        Ok(()) => {
            state.kick_spawn_supervisor().await;
            ok(json!({ "ok": true, "sessionId": id }))
        }
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn interrupt_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.interrupt_session(&id).await {
        Ok(()) => ok(json!({ "ok": true, "sessionId": id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn archive_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.archive_session(&id).await {
        Ok(()) => {
            state.kick_spawn_supervisor().await;
            ok(json!({ "ok": true, "sessionId": id }))
        }
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn restore_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.restore_session(&id).await {
        Ok(session) => {
            let session_value = state.serialize_dashboard_session(&session).await;
            ok(json!({ "session": session_value }))
        }
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetryBody {
    agent: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    base_branch: Option<String>,
    profile: Option<String>,
}

async fn retry_session(
    State(state): State<Arc<AppState>>,
    Path(target): Path<String>,
    Json(body): Json<RetryBody>,
) -> ApiResponse {
    let sessions = state.all_sessions().await;
    let source = state.get_session(&target).await.or_else(|| {
        sessions
            .into_iter()
            .filter(|session| task_id_for_session(session) == target)
            .max_by(|left, right| left.created_at.cmp(&right.created_at))
    });

    let Some(source) = source else {
        return error(
            StatusCode::NOT_FOUND,
            format!("No session/task found for retry target: {target}"),
        );
    };

    let next_attempt_id = format!("a-{}", Uuid::new_v4().simple());
    let mut source_update = source.clone();
    source_update
        .metadata
        .insert("attemptStatus".to_string(), "archived".to_string());
    source_update
        .metadata
        .insert("supersededByAttemptId".to_string(), next_attempt_id.clone());

    if let Err(err) = state.replace_session(source_update).await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    match state
        .spawn_session(SpawnRequest {
            project_id: source.project_id.clone(),
            bridge_id: source.bridge_id.clone(),
            prompt: source.prompt.clone(),
            issue_id: source.issue_id.clone(),
            agent: body.agent.or_else(|| Some(source.agent.clone())),
            use_worktree: Some(true),
            permission_mode: None,
            model: body.model.or_else(|| source.model.clone()),
            reasoning_effort: body
                .reasoning_effort
                .or_else(|| source.reasoning_effort.clone()),
            branch: None,
            base_branch: body.base_branch.or_else(|| source.branch.clone()),
            task_id: Some(task_id_for_session(&source)),
            task_ref: source.metadata.get("taskRef").cloned(),
            attempt_id: Some(next_attempt_id),
            parent_task_id: source.metadata.get("parentTaskId").cloned(),
            retry_of_session_id: Some(source.id.clone()),
            profile: body
                .profile
                .or_else(|| source.metadata.get("profile").cloned()),
            brief_path: source.metadata.get("briefPath").cloned(),
            attachments: Vec::new(),
            source: "retry".to_string(),
        })
        .await
    {
        Ok(session) => {
            if let Some(task_id) = source.metadata.get("taskId") {
                let _ = update_board_task_attempt_ref(
                    &state,
                    &source.project_id,
                    task_id,
                    &session.id,
                    None,
                )
                .await;
            }
            let session_value = state.serialize_dashboard_session(&session).await;
            ok(json!({ "session": session_value }))
        }
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupBody {
    project_id: Option<String>,
    dry_run: Option<bool>,
}

async fn cleanup_sessions(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CleanupBody>,
) -> ApiResponse {
    let mut result = json!({
        "killed": Vec::<String>::new(),
        "skipped": Vec::<String>::new(),
        "errors": Vec::<Value>::new(),
    });
    let dry_run = body.dry_run.unwrap_or(false);

    for session in state.all_sessions().await {
        if session.status == SessionStatus::Archived {
            continue;
        }

        if let Some(project_id) = body.project_id.as_deref() {
            if session.project_id != project_id {
                continue;
            }
        }

        if session.metadata.get("role").map(String::as_str) == Some("orchestrator")
            || session.id.ends_with("-orchestrator")
        {
            result["skipped"]
                .as_array_mut()
                .expect("skipped is array")
                .push(Value::String(session.id.clone()));
            continue;
        }

        if !session_cleanup_eligible(&session) {
            result["skipped"]
                .as_array_mut()
                .expect("skipped is array")
                .push(Value::String(session.id.clone()));
            continue;
        }

        if dry_run {
            result["killed"]
                .as_array_mut()
                .expect("killed is array")
                .push(Value::String(session.id.clone()));
            continue;
        }

        match state.archive_session(&session.id).await {
            Ok(()) => {
                result["killed"]
                    .as_array_mut()
                    .expect("killed is array")
                    .push(Value::String(session.id.clone()));
            }
            Err(err) => {
                result["errors"]
                    .as_array_mut()
                    .expect("errors is array")
                    .push(json!({
                        "sessionId": session.id,
                        "error": err.to_string(),
                    }));
            }
        }
    }

    ok(result)
}

fn session_cleanup_eligible(session: &SessionRecord) -> bool {
    session.status.is_terminal()
        || matches!(
            session.status,
            SessionStatus::NeedsInput | SessionStatus::Stuck
        )
        || matches!(
            session.activity.as_deref(),
            Some("waiting_input" | "blocked")
        )
}

#[derive(Debug, Deserialize)]
struct FeedbackBody {
    message: String,
}

async fn submit_feedback(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<FeedbackBody>,
) -> ApiResponse {
    match state
        .send_to_session(&id, body.message, Vec::new(), None, None, "feedback")
        .await
    {
        Ok(()) => ok(json!({ "ok": true })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct ActionBody {
    action: String,
    message: Option<String>,
}

async fn apply_action(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ActionBody>,
) -> ApiResponse {
    match body.action.as_str() {
        "interrupt" => match state.interrupt_session(&id).await {
            Ok(()) => ok(json!({ "ok": true, "action": "interrupt", "sessionId": id })),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        "retry" | "restore" => match state.restore_session(&id).await {
            Ok(session) => ok(
                json!({ "ok": true, "action": "restore", "session": state.serialize_dashboard_session(&session).await }),
            ),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        "kill" | "terminate" => match state.kill_session(&id).await {
            Ok(()) => ok(json!({ "ok": true, "action": "kill", "sessionId": id })),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        "archive" => match state.archive_session(&id).await {
            Ok(()) => ok(json!({ "ok": true, "action": "archive", "sessionId": id })),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        "send" => match state
            .send_to_session(
                &id,
                body.message.unwrap_or_default(),
                Vec::new(),
                None,
                None,
                "follow_up",
            )
            .await
        {
            Ok(()) => ok(json!({ "ok": true, "action": "send", "sessionId": id })),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        other => error(StatusCode::BAD_REQUEST, format!("Unknown action: {other}")),
    }
}

#[derive(Debug, Deserialize)]
struct KeysBody {
    keys: Option<String>,
    special: Option<String>,
}

async fn send_keys(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<KeysBody>,
) -> ApiResponse {
    let message = match resolve_terminal_keys(body.keys, body.special) {
        Ok(message) => message,
        Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
    };

    match state.send_raw_to_session(&id, message).await {
        Ok(()) => ok(json!({ "ok": true, "sessionId": id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_feed_delta_event, resolve_feed_window_limit, session_cleanup_eligible};
    use crate::state::{SessionRecord, SessionStatus};
    use serde_json::json;

    fn build_session(id: &str, status: SessionStatus, activity: Option<&str>) -> SessionRecord {
        let mut session = SessionRecord::new(
            id.to_string(),
            "demo".to_string(),
            Some(format!("session/{id}")),
            None,
            Some("/tmp/demo".to_string()),
            "codex".to_string(),
            None,
            None,
            "Inspect".to_string(),
            None,
        );
        session.status = status;
        session.activity = activity.map(str::to_string);
        session
    }

    #[test]
    fn cleanup_eligible_for_terminal_sessions() {
        let session = build_session("terminal", SessionStatus::Done, Some("exited"));
        assert!(session_cleanup_eligible(&session));
    }

    #[test]
    fn cleanup_eligible_for_needs_input_sessions() {
        let session = build_session(
            "needs-input",
            SessionStatus::NeedsInput,
            Some("waiting_input"),
        );
        assert!(session_cleanup_eligible(&session));
    }

    #[test]
    fn cleanup_eligible_for_stuck_sessions() {
        let session = build_session("stuck", SessionStatus::Stuck, Some("blocked"));
        assert!(session_cleanup_eligible(&session));
    }

    #[test]
    fn cleanup_skips_active_working_sessions() {
        let session = build_session("working", SessionStatus::Working, Some("active"));
        assert!(!session_cleanup_eligible(&session));
    }

    #[test]
    fn feed_window_limit_is_clamped() {
        assert_eq!(resolve_feed_window_limit(None), 120);
        assert_eq!(resolve_feed_window_limit(Some(0)), 1);
        assert_eq!(resolve_feed_window_limit(Some(999)), 240);
    }

    #[test]
    fn feed_delta_append_keeps_window_metadata() {
        let previous = json!({
            "entries": [{ "id": "1" }],
            "totalEntries": 1,
            "windowLimit": 120,
            "truncated": false,
            "sessionStatus": "working",
        });
        let next = json!({
            "entries": [{ "id": "1" }, { "id": "2" }],
            "totalEntries": 2,
            "windowLimit": 120,
            "truncated": false,
            "sessionStatus": "working",
        });

        let delta = build_feed_delta_event(&previous, &next);

        assert_eq!(
            delta.get("type").and_then(|value| value.as_str()),
            Some("append")
        );
        assert_eq!(
            delta.get("totalEntries").and_then(|value| value.as_u64()),
            Some(2)
        );
        assert_eq!(
            delta.get("windowLimit").and_then(|value| value.as_u64()),
            Some(120)
        );
        assert_eq!(
            delta.get("truncated").and_then(|value| value.as_bool()),
            Some(false)
        );
    }
}
