use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{self as stream, StreamExt};

use crate::state::{
    build_normalized_chat_feed, session_to_dashboard_value, trim_lines_tail, AppState, SpawnRequest,
};

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/spawn", post(spawn_session))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/conversation", get(get_conversation))
        .route("/api/sessions/{id}/feed", get(get_feed))
        .route("/api/sessions/{id}/output", get(get_output))
        .route("/api/sessions/{id}/output/stream", get(output_stream))
        .route("/api/sessions/{id}/send", post(send_to_session))
        .route("/api/sessions/{id}/kill", post(kill_session))
        .route("/api/sessions/{id}/restore", post(restore_session))
        .route("/api/sessions/{id}/feedback", post(submit_feedback))
        .route("/api/sessions/{id}/actions", post(apply_action))
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

#[derive(Debug, Deserialize)]
struct ListQuery {
    project: Option<String>,
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> ApiResponse {
    let mut sessions = state.snapshot_sessions().await;
    if let Some(project_id) = query.project.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        sessions.retain(|session| session["projectId"] == project_id);
    }

    let stats = json!({
        "totalSessions": sessions.len(),
        "workingSessions": sessions.iter().filter(|session| session["activity"] == "active").count(),
        "openPRs": sessions.iter().filter(|session| !session["pr"].is_null()).count(),
        "needsAttention": sessions
            .iter()
            .filter(|session| {
                matches!(session["status"].as_str(), Some("needs_input" | "stuck" | "errored"))
                    || matches!(session["activity"].as_str(), Some("waiting_input" | "blocked"))
            })
            .count(),
    });

    ok(json!({ "sessions": sessions, "stats": stats }))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.get_session(&id).await {
        Some(session) => ok(session_to_dashboard_value(&session)),
        None => error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnBody {
    project_id: String,
    prompt: Option<String>,
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
    if prompt.trim().is_empty() && body.issue_id.as_deref().unwrap_or_default().trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "Either prompt or issueId is required to create a session");
    }

    match state
        .spawn_session(SpawnRequest {
            project_id: body.project_id,
            prompt,
            issue_id: body.issue_id,
            agent: body.agent,
            use_worktree: body.use_worktree,
            permission_mode: body.permission_mode,
            model: body.model,
            reasoning_effort: body.reasoning_effort,
            branch: body.branch,
            base_branch: body.base_branch,
            attachments: body.attachments.unwrap_or_default(),
            source: "spawn".to_string(),
        })
        .await
    {
        Ok(session) => created(json!({ "session": session_to_dashboard_value(&session) })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
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
) -> ApiResponse {
    match state.get_session(&id).await {
        Some(session) => ok(json!({
            "entries": build_normalized_chat_feed(&session),
            "sessionStatus": session.status,
            "source": if session.output.is_empty() { "conversation-only" } else { "runtime-output" },
        })),
        None => error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
    }
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
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let initial_output = state
        .get_session(&id)
        .await
        .map(|session| session.output)
        .unwrap_or_default();
    let initial_stream = stream::iter(vec![Ok(SseEvent::default().data(
        json!({ "type": "output", "output": initial_output }).to_string(),
    ))]);
    let updates = BroadcastStream::new(state.output_updates.subscribe()).filter_map(move |result| match result {
        Ok((session_id, output)) if session_id == id => Some(Ok(SseEvent::default().data(
            json!({ "type": "output", "output": output }).to_string(),
        ))),
        _ => None,
    });
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
    if body.message.trim().is_empty() && body.attachments.clone().unwrap_or_default().is_empty() {
        return error(StatusCode::BAD_REQUEST, "Message or attachments are required");
    }

    let mut target_session_id = id.clone();
    let mut restored_from: Option<String> = None;
    let is_live = state.live_sessions.read().await.contains_key(&id);

    if !is_live {
        let should_restore = state
            .get_session(&id)
            .await
            .map(|session| {
                !matches!(
                    session.status.as_str(),
                    "merged" | "killed" | "cleanup" | "done" | "terminated"
                )
            })
            .unwrap_or(false);

        if should_restore {
            match state.restore_session(&id).await {
                Ok(restored) => {
                    target_session_id = restored.id.clone();
                    restored_from = Some(id.clone());
                }
                Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
            }
        }
    }

    match state
        .send_to_session(
            &target_session_id,
            body.message,
            body.attachments.unwrap_or_default(),
            body.model,
            body.reasoning_effort,
            "follow_up",
        )
        .await
    {
        Ok(()) => ok(json!({
            "ok": true,
            "sessionId": target_session_id,
            "restoredFrom": restored_from,
        })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn kill_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.kill_session(&id).await {
        Ok(()) => ok(json!({ "ok": true, "sessionId": id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn restore_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    match state.restore_session(&id).await {
        Ok(session) => ok(json!({ "session": session_to_dashboard_value(&session) })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
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
        "retry" | "restore" => match state.restore_session(&id).await {
            Ok(session) => ok(json!({ "ok": true, "action": "restore", "session": session_to_dashboard_value(&session) })),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        "kill" | "terminate" => match state.kill_session(&id).await {
            Ok(()) => ok(json!({ "ok": true, "action": "kill", "sessionId": id })),
            Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
        },
        "send" => match state
            .send_to_session(&id, body.message.unwrap_or_default(), Vec::new(), None, None, "follow_up")
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
    let message = if let Some(keys) = body.keys {
        keys
    } else if let Some(special) = body.special {
        match special.as_str() {
            "Enter" => "".to_string(),
            "C-c" => {
                return match state.kill_session(&id).await {
                    Ok(()) => ok(json!({ "ok": true, "sessionId": id })),
                    Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
                }
            }
            other => other.to_string(),
        }
    } else {
        return error(StatusCode::BAD_REQUEST, "keys or special is required");
    };

    match state
        .send_to_session(&id, message, Vec::new(), None, None, "follow_up")
        .await
    {
        Ok(()) => ok(json!({ "ok": true, "sessionId": id })),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}
