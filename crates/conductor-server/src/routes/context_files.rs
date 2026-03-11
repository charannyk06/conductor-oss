use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;

use crate::state::{resolve_board_file, AppState};
use crate::task_context::task_brief_root;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/context-files", get(list_context_files))
        .route("/api/context-files/open", post(open_context_file))
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenContextFileBody {
    project_id: String,
    path: String,
}

async fn list_context_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ContextFilesQuery>,
) -> ApiResponse {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&query.project_id) else {
        return error(
            StatusCode::NOT_FOUND,
            format!("Unknown project: {}", query.project_id),
        );
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let project_workspace_root = project
        .workspace
        .as_deref()
        .map(|configured| resolve_project_path(&state.workspace_path, configured));
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| query.project_id.clone());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_absolute = state.workspace_path.join(&board_relative);
    let attachments_root = state
        .workspace_path
        .join("attachments")
        .join(&query.project_id);
    let brief_root = task_brief_root(&project_root);
    let board_parent = board_absolute.parent().map(Path::to_path_buf);
    let markdown_editor = config.preferences.markdown_editor.trim();
    let markdown_root = resolve_markdown_root(
        &state.workspace_path,
        &config.preferences.markdown_editor_path,
    );
    let use_local_markdown_sources = uses_local_markdown_sources(markdown_editor);
    let markdown_source = markdown_source_label(markdown_editor);

    let mut files = Vec::new();
    if board_absolute.exists() {
        files.push(file_descriptor(
            &board_absolute,
            &state.workspace_path,
            None,
            Some("board"),
        ));
    }
    if use_local_markdown_sources {
        if let Some(root) = markdown_root.as_deref() {
            collect_project_files(
                root,
                &state.workspace_path,
                Some(root),
                markdown_source,
                &mut files,
                1200,
                8,
            );
        } else {
            if let Some(root) = board_parent.as_deref() {
                collect_project_files(
                    root,
                    &state.workspace_path,
                    None,
                    markdown_source,
                    &mut files,
                    600,
                    6,
                );
            }
            if board_parent.as_deref() != Some(state.workspace_path.as_path()) {
                collect_project_files(
                    &state.workspace_path,
                    &state.workspace_path,
                    None,
                    markdown_source,
                    &mut files,
                    600,
                    6,
                );
            }
        }
    }
    if let Some(root) = project_workspace_root.as_deref() {
        if root != project_root.as_path()
            && root != state.workspace_path.as_path()
            && board_parent.as_deref() != Some(root)
        {
            collect_project_files(
                root,
                &state.workspace_path,
                None,
                "workspace",
                &mut files,
                250,
                4,
            );
        }
    }
    collect_project_files(
        &project_root,
        &state.workspace_path,
        None,
        "project",
        &mut files,
        250,
        4,
    );
    collect_project_files(
        &attachments_root,
        &state.workspace_path,
        None,
        "attachment",
        &mut files,
        250,
        4,
    );
    collect_project_files(
        &brief_root,
        &state.workspace_path,
        None,
        "brief",
        &mut files,
        250,
        4,
    );

    files.sort_by(|left, right| {
        left["path"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["path"].as_str().unwrap_or_default())
            .then_with(|| {
                source_sort_rank(left["source"].as_str().unwrap_or_default()).cmp(
                    &source_sort_rank(right["source"].as_str().unwrap_or_default()),
                )
            })
    });
    files.dedup_by(|left, right| left["path"] == right["path"]);
    files.sort_by(|left, right| {
        source_sort_rank(left["source"].as_str().unwrap_or_default())
            .cmp(&source_sort_rank(
                right["source"].as_str().unwrap_or_default(),
            ))
            .then_with(|| {
                left["path"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["path"].as_str().unwrap_or_default())
            })
    });
    ok(json!({ "files": files }))
}

async fn open_context_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OpenContextFileBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() || body.path.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId and path are required");
    }

    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&body.project_id) else {
        return error(
            StatusCode::NOT_FOUND,
            format!("Unknown project: {}", body.project_id),
        );
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let project_workspace_root = project
        .workspace
        .as_deref()
        .map(|configured| resolve_project_path(&state.workspace_path, configured));
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| body.project_id.clone());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_absolute = state.workspace_path.join(&board_relative);
    let board_parent = board_absolute.parent().map(Path::to_path_buf);
    let attachments_root = state
        .workspace_path
        .join("attachments")
        .join(&body.project_id);
    let brief_root = task_brief_root(&project_root);
    let markdown_editor = config.preferences.markdown_editor.trim();
    let markdown_root = resolve_markdown_root(
        &state.workspace_path,
        &config.preferences.markdown_editor_path,
    );

    let requested = resolve_requested_path(&state.workspace_path, &body.path);
    if !requested.exists() {
        return error(
            StatusCode::NOT_FOUND,
            format!("Context file does not exist: {}", body.path),
        );
    }

    let mut allowed_roots = vec![project_root, attachments_root, brief_root];
    if let Some(root) = project_workspace_root {
        allowed_roots.push(root);
    }
    if let Some(root) = board_parent {
        allowed_roots.push(root);
    }
    if let Some(root) = markdown_root {
        allowed_roots.push(root);
    } else if uses_local_markdown_sources(markdown_editor) {
        allowed_roots.push(state.workspace_path.clone());
    }

    if !path_is_within_roots(&requested, &allowed_roots) {
        return error(
            StatusCode::FORBIDDEN,
            format!("Context file is outside the allowed roots: {}", body.path),
        );
    }

    match launch_context_file(markdown_editor, &requested).await {
        Ok(()) => ok(json!({ "opened": true })),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn collect_project_files(
    root: &Path,
    workspace_root: &Path,
    display_root: Option<&Path>,
    source: &str,
    out: &mut Vec<Value>,
    max_files: usize,
    max_depth: usize,
) {
    if !root.exists() {
        return;
    }

    let initial_len = out.len();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if out.len().saturating_sub(initial_len) >= max_files {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                let hidden_dir = name.starts_with('.') && name != ".github";
                if depth < max_depth
                    && !hidden_dir
                    && !matches!(
                        name.as_str(),
                        "node_modules" | "target" | "dist" | "build" | ".next"
                    )
                {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            if !is_candidate_file(&path) {
                continue;
            }
            out.push(file_descriptor(
                &path,
                workspace_root,
                display_root,
                Some(source),
            ));
            if out.len().saturating_sub(initial_len) >= max_files {
                break;
            }
        }
    }
}

fn file_descriptor(
    path: &Path,
    workspace_root: &Path,
    display_root: Option<&Path>,
    source: Option<&str>,
) -> Value {
    let actual_path = display_path_for_root(workspace_root, path);
    let display_path = display_root
        .map(|root| display_path_for_root(root, path))
        .unwrap_or_else(|| actual_path.clone());
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&display_path)
        .to_string();
    let size_bytes = std::fs::metadata(path).ok().map(|value| value.len());
    json!({
        "path": actual_path,
        "displayPath": display_path,
        "name": name,
        "kind": if is_image(path) { "image" } else { "file" },
        "source": source,
        "sizeBytes": size_bytes,
    })
}

fn display_path_for_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn resolve_project_path(workspace_root: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    }
}

fn resolve_requested_path(workspace_root: &Path, path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    }
}

fn resolve_markdown_root(workspace_root: &Path, configured: &str) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(resolve_project_path(workspace_root, trimmed))
    }
}

fn uses_local_markdown_sources(editor: &str) -> bool {
    let normalized = editor.trim();
    !normalized.is_empty() && !normalized.eq_ignore_ascii_case("notion")
}

fn markdown_source_label(editor: &str) -> &'static str {
    if editor.trim().eq_ignore_ascii_case("obsidian") {
        "vault"
    } else if editor.trim().eq_ignore_ascii_case("logseq") {
        "graph"
    } else {
        "notes"
    }
}

fn source_sort_rank(source: &str) -> usize {
    match source {
        "board" => 0,
        "vault" | "graph" | "notes" => 1,
        "brief" => 2,
        "workspace" => 3,
        "project" => 4,
        "attachment" => 5,
        _ => 6,
    }
}

fn path_is_within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    let canonical_path = canonicalize_for_access(path);
    roots.iter().any(|root| {
        let canonical_root = canonicalize_for_access(root);
        canonical_path == canonical_root || canonical_path.starts_with(&canonical_root)
    })
}

fn canonicalize_for_access(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn should_use_markdown_editor_integration(editor: &str, path: &Path) -> bool {
    uses_local_markdown_sources(editor) && is_markdown_like(path)
}

fn is_markdown_like(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "mdx" | "txt")
}

async fn launch_context_file(editor: &str, path: &Path) -> anyhow::Result<()> {
    let path_string = path.to_string_lossy().to_string();

    if cfg!(target_os = "macos") {
        let args = if should_use_markdown_editor_integration(editor, path) {
            if let Some(app_name) = markdown_editor_app_name(editor) {
                vec!["-a".to_string(), app_name.to_string(), path_string]
            } else {
                vec![path_string]
            }
        } else {
            vec![path_string]
        };
        return run_open_command("open", args).await;
    }

    if cfg!(target_os = "windows") {
        if should_use_markdown_editor_integration(editor, path)
            && editor.trim().eq_ignore_ascii_case("vscode")
            && try_open_command("code", vec![path_string.clone()]).await?
        {
            return Ok(());
        }
        return run_open_command(
            "cmd",
            vec![
                "/C".to_string(),
                "start".to_string(),
                String::new(),
                path_string,
            ],
        )
        .await;
    }

    if should_use_markdown_editor_integration(editor, path) {
        if let Some(command) = markdown_editor_command(editor) {
            if try_open_command(command, vec![path_string.clone()]).await? {
                return Ok(());
            }
        }
    }

    run_open_command("xdg-open", vec![path_string]).await
}

fn markdown_editor_app_name(editor: &str) -> Option<&'static str> {
    if editor.trim().eq_ignore_ascii_case("obsidian") {
        Some("Obsidian")
    } else if editor.trim().eq_ignore_ascii_case("vscode") {
        Some("Visual Studio Code")
    } else if editor.trim().eq_ignore_ascii_case("typora") {
        Some("Typora")
    } else if editor.trim().eq_ignore_ascii_case("logseq") {
        Some("Logseq")
    } else {
        None
    }
}

fn markdown_editor_command(editor: &str) -> Option<&'static str> {
    if editor.trim().eq_ignore_ascii_case("obsidian") {
        Some("obsidian")
    } else if editor.trim().eq_ignore_ascii_case("vscode") {
        Some("code")
    } else if editor.trim().eq_ignore_ascii_case("typora") {
        Some("typora")
    } else if editor.trim().eq_ignore_ascii_case("logseq") {
        Some("logseq")
    } else {
        None
    }
}

async fn try_open_command(program: &str, args: Vec<String>) -> anyhow::Result<bool> {
    match Command::new(program).args(&args).status().await {
        Ok(status) => {
            if status.success() {
                Ok(true)
            } else {
                anyhow::bail!("Opening context file failed via {}", program);
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

async fn run_open_command(program: &str, args: Vec<String>) -> anyhow::Result<()> {
    if try_open_command(program, args).await? {
        Ok(())
    } else {
        anyhow::bail!("Required opener is not installed: {}", program)
    }
}

fn is_candidate_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "txt"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
    )
}

fn is_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tiff"
    )
}

#[cfg(test)]
mod tests {
    use super::{display_path_for_root, file_descriptor};
    use std::env;

    #[test]
    fn display_path_for_root_prefers_relative_path_when_root_matches() {
        let root = env::temp_dir().join("obsidian-vault");
        let path = root.join("projects").join("careai").join("CONDUCTOR.md");

        assert_eq!(
            display_path_for_root(&root, &path),
            "projects/careai/CONDUCTOR.md"
        );
    }

    #[test]
    fn file_descriptor_keeps_actual_path_and_separate_display_path() {
        let workspace_root = env::temp_dir().join("conductor");
        let vault_root = env::temp_dir().join("obsidian-vault");
        let path = vault_root
            .join("projects")
            .join("careai")
            .join("CONDUCTOR.md");

        let descriptor = file_descriptor(&path, &workspace_root, Some(&vault_root), Some("vault"));

        assert_eq!(
            descriptor["path"].as_str(),
            Some(path.to_string_lossy().as_ref())
        );
        assert_eq!(
            descriptor["displayPath"].as_str(),
            Some("projects/careai/CONDUCTOR.md")
        );
    }
}
