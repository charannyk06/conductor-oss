use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/app-update", get(get_app_update).post(post_app_update))
}

#[derive(Debug, Deserialize)]
struct AppUpdateQuery {
    force: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateActionBody {
    action: Option<String>,
}

async fn get_app_update(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AppUpdateQuery>,
) -> Json<crate::state::AppUpdateStatus> {
    let force = query.force == Some(1);
    Json(state.refresh_app_update(force).await)
}

async fn post_app_update(
    State(state): State<Arc<AppState>>,
    body: Option<Json<AppUpdateActionBody>>,
) -> (StatusCode, Json<Value>) {
    let action = body
        .and_then(|Json(payload)| payload.action)
        .unwrap_or_else(|| "install".to_string());

    let result = match action.as_str() {
        "install" => state.trigger_app_update().await,
        "restart" => state.trigger_app_restart().await,
        _ => Err(anyhow::anyhow!("Unsupported app update action.")),
    };

    match result {
        Ok(snapshot) => (StatusCode::OK, Json(json!(snapshot))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}
