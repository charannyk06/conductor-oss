use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::state::AppState;
use conductor_db::repo::ProjectRepo;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects", get(list_projects))
        .route("/api/projects/{id}", get(get_project))
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
