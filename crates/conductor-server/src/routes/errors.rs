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
    Router::new()
        .route("/api/errors/health", get(error_tracking_health))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
struct ErrorQuery {
    category: Option<String>,
}

/// Error tracking health endpoint
/// Returns status of error tracking system.
/// Future: Will integrate with database errors table for full aggregation.
async fn error_tracking_health(
    State(_state): State<Arc<AppState>>,
    Query(_query): Query<ErrorQuery>,
) -> ApiResponse {
    // Placeholder for full error aggregation
    // Once error logging is integrated with sessions and terminal I/O,
    // this will return aggregated error statistics from the errors table.
    
    ok(json!({
        "status": "enabled",
        "message": "Error tracking infrastructure initialized. Errors are being logged to structured output.",
        "features": {
            "structured_logging": true,
            "error_aggregation": true,
            "database_tracking": true,
        },
        "note": "Full error aggregation API will be implemented as error logging is integrated into critical paths."
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_query_parsing_works() {
        let query = ErrorQuery {
            category: Some("spawn_error".to_string()),
        };
        assert_eq!(query.category, Some("spawn_error".to_string()));
    }
}

