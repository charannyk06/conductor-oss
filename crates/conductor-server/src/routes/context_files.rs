use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::{resolve_board_file, AppState};

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/context-files", get(list_context_files))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextFilesQuery {
    project_id: String,
}

async fn list_context_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ContextFilesQuery>,
) -> ApiResponse {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&query.project_id) else {
        return error(StatusCode::NOT_FOUND, format!("Unknown project: {}", query.project_id));
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let project_workspace_root = project
        .workspace
        .as_deref()
        .map(|configured| resolve_project_path(&state.workspace_path, configured));
    let board_dir = project.board_dir.clone().unwrap_or_else(|| query.project_id.clone());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_absolute = state.workspace_path.join(&board_relative);
    let attachments_root = state.workspace_path.join("attachments").join(&query.project_id);
    let board_parent = board_absolute.parent().map(Path::to_path_buf);
    let use_obsidian_sources = config.preferences.markdown_editor.trim().eq_ignore_ascii_case("obsidian");

    let mut files = Vec::new();
    if board_absolute.exists() {
        files.push(file_descriptor(&board_absolute, &state.workspace_path, Some("board")));
    }
    if use_obsidian_sources {
        if let Some(root) = board_parent.as_deref() {
            collect_project_files(root, &state.workspace_path, "vault", &mut files);
        }
        if board_parent.as_deref() != Some(state.workspace_path.as_path()) {
            collect_project_files(&state.workspace_path, &state.workspace_path, "vault", &mut files);
        }
    }
    if let Some(root) = project_workspace_root.as_deref() {
        if root != project_root.as_path()
            && root != state.workspace_path.as_path()
            && board_parent.as_deref() != Some(root)
        {
            collect_project_files(root, &state.workspace_path, "workspace", &mut files);
        }
    }
    collect_project_files(&project_root, &state.workspace_path, "project", &mut files);
    collect_project_files(&attachments_root, &state.workspace_path, "attachment", &mut files);

    files.sort_by(|left, right| left["path"].as_str().unwrap_or_default().cmp(right["path"].as_str().unwrap_or_default()));
    files.dedup_by(|left, right| left["path"] == right["path"]);
    ok(json!({ "files": files }))
}

fn collect_project_files(root: &Path, workspace_root: &Path, source: &str, out: &mut Vec<Value>) {
    const MAX_FILES: usize = 200;
    const MAX_DEPTH: usize = 3;
    if !root.exists() {
        return;
    }

    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if out.len() >= MAX_FILES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                let hidden_dir = name.starts_with('.') && name != ".github";
                if depth < MAX_DEPTH && !hidden_dir && !matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | ".next") {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            if !is_candidate_file(&path) {
                continue;
            }
            out.push(file_descriptor(&path, workspace_root, Some(source)));
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
}

fn file_descriptor(path: &Path, workspace_root: &Path, source: Option<&str>) -> Value {
    let display_path = path
        .strip_prefix(workspace_root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or(&display_path).to_string();
    let size_bytes = std::fs::metadata(path).ok().map(|value| value.len());
    json!({
        "path": display_path,
        "name": name,
        "kind": if is_image(path) { "image" } else { "file" },
        "source": source,
        "sizeBytes": size_bytes,
    })
}

fn resolve_project_path(workspace_root: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() { candidate } else { workspace_root.join(candidate) }
}

fn is_candidate_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    matches!(ext.as_str(), "md" | "txt" | "pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "json" | "yaml" | "yml" | "toml" | "rs" | "ts" | "tsx" | "js" | "jsx")
}

fn is_image(path: &Path) -> bool {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tiff")
}
