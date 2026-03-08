use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{read, read_dir};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions/{id}/files", get(get_session_files))
        .route("/api/sessions/{id}/diff", get(get_session_diff))
        .route("/api/sessions/{id}/checks", get(get_session_checks))
}

#[derive(Debug, Deserialize)]
struct FilesQuery {
    path: Option<String>,
}

async fn get_session_files(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<FilesQuery>,
) -> ApiResponse {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found"));
    };
    let Some(workspace_path) = session.workspace_path else {
        return error(StatusCode::NOT_FOUND, "Session workspace is unavailable");
    };
    let workspace = PathBuf::from(&workspace_path);
    if !workspace.is_dir() {
        return error(StatusCode::NOT_FOUND, "Session workspace is unavailable");
    }

    if let Some(relative_path) = query
        .path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        match read_workspace_file(&workspace, relative_path) {
            Some(value) => ok(value),
            None => error(StatusCode::NOT_FOUND, "File not found"),
        }
    } else {
        ok(list_workspace_files(&workspace))
    }
}

async fn get_session_diff(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResponse {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found"));
    };
    let Some(workspace_path) = session.workspace_path else {
        return error(StatusCode::NOT_FOUND, "Session workspace is unavailable");
    };

    match load_diff_payload(FsPath::new(&workspace_path)).await {
        Ok(payload) => ok(payload),
        Err(err) => error(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

async fn get_session_checks(Path(id): Path<String>) -> ApiResponse {
    ok(json!({
        "sessionId": id,
        "source": "rust-backend",
        "ciStatus": "none",
        "checks": [],
        "generatedAt": chrono::Utc::now().to_rfc3339(),
    }))
}

fn list_workspace_files(workspace: &FsPath) -> Value {
    const MAX_FILE_COUNT: usize = 4000;
    let mut files = Vec::new();
    let mut stack = vec![workspace.to_path_buf()];
    let ignore_set: HashSet<&str> = [
        ".git",
        ".next",
        ".turbo",
        "node_modules",
        "dist",
        "build",
        "coverage",
        "target",
    ]
    .into_iter()
    .collect();
    let mut truncated = false;

    while let Some(current) = stack.pop() {
        let Ok(entries) = read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if path.is_dir() {
                if !ignore_set.contains(file_name.as_ref()) {
                    stack.push(path);
                }
                continue;
            }
            if !path.is_file() {
                continue;
            }
            if let Ok(relative) = path.strip_prefix(workspace) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
            if files.len() >= MAX_FILE_COUNT {
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }

    files.sort();
    json!({
        "workspacePath": workspace.to_string_lossy().to_string(),
        "files": files,
        "truncated": truncated,
    })
}

fn read_workspace_file(workspace: &FsPath, relative_path: &str) -> Option<Value> {
    let cleaned = relative_path
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_string();
    if cleaned.is_empty() || cleaned.contains("../") {
        return None;
    }
    let resolved = workspace.join(&cleaned);
    // Canonicalize to resolve symlinks before checking containment,
    // preventing symlink-based path traversal out of the workspace.
    let canonical_workspace = workspace.canonicalize().ok()?;
    let canonical_resolved = resolved.canonicalize().ok()?;
    if !canonical_resolved.starts_with(&canonical_workspace) || !canonical_resolved.is_file() {
        return None;
    }
    let raw = read(&resolved).ok()?;
    let size = raw.len();
    let binary = raw.iter().take(8000).any(|byte| *byte == 0);
    let truncated = size > 1024 * 1024;
    let content = if binary {
        Value::Null
    } else {
        Value::String(String::from_utf8_lossy(&raw[..raw.len().min(1024 * 1024)]).to_string())
    };
    Some(json!({
        "workspacePath": workspace.to_string_lossy().to_string(),
        "path": cleaned,
        "content": content,
        "size": size,
        "binary": binary,
        "truncated": truncated,
    }))
}

async fn load_diff_payload(workspace: &FsPath) -> anyhow::Result<Value> {
    let diff_output = tokio::process::Command::new("git")
        .args([
            "-C",
            workspace.to_string_lossy().as_ref(),
            "diff",
            "--no-color",
            "--no-ext-diff",
        ])
        .output()
        .await?;
    let status_output = tokio::process::Command::new("git")
        .args([
            "-C",
            workspace.to_string_lossy().as_ref(),
            "status",
            "--short",
            "--untracked-files=all",
        ])
        .output()
        .await?;

    let raw_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();
    let raw_status = String::from_utf8_lossy(&status_output.stdout).to_string();
    let untracked = raw_status
        .lines()
        .filter(|line| line.trim_start().starts_with("??"))
        .map(|line| {
            line.trim_start()
                .trim_start_matches("??")
                .trim()
                .to_string()
        })
        .collect::<Vec<_>>();

    let files = parse_git_diff(&raw_diff);
    Ok(json!({
        "hasDiff": !files.is_empty() || !untracked.is_empty(),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "source": "working-tree",
        "truncated": false,
        "files": files,
        "untracked": untracked,
    }))
}

fn parse_git_diff(raw: &str) -> Vec<Value> {
    let mut files = Vec::new();
    let mut current_path = String::new();
    let mut current_status = "modified".to_string();
    let mut current_lines: Vec<Value> = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    let mut old_line = 1_i64;
    let mut new_line = 1_i64;

    let flush = |files: &mut Vec<Value>,
                 path: &mut String,
                 status: &mut String,
                 lines: &mut Vec<Value>,
                 additions: &mut i32,
                 deletions: &mut i32| {
        if path.is_empty() {
            return;
        }
        files.push(json!({
            "path": path,
            "status": status,
            "additions": additions,
            "deletions": deletions,
            "lines": lines,
        }));
        path.clear();
        status.clear();
        status.push_str("modified");
        lines.clear();
        *additions = 0;
        *deletions = 0;
    };

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush(
                &mut files,
                &mut current_path,
                &mut current_status,
                &mut current_lines,
                &mut additions,
                &mut deletions,
            );
            let mut parts = rest.split_whitespace();
            let left = parts.next().unwrap_or_default().trim_start_matches("a/");
            let right = parts.next().unwrap_or_default().trim_start_matches("b/");
            current_path = if right.is_empty() {
                left.to_string()
            } else {
                right.to_string()
            };
            old_line = 1;
            new_line = 1;
            continue;
        }
        if current_path.is_empty() {
            continue;
        }
        if line.starts_with("new file mode") {
            current_status = "added".to_string();
            continue;
        }
        if line.starts_with("deleted file mode") {
            current_status = "deleted".to_string();
            continue;
        }
        if line.starts_with("rename from ") || line.starts_with("rename to ") {
            current_status = "renamed".to_string();
            continue;
        }
        if line.starts_with("Binary files ") {
            current_status = "binary".to_string();
            current_lines.push(json!({
                "kind": "info",
                "oldLine": Value::Null,
                "newLine": Value::Null,
                "text": line,
            }));
            continue;
        }
        if line.starts_with("@@ ") {
            if let Some((old_value, new_value)) = parse_hunk_header(line) {
                old_line = old_value;
                new_line = new_value;
            }
            current_lines.push(json!({
                "kind": "hunk",
                "oldLine": Value::Null,
                "newLine": Value::Null,
                "text": line,
            }));
            continue;
        }
        if line.starts_with("+++") || line.starts_with("---") || line.starts_with("index ") {
            continue;
        }
        if let Some(text) = line.strip_prefix('+') {
            additions += 1;
            current_lines.push(json!({
                "kind": "add",
                "oldLine": Value::Null,
                "newLine": new_line,
                "text": text.trim_end(),
            }));
            new_line += 1;
            continue;
        }
        if let Some(text) = line.strip_prefix('-') {
            deletions += 1;
            current_lines.push(json!({
                "kind": "remove",
                "oldLine": old_line,
                "newLine": Value::Null,
                "text": text.trim_end(),
            }));
            old_line += 1;
            continue;
        }
        if let Some(text) = line.strip_prefix(' ') {
            current_lines.push(json!({
                "kind": "context",
                "oldLine": old_line,
                "newLine": new_line,
                "text": text.trim_end(),
            }));
            old_line += 1;
            new_line += 1;
            continue;
        }
        current_lines.push(json!({
            "kind": "meta",
            "oldLine": Value::Null,
            "newLine": Value::Null,
            "text": line.trim_end(),
        }));
    }

    flush(
        &mut files,
        &mut current_path,
        &mut current_status,
        &mut current_lines,
        &mut additions,
        &mut deletions,
    );
    files
}

fn parse_hunk_header(line: &str) -> Option<(i64, i64)> {
    let rest = line.strip_prefix("@@ -")?;
    let mut parts = rest.split(" @@").next()?.split(" +");
    let old_part = parts.next()?;
    let new_part = parts.next()?;
    let old_start = old_part.split(',').next()?.parse::<i64>().ok()?;
    let new_start = new_part.split(',').next()?.parse::<i64>().ok()?;
    Some((old_start, new_start))
}
