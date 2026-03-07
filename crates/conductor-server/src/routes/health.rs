use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/health", get(health_check))
        .route("/api/health/sessions", get(session_health))
}

async fn health_check(State(state): State<Arc<AppState>>) -> (StatusCode, Json<Value>) {
    let executors = state.executors.read().await;
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_secs": (chrono::Utc::now() - state.started_at).num_seconds().max(0),
            "executors": executors.len(),
            "event_subscribers": state.event_snapshots.receiver_count(),
        })),
    )
}

async fn session_health(State(state): State<Arc<AppState>>) -> (StatusCode, Json<Value>) {
    let sessions = state.all_sessions().await;
    let live_session_ids = state.live_sessions.read().await.keys().cloned().collect::<std::collections::HashSet<_>>();
    let now = chrono::Utc::now();
    let metrics = sessions
        .iter()
        .map(|session| {
            let created = chrono::DateTime::parse_from_rfc3339(&session.created_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or(now);
            let last_activity = chrono::DateTime::parse_from_rfc3339(&session.last_activity_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or(now);
            let age_ms = (now - created).num_milliseconds();
            let idle_ms = (now - last_activity).num_milliseconds();
            let health = if matches!(session.status.as_str(), "stuck" | "errored") {
                "critical"
            } else if matches!(session.status.as_str(), "needs_input") {
                "warning"
            } else {
                "healthy"
            };
            json!({
                "id": session.id,
                "projectId": session.project_id,
                "status": session.status,
                "activity": session.activity,
                "health": health,
                "ageMs": age_ms,
                "idleMs": idle_ms,
                "createdAt": session.created_at,
                "lastActivityAt": session.last_activity_at,
                "hasRuntime": live_session_ids.contains(&session.id),
                "hasPR": session.pr.is_some(),
            })
        })
        .collect::<Vec<_>>();

    let summary = json!({
        "total": metrics.len(),
        "healthy": metrics.iter().filter(|metric| metric["health"] == "healthy").count(),
        "warning": metrics.iter().filter(|metric| metric["health"] == "warning").count(),
        "critical": metrics.iter().filter(|metric| metric["health"] == "critical").count(),
    });

    (StatusCode::OK, Json(json!({ "metrics": metrics, "summary": summary })))
}
