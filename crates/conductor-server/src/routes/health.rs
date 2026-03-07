use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::state::AppState;
use conductor_db::repo::SessionRepo;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/health", get(health_check))
        .route("/api/health/sessions", get(session_health))
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
    uptime_secs: u64,
    executors: usize,
    event_subscribers: usize,
}

async fn health_check(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let executors = state.executors.read().await;
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_secs: 0, // TODO: track startup time
        executors: executors.len(),
        event_subscribers: state.event_bus.subscriber_count(),
    })
}

#[derive(Serialize)]
struct SessionHealthResponse {
    total: usize,
    active: usize,
    errored: usize,
    needs_input: usize,
    sessions: Vec<SessionHealthEntry>,
}

#[derive(Serialize)]
struct SessionHealthEntry {
    id: String,
    project_id: String,
    executor: String,
    state: String,
    grade: String,
    idle_secs: i64,
}

async fn session_health(State(state): State<Arc<AppState>>) -> Json<SessionHealthResponse> {
    let pool = state.db.pool();

    let sessions = SessionRepo::list(pool, None).await.unwrap_or_default();

    let active = sessions.iter().filter(|s| s.state == "active" || s.state == "idle").count();
    let errored = sessions.iter().filter(|s| s.state == "errored").count();
    let needs_input = sessions.iter().filter(|s| s.state == "needs_input").count();

    let entries: Vec<SessionHealthEntry> = sessions
        .iter()
        .filter(|s| s.state != "terminated")
        .map(|s| {
            let idle_secs = chrono::Utc::now()
                .signed_duration_since(
                    chrono::DateTime::parse_from_rfc3339(&s.last_activity_at)
                        .unwrap_or_else(|_| chrono::Utc::now().into()),
                )
                .num_seconds();

            let grade = if s.state == "errored" || s.state == "terminated" {
                "F"
            } else if s.state == "needs_input" || idle_secs > 900 {
                "C"
            } else if idle_secs > 300 {
                "B"
            } else {
                "A"
            };

            SessionHealthEntry {
                id: s.id.clone(),
                project_id: s.project_id.clone(),
                executor: s.executor.clone(),
                state: s.state.clone(),
                grade: grade.to_string(),
                idle_secs,
            }
        })
        .collect();

    Json(SessionHealthResponse {
        total: sessions.len(),
        active,
        errored,
        needs_input,
        sessions: entries,
    })
}
