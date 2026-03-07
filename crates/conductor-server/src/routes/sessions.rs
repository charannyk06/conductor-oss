use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use crate::state::AppState;
use conductor_db::repo::SessionRepo;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/kill", post(kill_session))
        .route("/api/sessions/{id}/send", post(send_to_session))
        .route("/api/sessions/{id}/logs", get(get_session_logs))
}

#[derive(Deserialize)]
struct ListQuery {
    state: Option<String>,
    project_id: Option<String>,
    compact: Option<bool>,
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();
    let sessions = SessionRepo::list(pool, query.state.as_deref())
        .await
        .unwrap_or_default();

    // Optionally filter by project.
    let sessions: Vec<_> = if let Some(ref project_id) = query.project_id {
        sessions.into_iter().filter(|s| s.project_id == *project_id).collect()
    } else {
        sessions
    };

    if query.compact.unwrap_or(false) {
        // Compact mode: abbreviated field names for mobile.
        let compact: Vec<serde_json::Value> = sessions
            .iter()
            .map(|s| {
                serde_json::json!({
                    "i": s.id,
                    "p": s.project_id,
                    "s": s.state,
                    "e": s.executor,
                    "a": s.last_activity_at,
                })
            })
            .collect();
        Json(serde_json::to_value(compact).unwrap_or_default())
    } else {
        Json(serde_json::to_value(&sessions).unwrap_or_default())
    }
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();
    let sessions = SessionRepo::list(pool, None).await.unwrap_or_default();
    let session = sessions.into_iter().find(|s| s.id == id);
    Json(serde_json::to_value(&session).unwrap_or_default())
}

async fn kill_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();

    // Find the session and kill its process.
    let sessions = SessionRepo::list(pool, None).await.unwrap_or_default();
    if let Some(session) = sessions.iter().find(|s| s.id == id) {
        if let Some(pid) = session.pid {
            // Kill the process.
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        let _ = SessionRepo::terminate(pool, &id, Some(-15)).await;
        state.event_bus.publish(conductor_core::event::Event::SessionTerminated {
            session_id: uuid::Uuid::parse_str(&id).unwrap_or_default(),
            exit_code: Some(-15),
        });
        Json(serde_json::json!({ "ok": true, "killed": id }))
    } else {
        Json(serde_json::json!({ "error": "session not found" }))
    }
}

#[derive(Deserialize)]
struct SendRequest {
    text: String,
}

async fn send_to_session(
    State(_state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<SendRequest>,
) -> Json<serde_json::Value> {
    // TODO: Send input to the agent process via its input channel.
    tracing::info!("Sending to session {id}: {}", body.text);
    Json(serde_json::json!({ "ok": true, "sent_to": id }))
}

async fn get_session_logs(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();
    let logs = SessionRepo::get_logs(pool, &id, 100).await.unwrap_or_default();
    Json(serde_json::to_value(&logs).unwrap_or_default())
}
