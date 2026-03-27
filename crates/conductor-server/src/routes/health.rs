use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::{is_dashboard_hidden_session, AppState, SessionStatus};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/health", get(health_check))
        .route("/api/health/sessions", get(session_health))
        .route("/metrics", get(prometheus_metrics))
}

async fn health_check(State(state): State<Arc<AppState>>) -> (StatusCode, Json<Value>) {
    let executors = state.executors.read().await;
    let live_session_ids = state
        .attached_terminal_session_ids()
        .await
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let sessions = state.sessions.read().await;
    let queue_depth = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|session| session.status == SessionStatus::Queued)
        .count();
    let recovering = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|session| session.metadata.contains_key("recoveryState"))
        .count();
    let detached = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|session| session.metadata.contains_key("detachedPid"))
        .count();
    let launching = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|session| {
            session.status == SessionStatus::Spawning || live_session_ids.contains(&session.id)
        })
        .count();
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "uptime_secs": (chrono::Utc::now() - state.started_at).num_seconds().max(0),
            "executors": executors.len(),
            "event_subscribers": state.event_snapshots.receiver_count(),
            "queue_depth": queue_depth,
            "launching_sessions": launching,
            "recovering_sessions": recovering,
            "detached_sessions": detached,
        })),
    )
}

async fn session_health(State(state): State<Arc<AppState>>) -> (StatusCode, Json<Value>) {
    let sessions = state.all_sessions().await;
    let live_session_ids = state
        .attached_terminal_session_ids()
        .await
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let now = chrono::Utc::now();
    let metrics = sessions
        .iter()
        .filter(|session| !is_dashboard_hidden_session(session))
        .map(|session| {
            let created = chrono::DateTime::parse_from_rfc3339(&session.created_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or(now);
            let last_activity = chrono::DateTime::parse_from_rfc3339(&session.last_activity_at)
                .map(|value| value.with_timezone(&chrono::Utc))
                .unwrap_or(now);
            let age_ms = (now - created).num_milliseconds();
            let idle_ms = (now - last_activity).num_milliseconds();
            let health = if matches!(
                session.status,
                SessionStatus::Stuck | SessionStatus::Errored
            ) {
                "critical"
            } else if session.status == SessionStatus::Queued {
                "pending"
            } else if session.status == SessionStatus::NeedsInput
                || session.metadata.contains_key("recoveryState")
            {
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
                "recoveryState": session.metadata.get("recoveryState"),
                "detachedPid": session.metadata.get("detachedPid"),
                "hasPR": session.pr.is_some(),
            })
        })
        .collect::<Vec<_>>();

    let summary = json!({
        "total": metrics.len(),
        "healthy": metrics.iter().filter(|metric| metric["health"] == "healthy").count(),
        "pending": metrics.iter().filter(|metric| metric["health"] == "pending").count(),
        "warning": metrics.iter().filter(|metric| metric["health"] == "warning").count(),
        "critical": metrics.iter().filter(|metric| metric["health"] == "critical").count(),
    });

    (
        StatusCode::OK,
        Json(json!({ "metrics": metrics, "summary": summary })),
    )
}

/// Prometheus metrics endpoint
/// Returns metrics in Prometheus text format for scraping.
async fn prometheus_metrics(State(state): State<Arc<AppState>>) -> (StatusCode, String) {
    let executors = state.executors.read().await;
    let sessions = state.sessions.read().await;

    let queued = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|s| s.status == SessionStatus::Queued)
        .count();
    let spawning = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|s| s.status == SessionStatus::Spawning)
        .count();
    let working = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|s| s.status == SessionStatus::Working)
        .count();
    let completed = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|s| {
            matches!(
                s.status,
                SessionStatus::Completed | SessionStatus::Done | SessionStatus::Archived
            )
        })
        .count();
    let errored = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|s| s.status == SessionStatus::Errored)
        .count();
    let stuck = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .filter(|s| s.status == SessionStatus::Stuck)
        .count();
    let total_sessions = sessions
        .values()
        .filter(|session| !is_dashboard_hidden_session(session))
        .count();

    let metrics = format!(
        "# HELP conductor_sessions_total Total number of sessions
# TYPE conductor_sessions_total gauge
conductor_sessions_total {}

# HELP conductor_sessions_queued Number of queued sessions
# TYPE conductor_sessions_queued gauge
conductor_sessions_queued {}

# HELP conductor_sessions_spawning Number of sessions being spawned
# TYPE conductor_sessions_spawning gauge
conductor_sessions_spawning {}

# HELP conductor_sessions_working Number of active sessions
# TYPE conductor_sessions_working gauge
conductor_sessions_working {}

# HELP conductor_sessions_complete Number of completed sessions
# TYPE conductor_sessions_complete gauge
conductor_sessions_complete {}

# HELP conductor_sessions_errored Number of errored sessions
# TYPE conductor_sessions_errored gauge
conductor_sessions_errored {}

# HELP conductor_sessions_stuck Number of stuck sessions
# TYPE conductor_sessions_stuck gauge
conductor_sessions_stuck {}

# HELP conductor_executors_available Number of available agent executors
# TYPE conductor_executors_available gauge
conductor_executors_available {}

# HELP conductor_uptime_seconds Server uptime in seconds
# TYPE conductor_uptime_seconds gauge
conductor_uptime_seconds {}
",
        total_sessions,
        queued,
        spawning,
        working,
        completed,
        errored,
        stuck,
        executors.len(),
        (chrono::Utc::now() - state.started_at).num_seconds().max(0),
    );

    (StatusCode::OK, metrics)
}
