use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/config", get(get_config))
        .route("/api/config/executors", get(list_executors))
}

async fn get_config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "workspace": state.config.workspace.display().to_string(),
        "server": {
            "host": state.config.server.host,
            "port": state.config.server.port,
        },
        "projects": state.config.projects.len(),
        "webhooks": state.config.webhooks.len(),
    }))
}

async fn list_executors(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let executors = state.executors.read().await;
    let list: Vec<serde_json::Value> = executors
        .iter()
        .map(|(kind, exec)| {
            serde_json::json!({
                "kind": kind.to_string(),
                "name": exec.name(),
                "binary": exec.binary_path().display().to_string(),
            })
        })
        .collect();
    Json(serde_json::to_value(list).unwrap_or_default())
}
