use anyhow::Context;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs::{read, read_dir};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use tokio::process::Command;

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

#[derive(Debug, Deserialize)]
struct DiffQuery {
    path: Option<String>,
    category: Option<String>,
    #[serde(rename = "oldPath")]
    old_path: Option<String>,
    status: Option<String>,
    #[serde(rename = "baseBranch")]
    base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ChangedFileSummary {
    path: String,
    #[serde(rename = "oldPath", skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
    status: String,
    additions: usize,
    deletions: usize,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum DiffCategory {
    AgainstBase,
    Staged,
    Unstaged,
    Untracked,
}

impl DiffCategory {
    fn from_query(value: Option<&str>) -> Self {
        match value.unwrap_or("against-base") {
            "staged" => Self::Staged,
            "unstaged" => Self::Unstaged,
            "untracked" => Self::Untracked,
            _ => Self::AgainstBase,
        }
    }
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
    Query(query): Query<DiffQuery>,
) -> ApiResponse {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found"));
    };
    let Some(workspace_path) = session.workspace_path else {
        return error(StatusCode::NOT_FOUND, "Session workspace is unavailable");
    };

    let workspace = FsPath::new(&workspace_path);
    let payload = if query.path.as_deref().is_some() {
        load_diff_file_contents(workspace, query).await
    } else {
        load_diff_payload(workspace).await
    };

    match payload {
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
    let default_branch = resolve_default_branch(workspace).await?;
    let branch = resolve_current_branch(workspace).await?;

    let diff_output = run_git(
        workspace,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            default_branch.as_str(),
            "--",
        ],
    )
    .await?;
    let status_output = run_git(workspace, &["status", "--short", "--untracked-files=all"]).await?;

    let raw_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();
    let raw_status = String::from_utf8_lossy(&status_output.stdout).to_string();
    let untracked = collect_untracked_paths(&raw_status);
    let against_base =
        collect_diff_summary(workspace, DiffCategory::AgainstBase, &default_branch).await?;
    let staged = collect_diff_summary(workspace, DiffCategory::Staged, &default_branch).await?;
    let unstaged = collect_diff_summary(workspace, DiffCategory::Unstaged, &default_branch).await?;
    let untracked_entries = untracked
        .iter()
        .map(|path| ChangedFileSummary {
            path: path.clone(),
            old_path: None,
            status: "untracked".to_string(),
            additions: 0,
            deletions: 0,
        })
        .collect::<Vec<_>>();
    let files = parse_git_diff(&raw_diff);

    Ok(json!({
        "hasDiff": !against_base.is_empty() || !staged.is_empty() || !unstaged.is_empty() || !untracked.is_empty(),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "source": "working-tree",
        "truncated": false,
        "branch": branch,
        "defaultBranch": default_branch,
        "files": files,
        "untracked": untracked,
        "sections": {
            "againstBase": against_base,
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked_entries,
        },
    }))
}

async fn load_diff_file_contents(workspace: &FsPath, query: DiffQuery) -> anyhow::Result<Value> {
    let path = sanitize_relative_path(query.path.as_deref().unwrap_or_default())
        .context("A diff file path is required")?;
    let old_path = query
        .old_path
        .as_deref()
        .map(sanitize_relative_path)
        .transpose()?;
    let category = DiffCategory::from_query(query.category.as_deref());
    let status = normalize_changed_status(query.status.as_deref());
    let default_branch = match query.base_branch.as_deref() {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => resolve_default_branch(workspace).await?,
    };

    let original_bytes = match category {
        DiffCategory::AgainstBase => {
            read_git_revision_content(
                workspace,
                &default_branch,
                old_path.as_deref().unwrap_or(&path),
            )
            .await?
        }
        DiffCategory::Staged => {
            if matches!(status.as_str(), "added" | "untracked") {
                None
            } else {
                read_git_revision_content(workspace, "HEAD", old_path.as_deref().unwrap_or(&path))
                    .await?
            }
        }
        DiffCategory::Unstaged => {
            if status == "untracked" {
                None
            } else {
                read_git_index_content(workspace, old_path.as_deref().unwrap_or(&path)).await?
            }
        }
        DiffCategory::Untracked => None,
    };

    let modified_bytes = match category {
        DiffCategory::Staged => {
            if status == "deleted" {
                None
            } else {
                read_git_index_content(workspace, &path).await?
            }
        }
        DiffCategory::AgainstBase | DiffCategory::Unstaged | DiffCategory::Untracked => {
            if status == "deleted" {
                None
            } else {
                read_workspace_bytes(workspace, &path)?
            }
        }
    };

    let binary = original_bytes.as_deref().is_some_and(is_binary_content)
        || modified_bytes.as_deref().is_some_and(is_binary_content);
    let (original, original_truncated, original_size) =
        stringify_diff_content(original_bytes, binary);
    let (modified, modified_truncated, modified_size) =
        stringify_diff_content(modified_bytes, binary);

    Ok(json!({
        "path": path,
        "oldPath": old_path,
        "status": status,
        "category": match category {
            DiffCategory::AgainstBase => "against-base",
            DiffCategory::Staged => "staged",
            DiffCategory::Unstaged => "unstaged",
            DiffCategory::Untracked => "untracked",
        },
        "baseBranch": default_branch,
        "binary": binary,
        "truncated": original_truncated || modified_truncated,
        "originalSize": original_size,
        "modifiedSize": modified_size,
        "original": original,
        "modified": modified,
    }))
}

async fn run_git(workspace: &FsPath, args: &[&str]) -> anyhow::Result<std::process::Output> {
    Command::new("git")
        .args(["-C", workspace.to_string_lossy().as_ref()])
        .args(args)
        .output()
        .await
        .with_context(|| format!("Failed to run git {}", args.join(" ")))
}

async fn resolve_current_branch(workspace: &FsPath) -> anyhow::Result<String> {
    let output = run_git(workspace, &["branch", "--show-current"]).await?;
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        return Ok("HEAD".to_string());
    }
    Ok(branch)
}

async fn resolve_default_branch(workspace: &FsPath) -> anyhow::Result<String> {
    let remote_head = run_git(
        workspace,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await?;
    let value = String::from_utf8_lossy(&remote_head.stdout)
        .trim()
        .to_string();
    if let Some(branch) = value
        .strip_prefix("origin/")
        .filter(|value| !value.is_empty())
    {
        return Ok(branch.to_string());
    }

    for candidate in ["main", "master"] {
        let output = run_git(
            workspace,
            &["show-ref", "--verify", &format!("refs/heads/{candidate}")],
        )
        .await?;
        if output.status.success() {
            return Ok(candidate.to_string());
        }
    }

    resolve_current_branch(workspace).await
}

async fn collect_diff_summary(
    workspace: &FsPath,
    category: DiffCategory,
    default_branch: &str,
) -> anyhow::Result<Vec<ChangedFileSummary>> {
    let name_status_args = match category {
        DiffCategory::AgainstBase => vec!["diff", "--name-status", default_branch, "--"],
        DiffCategory::Staged => vec!["diff", "--name-status", "--cached", "--"],
        DiffCategory::Unstaged => vec!["diff", "--name-status", "--"],
        DiffCategory::Untracked => return Ok(Vec::new()),
    };
    let numstat_args = match category {
        DiffCategory::AgainstBase => vec!["diff", "--numstat", default_branch, "--"],
        DiffCategory::Staged => vec!["diff", "--numstat", "--cached", "--"],
        DiffCategory::Unstaged => vec!["diff", "--numstat", "--"],
        DiffCategory::Untracked => return Ok(Vec::new()),
    };

    let name_status = run_git(workspace, &name_status_args).await?;
    let numstat = run_git(workspace, &numstat_args).await?;
    let name_status_stdout = String::from_utf8_lossy(&name_status.stdout);
    let numstat_stdout = String::from_utf8_lossy(&numstat.stdout);

    let mut files = BTreeMap::<String, ChangedFileSummary>::new();

    for line in name_status_stdout.lines() {
        let Some(file) = parse_name_status_line(line) else {
            continue;
        };
        files.insert(file.path.clone(), file);
    }

    for line in numstat_stdout.lines() {
        let Some((path, old_path, additions, deletions)) = parse_numstat_line(line) else {
            continue;
        };
        let old_path_for_entry = old_path.clone();
        let entry = files
            .entry(path.clone())
            .or_insert_with(|| ChangedFileSummary {
                path,
                old_path: old_path_for_entry,
                status: "modified".to_string(),
                additions: 0,
                deletions: 0,
            });
        entry.additions = additions;
        entry.deletions = deletions;
        if entry.old_path.is_none() {
            entry.old_path = old_path;
        }
    }

    Ok(files.into_values().collect())
}

fn parse_name_status_line(line: &str) -> Option<ChangedFileSummary> {
    let mut parts = line.split('\t');
    let status_code = parts.next()?.trim();
    let status = normalize_changed_status(Some(status_code));

    if matches!(status.as_str(), "renamed" | "copy") {
        let old_path = sanitize_relative_path(parts.next()?).ok()?;
        let path = sanitize_relative_path(parts.next()?).ok()?;
        return Some(ChangedFileSummary {
            path,
            old_path: Some(old_path),
            status,
            additions: 0,
            deletions: 0,
        });
    }

    let path = sanitize_relative_path(parts.next()?).ok()?;
    Some(ChangedFileSummary {
        path,
        old_path: None,
        status,
        additions: 0,
        deletions: 0,
    })
}

fn parse_numstat_line(line: &str) -> Option<(String, Option<String>, usize, usize)> {
    let mut parts = line.split('\t');
    let additions = parts.next()?.parse::<usize>().ok().unwrap_or(0);
    let deletions = parts.next()?.parse::<usize>().ok().unwrap_or(0);
    let third = parts.next()?;
    let fourth = parts.next();
    if let Some(new_path) = fourth {
        return Some((
            sanitize_relative_path(new_path).ok()?,
            Some(sanitize_relative_path(third).ok()?),
            additions,
            deletions,
        ));
    }
    Some((
        sanitize_relative_path(third).ok()?,
        None,
        additions,
        deletions,
    ))
}

fn collect_untracked_paths(raw_status: &str) -> Vec<String> {
    raw_status
        .lines()
        .filter_map(|line| {
            line.trim_start()
                .strip_prefix("??")
                .map(str::trim)
                .and_then(|path| sanitize_relative_path(path).ok())
        })
        .collect()
}

fn normalize_changed_status(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("modified").trim();
    let first = normalized.chars().next().unwrap_or('M');
    match first {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copy",
        '?' => "untracked",
        'T' => "binary",
        _ => "modified",
    }
    .to_string()
}

fn sanitize_relative_path(value: &str) -> anyhow::Result<String> {
    let cleaned = value
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_string();
    anyhow::ensure!(!cleaned.is_empty(), "Path cannot be empty");
    anyhow::ensure!(
        !cleaned.contains("../"),
        "Path must stay within the session workspace"
    );
    Ok(cleaned)
}

async fn read_git_revision_content(
    workspace: &FsPath,
    revision: &str,
    path: &str,
) -> anyhow::Result<Option<Vec<u8>>> {
    let spec = format!("{revision}:{path}");
    let output = run_git(workspace, &["show", &spec]).await?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}

async fn read_git_index_content(workspace: &FsPath, path: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let spec = format!(":{path}");
    let output = run_git(workspace, &["show", &spec]).await?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(output.stdout))
}

fn read_workspace_bytes(
    workspace: &FsPath,
    relative_path: &str,
) -> anyhow::Result<Option<Vec<u8>>> {
    let resolved = workspace.join(relative_path);
    let canonical_workspace = workspace.canonicalize().ok();
    let canonical_resolved = resolved.canonicalize().ok();
    let Some(canonical_workspace) = canonical_workspace else {
        return Ok(None);
    };
    let Some(canonical_resolved) = canonical_resolved else {
        return Ok(None);
    };
    if !canonical_resolved.starts_with(&canonical_workspace) || !canonical_resolved.is_file() {
        return Ok(None);
    }
    Ok(Some(read(&resolved)?))
}

fn is_binary_content(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

fn stringify_diff_content(bytes: Option<Vec<u8>>, binary: bool) -> (Value, bool, usize) {
    const MAX_DIFF_BYTES: usize = 1024 * 1024;
    let Some(bytes) = bytes else {
        return (Value::String(String::new()), false, 0);
    };
    let size = bytes.len();
    if binary {
        return (Value::Null, false, size);
    }
    let truncated = size > MAX_DIFF_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_DIFF_BYTES)];
    (
        Value::String(String::from_utf8_lossy(slice).to_string()),
        truncated,
        size,
    )
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
