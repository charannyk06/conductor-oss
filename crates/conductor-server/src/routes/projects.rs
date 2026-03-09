use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::state::AppState;
use conductor_core::support::{
    resolve_project_path, sync_project_local_config, sync_support_files_for_directory,
};
use conductor_db::repo::ProjectRepo;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects", get(list_projects))
        .route("/api/projects/{id}", get(get_project))
        .route("/api/projects/{id}/setup", post(setup_project))
}

#[derive(Serialize)]
struct ProjectResponse {
    id: String,
    name: String,
    path: String,
    board_path: Option<String>,
    default_executor: Option<String>,
    max_sessions: i64,
}

async fn list_projects(State(state): State<Arc<AppState>>) -> Json<Vec<ProjectResponse>> {
    let pool = state.db.pool();
    let projects = ProjectRepo::list(pool).await.unwrap_or_default();

    Json(
        projects
            .into_iter()
            .map(|p| ProjectResponse {
                id: p.id,
                name: p.name,
                path: p.path,
                board_path: p.board_path,
                default_executor: p.default_executor,
                max_sessions: p.max_sessions,
            })
            .collect(),
    )
}

async fn get_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<Option<ProjectResponse>> {
    let pool = state.db.pool();
    let project = ProjectRepo::get(pool, &id).await.unwrap_or(None);

    Json(project.map(|p| ProjectResponse {
        id: p.id,
        name: p.name,
        path: p.path,
        board_path: p.board_path,
        default_executor: p.default_executor,
        max_sessions: p.max_sessions,
    }))
}

async fn setup_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": format!("Project {id} not found") })),
        );
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let local_config_synced = match sync_project_local_config(&config, &state.workspace_path, &id) {
        Ok(value) => value,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": err.to_string() })),
            )
        }
    };
    let support_files_synced = match sync_support_files_for_directory(&config, &project_root) {
        Ok(value) => value,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": err.to_string() })),
            )
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "projectId": id,
            "path": project_root,
            "localConfigSynced": local_config_synced,
            "supportFilesSynced": support_files_synced,
        })),
    )
}
