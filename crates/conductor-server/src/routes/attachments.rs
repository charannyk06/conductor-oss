use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

const MAX_UPLOAD_FILES: usize = 20;
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/attachments", post(upload_attachments))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

async fn upload_attachments(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> ApiResponse {
    let mut project_id: Option<String> = None;
    let mut files = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or_default().to_string();
        if name == "projectId" {
            let value = match field.text().await {
                Ok(value) => value.trim().to_string(),
                Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
            };
            if !value.is_empty() {
                project_id = Some(value);
            }
            continue;
        }
        if name != "files" {
            continue;
        }
        if files.len() >= MAX_UPLOAD_FILES {
            return error(StatusCode::BAD_REQUEST, format!("Too many files. Max {MAX_UPLOAD_FILES} files per request."));
        }
        let file_name = field.file_name().unwrap_or("upload.bin").to_string();
        let content_type = field.content_type().map(|value| value.to_string());
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
        };
        if bytes.len() > MAX_UPLOAD_BYTES {
            return error(StatusCode::PAYLOAD_TOO_LARGE, format!("File \"{file_name}\" exceeds 25MB limit."));
        }
        files.push((file_name, content_type, bytes));
    }

    let project_id = match project_id {
        Some(value) => value,
        None => return error(StatusCode::BAD_REQUEST, "projectId is required"),
    };
    if files.is_empty() {
        return error(StatusCode::BAD_REQUEST, "No files uploaded");
    }

    let config = state.config.read().await.clone();
    if !config.projects.contains_key(&project_id) {
        return error(StatusCode::NOT_FOUND, format!("Unknown project: {project_id}"));
    }

    let target_dir = state.workspace_path.join("attachments").join(normalize_token(&project_id));
    if let Err(err) = std::fs::create_dir_all(&target_dir) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    let mut uploaded = Vec::new();
    for (index, (file_name, content_type, bytes)) in files.into_iter().enumerate() {
        let safe_name = sanitize_file_name(&file_name);
        let unique_name = format!("{}-{}-{}", chrono::Utc::now().timestamp_millis(), index, Uuid::new_v4().simple());
        let file_path = target_dir.join(format!("{unique_name}-{safe_name}"));
        if let Err(err) = std::fs::write(&file_path, &bytes) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
        }
        let relative_path = file_path
            .strip_prefix(&state.workspace_path)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.to_string_lossy().to_string());
        uploaded.push(json!({
            "path": relative_path,
            "absolutePath": file_path.to_string_lossy().to_string(),
            "name": file_name,
            "size": bytes.len(),
            "mimeType": content_type,
            "kind": if is_image_path(&file_path) { "image" } else { "file" },
        }));
    }

    (StatusCode::CREATED, Json(json!({ "files": uploaded })))
}

fn normalize_token(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_') { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn sanitize_file_name(value: &str) -> String {
    let normalized_path = value.replace('\\', "/");
    let normalized = normalized_path.split('/').next_back().unwrap_or("upload.bin");
    let sanitized = normalized
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '-' })
        .collect::<String>();
    sanitized.trim_matches('-').to_string()
}

fn is_image_path(path: &Path) -> bool {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tiff")
}
