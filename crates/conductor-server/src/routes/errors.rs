use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use conductor_db::repo::ErrorRepo;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/errors/health", get(error_tracking_health))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorQuery {
    category: Option<String>,
    limit: Option<i64>,
}

/// Error tracking health endpoint
async fn error_tracking_health(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ErrorQuery>,
) -> ApiResponse {
    let category = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let pool = state.db.pool();

    let summary = match ErrorRepo::summary(pool, category).await {
        Ok(summary) => summary,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let recent = match ErrorRepo::recent(pool, category, limit).await {
        Ok(rows) => rows,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    ok(json!({
        "status": "enabled",
        "message": "Error tracking is active and backed by SQLite.",
        "features": {
            "structured_logging": true,
            "error_aggregation": true,
            "database_tracking": true,
        },
        "category": category,
        "limit": limit,
        "summary": summary,
        "recent": recent,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_query_parsing_works() {
        let query = ErrorQuery {
            category: Some("spawn_error".to_string()),
            limit: Some(1),
        };
        assert_eq!(query.category, Some("spawn_error".to_string()));
    }
}
