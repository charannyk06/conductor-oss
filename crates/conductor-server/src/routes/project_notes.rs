use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Datelike;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use url::Url;
use uuid::Uuid;

use crate::state::{resolve_board_file, AppState};

const MAX_NOTE_FILE_BYTES: usize = 1024 * 1024;
const MAX_NOTE_COUNT: usize = 2500;
const MAX_NOTE_DEPTH: usize = 10;
const TAG_SCAN_BYTES: usize = 64 * 1024;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/project-notes", get(list_project_notes))
        .route(
            "/api/project-notes/file",
            get(get_project_note_file).put(save_project_note_file),
        )
        .route("/api/project-notes/open", post(open_project_note))
        .route("/api/project-notes/backlinks", get(get_backlinks))
        .route("/api/project-notes/daily", post(create_daily_note))
        .route("/api/project-notes/graph", get(get_notes_graph))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectNotesQuery {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectNoteFileQuery {
    project_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProjectNoteBody {
    project_id: String,
    path: String,
    content: String,
    expected_modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenProjectNoteBody {
    project_id: String,
    path: String,
}

#[derive(Debug, Clone)]
struct ProjectNotesContext {
    workspace_root: PathBuf,
    project_root: PathBuf,
    project_workspace_root: Option<PathBuf>,
    board_path: Option<PathBuf>,
    board_parent: Option<PathBuf>,
    editor: String,
    notes_root: Option<PathBuf>,
    source_label: &'static str,
    writable: bool,
}

async fn list_project_notes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProjectNotesQuery>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &query.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return ok(json!({
            "editor": context.editor,
            "notesRoot": context.notes_root.as_ref().map(|path| path.to_string_lossy().to_string()),
            "syncManagedByEditor": false,
            "writable": false,
            "files": [],
        }));
    }

    let files = collect_indexed_note_files(&context);

    // Build tags and forwardLinks maps by scanning file contents
    let (tags, forward_links) = {
        let files_snapshot = files.clone();
        tokio::task::spawn_blocking(move || build_tags_and_forward_links(&files_snapshot))
            .await
            .unwrap_or_default()
    };

    ok(json!({
        "editor": context.editor,
        "notesRoot": context.notes_root.as_ref().map(|path| path.to_string_lossy().to_string()),
        "syncManagedByEditor": context.editor.trim().eq_ignore_ascii_case("obsidian") && context.notes_root.is_some(),
        "writable": true,
        "files": files,
        "tags": tags,
        "forwardLinks": forward_links,
    }))
}

async fn get_project_note_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProjectNoteFileQuery>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &query.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return error(
            StatusCode::BAD_REQUEST,
            "The selected markdown editor does not support local notes.",
        );
    }

    let path = match resolve_requested_note_path(&context, &query.path, false) {
        Ok(path) => path,
        Err(response) => return response,
    };
    if !path.exists() || !path.is_file() {
        return error(StatusCode::NOT_FOUND, "Note file not found");
    }

    match read_note_file_payload(&path, &context) {
        Ok(payload) => ok(payload),
        Err(response) => response,
    }
}

async fn save_project_note_file(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveProjectNoteBody>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &body.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return error(
            StatusCode::BAD_REQUEST,
            "The selected markdown editor does not support local notes.",
        );
    }

    let path = match resolve_requested_note_path(&context, &body.path, true) {
        Ok(path) => path,
        Err(response) => return response,
    };

    let current_modified_at = file_modified_at(&path);
    if let Some(expected_modified_at) = body
        .expected_modified_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if current_modified_at.as_deref() != Some(expected_modified_at) {
            return error(
                StatusCode::CONFLICT,
                "The note changed on disk. Reload it before saving again.",
            );
        }
    }

    let parent = match path.parent() {
        Some(parent) => parent,
        None => {
            return error(
                StatusCode::BAD_REQUEST,
                "Note path must be inside a writable notes folder.",
            )
        }
    };
    if let Err(err) = fs::create_dir_all(parent) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    if let Err(err) = atomic_write_text_file(&path, &body.content) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    ok(json!({
        "ok": true,
        "path": path.to_string_lossy().to_string(),
        "displayPath": display_path_for_note(&context, &path),
        "modifiedAt": file_modified_at(&path),
        "savedBytes": body.content.len(),
        "created": current_modified_at.is_none(),
    }))
}

async fn open_project_note(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OpenProjectNoteBody>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &body.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return error(
            StatusCode::BAD_REQUEST,
            "The selected markdown editor does not support local notes.",
        );
    }

    let path = match resolve_requested_note_path(&context, &body.path, false) {
        Ok(path) => path,
        Err(response) => return response,
    };
    if !path.exists() || !path.is_file() {
        return error(StatusCode::NOT_FOUND, "Note file not found");
    }

    match launch_project_note(&context.editor, &path).await {
        Ok(opened_via) => ok(json!({ "opened": true, "path": path, "openedVia": opened_via })),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn resolve_project_notes_context(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<ProjectNotesContext, ApiResponse> {
    let trimmed_project_id = project_id.trim();
    if trimmed_project_id.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "projectId is required"));
    }

    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(trimmed_project_id) else {
        return Err(error(
            StatusCode::NOT_FOUND,
            format!("Unknown project: {trimmed_project_id}"),
        ));
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let project_workspace_root = project
        .workspace
        .as_deref()
        .map(|configured| resolve_project_path(&state.workspace_path, configured));
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| trimmed_project_id.to_string());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(board_relative);
    let board_parent = board_path.parent().map(Path::to_path_buf);
    let editor = config.preferences.markdown_editor.trim().to_string();
    let notes_root = resolve_notes_root(
        &state.workspace_path,
        &config.preferences.markdown_editor_path,
    );

    Ok(ProjectNotesContext {
        workspace_root: state.workspace_path.clone(),
        project_root,
        project_workspace_root,
        board_path: Some(board_path),
        board_parent,
        editor: editor.clone(),
        notes_root,
        source_label: markdown_source_label(&editor),
        writable: uses_local_markdown_sources(&editor),
    })
}

fn resolve_project_path(workspace_root: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    }
}

fn resolve_notes_root(workspace_root: &Path, configured: &str) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix("~/") {
        if let Some(home) = resolve_user_home_dir() {
            return Some(home.join(stripped));
        }
    }
    let candidate = PathBuf::from(trimmed);
    Some(if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    })
}

fn resolve_user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn uses_local_markdown_sources(editor: &str) -> bool {
    !editor.trim().is_empty() && !editor.trim().eq_ignore_ascii_case("notion")
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
        _ => 2,
    }
}

fn collect_indexed_note_files(context: &ProjectNotesContext) -> Vec<Value> {
    let mut files = Vec::new();
    if let Some(board_path) = context.board_path.as_deref().filter(|path| path.exists()) {
        files.push(note_descriptor(
            board_path,
            board_path.parent(),
            Some("board"),
            Some("Board/CONDUCTOR.md"),
        ));
    }

    let discovery_roots: Vec<PathBuf> = if let Some(notes_root) = context.notes_root.as_ref() {
        vec![notes_root.clone()]
    } else {
        allowed_note_roots(context)
    };

    for root in discovery_roots {
        collect_note_files(
            &root,
            Some(&root),
            context.source_label,
            &mut files,
            MAX_NOTE_COUNT,
            MAX_NOTE_DEPTH,
        );
        if files.len() >= MAX_NOTE_COUNT {
            break;
        }
    }

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
            .then_with(|| {
                left["displayPath"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["displayPath"].as_str().unwrap_or_default())
            })
    });
    files.dedup_by(|left, right| left["path"] == right["path"]);
    files
}

fn collect_note_files(
    root: &Path,
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
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if out.len().saturating_sub(initial_len) >= max_files {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() || !path_is_within_root(&path, root, false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
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
            if !file_type.is_file() || !is_markdown_like(&path) {
                continue;
            }
            out.push(note_descriptor(&path, display_root, Some(source), None));
            if out.len().saturating_sub(initial_len) >= max_files {
                break;
            }
        }
    }
}

fn note_descriptor(
    path: &Path,
    display_root: Option<&Path>,
    source: Option<&str>,
    display_override: Option<&str>,
) -> Value {
    let canonical_path = canonicalize_for_access(path);
    let display_path = display_override
        .map(str::to_string)
        .or_else(|| {
            display_root.map(|root| {
                let canonical_root = canonicalize_for_access(root);
                canonical_path
                    .strip_prefix(&canonical_root)
                    .or_else(|_| path.strip_prefix(root))
                    .map(|value| value.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| canonical_path.to_string_lossy().to_string())
            })
        })
        .unwrap_or_else(|| canonical_path.to_string_lossy().to_string());

    json!({
        "path": canonical_path.to_string_lossy().to_string(),
        "displayPath": display_path,
        "name": canonical_path.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
        "source": source,
        "sizeBytes": fs::metadata(&canonical_path).ok().map(|value| value.len()),
        "modifiedAt": file_modified_at(&canonical_path),
        "kind": "file",
    })
}

fn display_path_for_note(context: &ProjectNotesContext, path: &Path) -> String {
    if let Some(notes_root) = context.notes_root.as_deref() {
        if path.starts_with(notes_root) {
            return path
                .strip_prefix(notes_root)
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().to_string());
        }
    }
    if context
        .board_path
        .as_deref()
        .map(|board| canonicalize_for_access(board) == canonicalize_for_access(path))
        .unwrap_or(false)
    {
        return "Board/CONDUCTOR.md".to_string();
    }
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn resolve_requested_note_path(
    context: &ProjectNotesContext,
    requested_path: &str,
    create_mode: bool,
) -> Result<PathBuf, ApiResponse> {
    let trimmed = requested_path.trim();
    if trimmed.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "path is required"));
    }

    let candidate = PathBuf::from(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        preferred_notes_root(context).join(candidate)
    };

    if !is_markdown_like(&resolved) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Only markdown and plaintext note files can be accessed here.",
        ));
    }

    if path_is_project_board(context, &resolved) {
        return Ok(resolved);
    }

    if !path_within_allowed_note_roots(context, &resolved, create_mode) {
        return Err(error(
            StatusCode::FORBIDDEN,
            format!(
                "Note path is outside the allowed roots: {}",
                resolved.display()
            ),
        ));
    }

    Ok(resolved)
}

fn preferred_notes_root(context: &ProjectNotesContext) -> PathBuf {
    context
        .notes_root
        .clone()
        .or_else(|| context.project_workspace_root.clone())
        .unwrap_or_else(|| context.project_root.clone())
}

fn path_is_project_board(context: &ProjectNotesContext, candidate: &Path) -> bool {
    match context.board_path.as_deref() {
        Some(board_path) => {
            canonicalize_for_write_target(candidate) == canonicalize_for_write_target(board_path)
        }
        None => false,
    }
}

fn path_within_allowed_note_roots(
    context: &ProjectNotesContext,
    candidate: &Path,
    create_mode: bool,
) -> bool {
    allowed_note_roots(context)
        .into_iter()
        .any(|root| path_is_within_root(candidate, &root, create_mode))
}

fn allowed_note_roots(context: &ProjectNotesContext) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(notes_root) = context.notes_root.as_ref() {
        roots.push(notes_root.clone());
    } else {
        if let Some(project_workspace_root) = context.project_workspace_root.as_ref() {
            roots.push(project_workspace_root.clone());
        }
        roots.push(context.project_root.clone());
        if let Some(board_parent) = context.board_parent.as_ref() {
            roots.push(board_parent.clone());
        }
        roots.push(context.workspace_root.clone());
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| {
            let canonical = canonicalize_for_access(root).to_string_lossy().to_string();
            seen.insert(canonical)
        })
        .collect()
}

fn path_is_within_root(candidate: &Path, root: &Path, create_mode: bool) -> bool {
    let candidate = if create_mode {
        canonicalize_for_write_target(candidate)
    } else {
        canonicalize_for_access(candidate)
    };
    let root = canonicalize_for_access(root);
    candidate == root || candidate.starts_with(&root)
}

fn canonicalize_for_access(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn canonicalize_for_write_target(path: &Path) -> PathBuf {
    if path.exists() {
        return canonicalize_for_access(path);
    }

    let mut existing_ancestor = path.parent();
    while let Some(ancestor) = existing_ancestor {
        if ancestor.exists() {
            let canonical_ancestor = canonicalize_for_access(ancestor);
            if let Ok(relative) = path.strip_prefix(ancestor) {
                return canonical_ancestor.join(relative);
            }
            break;
        }
        existing_ancestor = ancestor.parent();
    }
    path.to_path_buf()
}

fn read_note_file_payload(
    path: &Path,
    context: &ProjectNotesContext,
) -> Result<Value, ApiResponse> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Err(error(StatusCode::NOT_FOUND, "Note file not found"));
        }
        Err(err) => return Err(error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())),
    };

    let size = raw.len();
    let binary = raw.iter().take(8000).any(|byte| *byte == 0);
    if binary {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "The selected note file is binary and cannot be edited as markdown.",
        ));
    }

    let truncated = size > MAX_NOTE_FILE_BYTES;
    let content = String::from_utf8_lossy(&raw[..raw.len().min(MAX_NOTE_FILE_BYTES)]).to_string();
    Ok(json!({
        "path": path.to_string_lossy().to_string(),
        "displayPath": display_path_for_note(context, path),
        "content": content,
        "size": size,
        "truncated": truncated,
        "modifiedAt": file_modified_at(path),
        "writable": true,
    }))
}

fn atomic_write_text_file(path: &Path, content: &str) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("note path must have a parent directory"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("note.md");
    let temp_path = parent.join(format!(
        ".{file_name}.{}.conductor-note.tmp",
        Uuid::new_v4().simple()
    ));
    fs::write(&temp_path, content.as_bytes())?;

    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path)?;
    }

    fs::rename(&temp_path, path)?;
    Ok(())
}

fn file_modified_at(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339())
}

fn is_markdown_like(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "mdx" | "txt")
}

async fn launch_project_note(editor: &str, path: &Path) -> anyhow::Result<&'static str> {
    if editor.trim().eq_ignore_ascii_case("obsidian") {
        if let Some(uri) = build_obsidian_open_uri(path) {
            if try_open_uri(&uri).await? {
                return Ok("obsidian_uri");
            }
        }
    }

    launch_path_in_editor(editor, path).await?;
    Ok("editor")
}

fn build_obsidian_open_uri(path: &Path) -> Option<String> {
    let absolute = path.canonicalize().ok()?;
    let mut uri = Url::parse("obsidian://open").ok()?;
    uri.query_pairs_mut()
        .append_pair("path", absolute.to_string_lossy().as_ref());
    Some(uri.to_string())
}

async fn try_open_uri(uri: &str) -> anyhow::Result<bool> {
    if cfg!(target_os = "macos") {
        return try_open_command("open", vec![uri.to_string()]).await;
    }
    if cfg!(target_os = "windows") {
        return try_open_command(
            "cmd",
            vec![
                "/C".to_string(),
                "start".to_string(),
                String::new(),
                uri.to_string(),
            ],
        )
        .await;
    }
    try_open_command("xdg-open", vec![uri.to_string()]).await
}

async fn launch_path_in_editor(editor: &str, path: &Path) -> anyhow::Result<()> {
    let path_string = path.to_string_lossy().to_string();

    if cfg!(target_os = "macos") {
        let args = if let Some(app_name) = markdown_editor_app_name(editor) {
            vec!["-a".to_string(), app_name.to_string(), path_string]
        } else {
            vec![path_string]
        };
        return run_open_command("open", args).await;
    }

    if cfg!(target_os = "windows") {
        if editor.trim().eq_ignore_ascii_case("vscode")
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

    if let Some(command) = markdown_editor_command(editor) {
        if try_open_command(command, vec![path_string.clone()]).await? {
            return Ok(());
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
        Ok(status) => Ok(status.success()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

async fn run_open_command(program: &str, args: Vec<String>) -> anyhow::Result<()> {
    if try_open_command(program, args).await? {
        Ok(())
    } else {
        anyhow::bail!("Required opener is not installed: {program}")
    }
}

// ---------------------------------------------------------------------------
// Tag & wikilink extraction helpers
// ---------------------------------------------------------------------------

/// Extract tags and wikilinks from the first 64KB of each file in the index.
/// Returns `(tags_map, forward_links_map)` as serde_json::Value objects.
fn build_tags_and_forward_links(files: &[Value]) -> (Value, Value) {
    let tag_re = Regex::new(r"(?m)(?:^|[\s(])#([a-zA-Z][\w-]*)").expect("tag regex");
    let wikilink_re = Regex::new(r"\[\[([^\]]+)\]\]").expect("wikilink regex");
    let header_re = Regex::new(r"^#\s").expect("header regex");

    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    let mut forward_links: HashMap<String, Vec<String>> = HashMap::new();

    for file in files {
        let path_str = match file["path"].as_str() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let path = PathBuf::from(&path_str);

        let content = match fs::read(&path) {
            Ok(bytes) => {
                let limit = bytes.len().min(TAG_SCAN_BYTES);
                String::from_utf8_lossy(&bytes[..limit]).to_string()
            }
            Err(_) => continue,
        };

        // Extract wikilinks
        let mut file_links: Vec<String> = Vec::new();
        for cap in wikilink_re.captures_iter(&content) {
            if let Some(m) = cap.get(1) {
                file_links.push(m.as_str().trim().to_string());
            }
        }
        if !file_links.is_empty() {
            forward_links.insert(path_str.clone(), file_links);
        }

        // Extract tags, but only from non-header lines
        let mut file_tags: HashSet<String> = HashSet::new();
        for line in content.lines() {
            // Skip markdown headers (lines starting with "# ")
            if header_re.is_match(line) {
                continue;
            }
            for cap in tag_re.captures_iter(line) {
                if let Some(m) = cap.get(1) {
                    file_tags.insert(m.as_str().to_string());
                }
            }
        }
        for tag in file_tags {
            tags.entry(tag).or_default().push(path_str.clone());
        }
    }

    let tags_json = serde_json::to_value(&tags).unwrap_or(json!({}));
    let links_json = serde_json::to_value(&forward_links).unwrap_or(json!({}));
    (tags_json, links_json)
}

/// Read the first `limit` bytes of a file as a string. Returns None on error.
fn read_file_head(path: &Path, limit: usize) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let end = bytes.len().min(limit);
    Some(String::from_utf8_lossy(&bytes[..end]).to_string())
}

/// Extract wikilink targets from markdown content.
fn extract_wikilinks(content: &str) -> Vec<String> {
    let re = Regex::new(r"\[\[([^\]]+)\]\]").expect("wikilink regex");
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
        .collect()
}

/// Extract tags from markdown content (excluding headers).
fn extract_tags(content: &str) -> Vec<String> {
    let tag_re = Regex::new(r"(?:^|[\s(])#([a-zA-Z][\w-]*)").expect("tag regex");
    let header_re = Regex::new(r"^#\s").expect("header regex");
    let mut tags = HashSet::new();
    for line in content.lines() {
        if header_re.is_match(line) {
            continue;
        }
        for cap in tag_re.captures_iter(line) {
            if let Some(m) = cap.get(1) {
                tags.insert(m.as_str().to_string());
            }
        }
    }
    tags.into_iter().collect()
}

/// Get the note name without extension from a file path.
fn note_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// Build a file index mapping lowercase note name → absolute path.
fn build_note_name_index(files: &[Value]) -> HashMap<String, PathBuf> {
    let mut index: HashMap<String, PathBuf> = HashMap::new();
    for file in files {
        if let Some(p) = file["path"].as_str() {
            let path = PathBuf::from(p);
            let name = note_name_from_path(&path);
            if !name.is_empty() {
                index.entry(name.to_ascii_lowercase()).or_insert(path);
            }
        }
    }
    index
}

// ---------------------------------------------------------------------------
// GET /api/project-notes/backlinks
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BacklinksQuery {
    project_id: String,
    path: String,
}

async fn get_backlinks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BacklinksQuery>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &query.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return error(
            StatusCode::BAD_REQUEST,
            "The selected markdown editor does not support local notes.",
        );
    }

    let current_path = match resolve_requested_note_path(&context, &query.path, false) {
        Ok(path) => path,
        Err(response) => return response,
    };

    let note_name = note_name_from_path(&current_path);
    if note_name.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "Cannot determine note name from path",
        );
    }

    // Read forward links from current file
    let current_content = read_file_head(&current_path, MAX_NOTE_FILE_BYTES);
    let forward_links: Vec<String> = current_content
        .as_deref()
        .map(extract_wikilinks)
        .unwrap_or_default();

    // Collect all note files and scan for backlinks
    let backlinks = {
        let note_name_clone = note_name.clone();
        let current_path_str = current_path.to_string_lossy().to_string();
        let files_clone = collect_indexed_note_files(&context);
        tokio::task::spawn_blocking(move || {
            scan_backlinks(&files_clone, &note_name_clone, &current_path_str)
        })
        .await
        .unwrap_or_default()
    };

    ok(json!({
        "backlinks": backlinks,
        "forwardLinks": forward_links,
    }))
}

/// Scan files for backlinks to the given note name. Returns backlink entries
/// with ~100 chars of context around each match.
fn scan_backlinks(files: &[Value], note_name: &str, current_path: &str) -> Vec<Value> {
    let wikilink_re = Regex::new(r"\[\[([^\]]+)\]\]").expect("wikilink regex");
    let note_name_lower = note_name.to_ascii_lowercase();
    let mut results: Vec<Value> = Vec::new();

    for file in files {
        let path_str = match file["path"].as_str() {
            Some(p) => p,
            None => continue,
        };
        // Skip self-referencing
        if path_str == current_path {
            continue;
        }

        let display_path = file["displayPath"].as_str().unwrap_or_default().to_string();
        let name = file["name"].as_str().unwrap_or_default().to_string();

        let content = match read_file_head(&PathBuf::from(path_str), MAX_NOTE_FILE_BYTES) {
            Some(c) => c,
            None => continue,
        };

        for cap in wikilink_re.captures_iter(&content) {
            let target = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if target.to_ascii_lowercase() != note_name_lower {
                continue;
            }

            let full_match = cap.get(0).unwrap();
            let match_start = full_match.start();
            let match_end = full_match.end();

            // Get ~100 chars of context around the match
            let ctx_start = match_start.saturating_sub(50);
            let ctx_end = (match_end + 50).min(content.len());
            let context = content[ctx_start..ctx_end].replace('\n', " ");

            results.push(json!({
                "path": path_str,
                "displayPath": display_path,
                "name": name,
                "context": context,
            }));
            // Only one backlink entry per file
            break;
        }
    }

    results
}

// ---------------------------------------------------------------------------
// POST /api/project-notes/daily
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDailyNoteBody {
    project_id: String,
}

async fn create_daily_note(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateDailyNoteBody>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &body.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return error(
            StatusCode::BAD_REQUEST,
            "The selected markdown editor does not support local notes.",
        );
    }

    let now = chrono::Utc::now();
    let date_str = format!("{}-{:02}-{:02}", now.year(), now.month(), now.day());
    let relative_path = format!("daily/{}.md", date_str);
    let seed_content = format!("# {}\n\n", date_str);

    let full_path = match resolve_requested_note_path(&context, &relative_path, true) {
        Ok(path) => path,
        Err(response) => return response,
    };

    let created = if full_path.exists() {
        false
    } else {
        let parent = match full_path.parent() {
            Some(p) => p,
            None => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Daily note path must be inside a writable notes folder.",
                )
            }
        };
        if let Err(err) = fs::create_dir_all(parent) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
        }
        if let Err(err) = atomic_write_text_file(&full_path, &seed_content) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
        }
        true
    };

    ok(json!({
        "path": full_path.to_string_lossy().to_string(),
        "displayPath": display_path_for_note(&context, &full_path),
        "created": created,
    }))
}

// ---------------------------------------------------------------------------
// GET /api/project-notes/graph
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphQuery {
    project_id: String,
}

async fn get_notes_graph(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GraphQuery>,
) -> ApiResponse {
    let context = match resolve_project_notes_context(&state, &query.project_id).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    if !context.writable {
        return ok(json!({ "nodes": [], "edges": [] }));
    }

    let graph_data = {
        let files_snapshot = collect_indexed_note_files(&context);
        tokio::task::spawn_blocking(move || build_graph_data(&files_snapshot))
            .await
            .unwrap_or_else(|_| (json!([]), json!([])))
    };

    ok(json!({
        "nodes": graph_data.0,
        "edges": graph_data.1,
    }))
}

/// Build graph nodes and edges from the file index.
fn build_graph_data(files: &[Value]) -> (Value, Value) {
    let note_name_index = build_note_name_index(files);
    let wikilink_re = Regex::new(r"\[\[([^\]]+)\]\]").expect("wikilink regex");

    let mut nodes: Vec<Value> = Vec::new();
    let mut edges: Vec<Value> = Vec::new();

    for file in files {
        let path_str = match file["path"].as_str() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let path = PathBuf::from(&path_str);
        let name = file["name"].as_str().unwrap_or_default().to_string();

        // Read content for tags and wikilinks
        let content = read_file_head(&path, TAG_SCAN_BYTES);
        let tags: Vec<String> = content.as_deref().map(extract_tags).unwrap_or_default();

        nodes.push(json!({
            "id": path_str,
            "name": name,
            "tags": tags,
        }));

        // Extract wikilinks and resolve to actual paths
        if let Some(ref content) = content {
            for cap in wikilink_re.captures_iter(content) {
                let target = match cap.get(1) {
                    Some(m) => m.as_str().trim().to_string(),
                    None => continue,
                };

                // Try to resolve: first by exact path match in files, then by name match
                let resolved = resolve_wikilink_target(&target, files, &note_name_index);
                if let Some(resolved_path) = resolved {
                    edges.push(json!({
                        "source": path_str,
                        "target": resolved_path,
                    }));
                }
            }
        }
    }

    (json!(nodes), json!(edges))
}

/// Resolve a wikilink target to an actual file path. Tries:
/// 1. Direct match against file paths (if the target looks like a relative path)
/// 2. Case-insensitive match by note name (stem without extension)
fn resolve_wikilink_target(
    target: &str,
    files: &[Value],
    name_index: &HashMap<String, PathBuf>,
) -> Option<String> {
    let target_lower = target.to_ascii_lowercase();

    // Try direct path suffix match against known files
    for file in files {
        if let Some(p) = file["path"].as_str() {
            let p_lower = p.to_ascii_lowercase();
            // Check if target matches the end of a path (with or without .md extension)
            if p_lower.ends_with(&format!("/{}", target_lower))
                || p_lower.ends_with(&format!("/{}.md", target_lower))
                || p_lower == target_lower
                || p_lower == format!("{}.md", target_lower)
            {
                return Some(p.to_string());
            }
        }
    }

    // Try name-based lookup (stem only)
    let stem = if target_lower.ends_with(".md") {
        target_lower.trim_end_matches(".md").to_string()
    } else {
        target_lower.clone()
    };

    if let Some(resolved) = name_index.get(&stem) {
        return Some(resolved.to_string_lossy().to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        build_obsidian_open_uri, canonicalize_for_write_target, is_markdown_like,
        markdown_source_label,
    };
    use std::fs;

    #[test]
    fn markdown_source_label_matches_known_editors() {
        assert_eq!(markdown_source_label("obsidian"), "vault");
        assert_eq!(markdown_source_label("logseq"), "graph");
        assert_eq!(markdown_source_label("vscode"), "notes");
    }

    #[test]
    fn markdown_like_extensions_are_allowed() {
        assert!(is_markdown_like(std::path::Path::new("notes/design.md")));
        assert!(is_markdown_like(std::path::Path::new("notes/summary.mdx")));
        assert!(!is_markdown_like(std::path::Path::new("notes/design.ts")));
    }

    #[test]
    fn canonicalize_for_write_target_keeps_nonexistent_children_under_existing_roots() {
        let root =
            std::env::temp_dir().join(format!("conductor-project-notes-{}", uuid::Uuid::new_v4()));
        let notes_root = root.join("vault");
        fs::create_dir_all(&notes_root).unwrap();
        let nested = notes_root.join("new").join("idea.md");

        let canonical = canonicalize_for_write_target(&nested);
        assert!(canonical.starts_with(notes_root.canonicalize().unwrap()));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn obsidian_uri_uses_absolute_path_query_parameter() {
        let root = std::env::temp_dir().join(format!(
            "conductor-project-notes-uri-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let note = root.join("ideas.md");
        fs::write(&note, "# Ideas\n").unwrap();

        let uri = build_obsidian_open_uri(&note).expect("uri should be built");
        assert!(uri.starts_with("obsidian://open?"));
        assert!(uri.contains("path="));
        assert!(uri.contains("ideas.md"));

        fs::remove_dir_all(&root).unwrap();
    }
}
