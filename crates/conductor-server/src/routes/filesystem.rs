use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/filesystem/directory", get(read_directory))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

async fn read_directory(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DirectoryQuery>,
) -> ApiResponse {
    let requested = query.path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let path = requested.map(|value| expand_path(value, &state.workspace_path)).unwrap_or_else(|| state.workspace_path.clone());
    let current_path = if path.is_file() {
        path.parent().map(Path::to_path_buf).unwrap_or(path)
    } else {
        path
    };

    if !current_path.exists() {
        return error(StatusCode::NOT_FOUND, "Directory not found");
    }
    if !current_path.is_dir() {
        return error(StatusCode::BAD_REQUEST, "Path is not a directory");
    }

    let entries = std::fs::read_dir(&current_path)
        .map_err(|err| error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
        .and_then(|entries| {
            let mut items = entries
                .flatten()
                .map(|entry| {
                    let path = entry.path();
                    let file_type = entry.file_type().ok();
                    let is_directory = file_type.as_ref().map(|value| value.is_dir()).unwrap_or(false);
                    json!({
                        "name": entry.file_name().to_string_lossy().to_string(),
                        "path": path.to_string_lossy().to_string(),
                        "isDirectory": is_directory,
                        "isGitRepo": is_directory && path.join(".git").exists(),
                    })
                })
                .collect::<Vec<_>>();
            items.sort_by(|left, right| {
                let left_dir = left["isDirectory"].as_bool().unwrap_or(false);
                let right_dir = right["isDirectory"].as_bool().unwrap_or(false);
                right_dir.cmp(&left_dir).then_with(|| {
                    left["name"].as_str().unwrap_or_default().cmp(right["name"].as_str().unwrap_or_default())
                })
            });
            Ok(items)
        });

    match entries {
        Ok(items) => ok(json!({
            "currentPath": current_path.to_string_lossy().to_string(),
            "entries": items,
        })),
        Err(response) => response,
    }
}

fn expand_path(value: &str, workspace_path: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            return home.join(stripped);
        }
    }
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}
