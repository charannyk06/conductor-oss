use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(
        "/api/notifications",
        get(list_notifications).post(acknowledge_notification),
    )
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

#[derive(Debug, Deserialize)]
struct NotificationQuery {
    project: Option<String>,
    limit: Option<usize>,
    since: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationAction {
    action: Option<String>,
    event_id: Option<String>,
}

async fn list_notifications(
    State(state): State<Arc<AppState>>,
    Query(query): Query<NotificationQuery>,
) -> ApiResponse {
    let since = query
        .since
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc));
    let limit = query.limit.unwrap_or(20);
    let mut notifications = state
        .all_sessions()
        .await
        .into_iter()
        .filter(|session| match query.project.as_deref() {
            Some(project_id) if !project_id.trim().is_empty() => session.project_id == project_id,
            _ => true,
        })
        .filter(|session| matches!(session.status.as_str(), "needs_input" | "errored" | "terminated"))
        .filter(|session| {
            since
                .map(|cutoff| chrono::DateTime::parse_from_rfc3339(&session.last_activity_at).map(|value| value.with_timezone(&chrono::Utc) >= cutoff).unwrap_or(true))
                .unwrap_or(true)
        })
        .map(|session| {
            let priority = match session.status.as_str() {
                "errored" => "high",
                "needs_input" => "medium",
                _ => "low",
            };
            json!({
                "id": format!("session:{}:{}", session.id, session.status),
                "type": session.status,
                "priority": priority,
                "sessionId": session.id,
                "projectId": session.project_id,
                "message": session.summary.unwrap_or_else(|| format!("Session status changed to {}", session.status)),
                "timestamp": session.last_activity_at,
                "data": { "activity": session.activity, "branch": session.branch },
            })
        })
        .collect::<Vec<_>>();

    notifications.sort_by(|left, right| {
        right["timestamp"]
            .as_str()
            .unwrap_or_default()
            .cmp(left["timestamp"].as_str().unwrap_or_default())
    });
    notifications.truncate(limit);

    ok(json!({
        "notifications": notifications,
        "metrics": {
            "total": notifications.len(),
            "high": notifications.iter().filter(|item| item["priority"] == "high").count(),
            "medium": notifications.iter().filter(|item| item["priority"] == "medium").count(),
            "low": notifications.iter().filter(|item| item["priority"] == "low").count(),
        }
    }))
}

async fn acknowledge_notification(Json(body): Json<NotificationAction>) -> ApiResponse {
    ok(json!({
        "ok": body.action.as_deref() == Some("ack"),
        "eventId": body.event_id,
    }))
}
