use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use crate::state::AppState;
use conductor_core::{task::Task, types::Priority};
use conductor_db::repo::TaskRepo;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/{id}", get(get_task))
        .route("/api/tasks/{id}/state", post(update_task_state))
}

#[derive(Deserialize)]
struct ListQuery {
    project_id: Option<String>,
    state: Option<String>,
}

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();

    if let Some(project_id) = &query.project_id {
        let tasks = TaskRepo::list(pool, project_id, query.state.as_deref())
            .await
            .unwrap_or_default();
        Json(serde_json::to_value(tasks).unwrap_or_default())
    } else {
        Json(serde_json::json!({ "error": "project_id is required" }))
    }
}

#[derive(Deserialize)]
struct CreateTaskRequest {
    project_id: String,
    title: String,
    description: Option<String>,
    priority: Option<String>,
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateTaskRequest>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();
    let mut task = Task::new(body.project_id, body.title);
    task.description = body.description;
    if let Some(priority) = body.priority.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        task.priority = serde_json::from_value(serde_json::Value::String(priority.to_lowercase()))
            .unwrap_or(Priority::default());
    }

    match TaskRepo::create(pool, &task).await {
        Ok(_) => {
            state.publish_snapshot().await;
            Json(serde_json::to_value(&task).unwrap_or_default())
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

async fn get_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();
    match TaskRepo::get(pool, &id).await {
        Ok(Some(task)) => Json(serde_json::to_value(task).unwrap_or_default()),
        Ok(None) => Json(serde_json::json!({ "error": "not found" })),
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
struct UpdateStateRequest {
    state: String,
}

async fn update_task_state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateStateRequest>,
) -> Json<serde_json::Value> {
    let pool = state.db.pool();
    match TaskRepo::update_state(pool, &id, &body.state).await {
        Ok(_) => {
            state.publish_snapshot().await;
            Json(serde_json::json!({ "ok": true }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}
