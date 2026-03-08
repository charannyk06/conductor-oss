use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

use crate::state::{resolve_board_file, AppState};

type ApiResponse = (StatusCode, Json<Value>);

const ROLE_ORDER: [(&str, &str); 11] = [
    ("intake", "To do"),
    ("ready", "Ready"),
    ("dispatching", "Dispatching"),
    ("inProgress", "In progress"),
    ("needsInput", "Needs input"),
    ("blocked", "Blocked"),
    ("errored", "Errored"),
    ("review", "In review"),
    ("merge", "Merge"),
    ("done", "Done"),
    ("cancelled", "Cancelled"),
];

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/boards", get(get_board).post(add_board_task).patch(update_board_task))
        .route("/api/health/boards", get(board_health))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn created(value: Value) -> ApiResponse {
    (StatusCode::CREATED, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardQuery {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddTaskBody {
    project_id: String,
    title: String,
    description: Option<String>,
    context_notes: Option<String>,
    attachments: Option<Vec<String>>,
    agent: Option<String>,
    role: Option<String>,
    r#type: Option<String>,
    priority: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskBody {
    project_id: String,
    task_id: String,
    role: Option<String>,
    title: Option<String>,
    description: Option<String>,
    agent: Option<String>,
    r#type: Option<String>,
    priority: Option<String>,
    task_ref: Option<String>,
    attempt_ref: Option<String>,
    checked: Option<bool>,
}

#[derive(Debug, Clone)]
struct BoardTaskRecord {
    id: String,
    text: String,
    checked: bool,
    agent: Option<String>,
    project: Option<String>,
    task_type: Option<String>,
    priority: Option<String>,
    task_ref: Option<String>,
    attempt_ref: Option<String>,
    attachments: Vec<String>,
    notes: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedBoardColumn {
    role: String,
    heading: String,
    tasks: Vec<BoardTaskRecord>,
}

#[derive(Debug, Clone)]
struct ParsedBoard {
    prefix_lines: Vec<String>,
    columns: Vec<ParsedBoardColumn>,
    settings_block: Vec<String>,
}

async fn get_board(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BoardQuery>,
) -> ApiResponse {
    match load_board_response(&state, &query.project_id).await {
        Ok(payload) => ok(payload),
        Err((status, message)) => error(status, message),
    }
}

async fn add_board_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddTaskBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() || body.title.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId and title are required");
    }

    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&body.project_id) else {
        return error(StatusCode::NOT_FOUND, format!("Unknown project: {}", body.project_id));
    };
    let board_dir = project.board_dir.clone().unwrap_or_else(|| body.project_id.clone());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(&board_relative);
    let board = parse_board(&board_path, &body.project_id);

    let role = normalize_role(body.role.as_deref().unwrap_or("intake"));
    let task = BoardTaskRecord {
        id: Uuid::new_v4().to_string(),
        text: build_task_text(body.title.trim(), body.description.as_deref()),
        checked: false,
        agent: body.agent.filter(|value| !value.trim().is_empty()),
        project: Some(body.project_id.clone()),
        task_type: body.r#type.filter(|value| !value.trim().is_empty()),
        priority: body.priority.filter(|value| !value.trim().is_empty()),
        task_ref: Some(next_human_task_ref(&board, &body.project_id)),
        attempt_ref: None,
        attachments: body.attachments.unwrap_or_default(),
        notes: body.context_notes.filter(|value| !value.trim().is_empty()),
    };

    if let Err(err) = insert_task_into_board(&board_path, role, &task, &body.project_id) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    match load_board_response(&state, &body.project_id).await {
        Ok(payload) => created(payload),
        Err((status, message)) => error(status, message),
    }
}

async fn update_board_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateTaskBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() || body.task_id.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId and taskId are required");
    }

    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&body.project_id) else {
        return error(StatusCode::NOT_FOUND, format!("Unknown project: {}", body.project_id));
    };
    let board_dir = project.board_dir.clone().unwrap_or_else(|| body.project_id.clone());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(&board_relative);

    let mut board = parse_board(&board_path, &body.project_id);
    let mut located: Option<(usize, usize, BoardTaskRecord)> = None;

    for (column_index, column) in board.columns.iter_mut().enumerate() {
        if let Some(task_index) = column.tasks.iter().position(|task| task.id == body.task_id) {
            let task = column.tasks.remove(task_index);
            located = Some((column_index, task_index, task));
            break;
        }
    }

    let Some((source_column_index, source_task_index, mut task)) = located else {
        return error(StatusCode::NOT_FOUND, format!("Task {} not found", body.task_id));
    };

    let source_role = board.columns[source_column_index].role.clone();
    apply_task_update(&mut task, &body, &body.project_id);
    let target_role = body
        .role
        .as_deref()
        .map(normalize_role)
        .unwrap_or(source_role.as_str())
        .to_string();

    if target_role == source_role {
        let insert_at = source_task_index.min(board.columns[source_column_index].tasks.len());
        board.columns[source_column_index].tasks.insert(insert_at, task);
    } else if let Some(target_column) = board.columns.iter_mut().find(|column| column.role == target_role) {
        target_column.tasks.push(task);
    } else {
        board.columns.push(ParsedBoardColumn {
            role: target_role.clone(),
            heading: default_heading_for_role(&target_role).to_string(),
            tasks: vec![task],
        });
    }

    if let Err(err) = write_parsed_board(&board_path, &board, &body.project_id) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    match load_board_response(&state, &body.project_id).await {
        Ok(payload) => ok(payload),
        Err((status, message)) => error(status, message),
    }
}

async fn board_health(State(state): State<Arc<AppState>>) -> ApiResponse {
    let config = state.config.read().await.clone();
    let watched_boards = config
        .projects
        .iter()
        .map(|(project_id, project)| {
            let board_dir = project.board_dir.clone().unwrap_or_else(|| project_id.clone());
            resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path))
        })
        .collect::<Vec<_>>();

    let boards = config
        .projects
        .iter()
        .map(|(project_id, project)| {
            let board_dir = project.board_dir.clone().unwrap_or_else(|| project_id.clone());
            let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
            let board_path = state.workspace_path.join(&board_relative);
            let parsed = parse_board(&board_path, project_id);
            json!({
                "projectId": project_id,
                "boardPath": board_relative,
                "exists": board_path.exists(),
                "parseOk": true,
                "columns": ROLE_ORDER.iter().map(|(role, heading)| json!({
                    "role": role,
                    "heading": parsed.columns.iter().find(|column| column.role == *role).map(|column| column.heading.clone()).unwrap_or_else(|| (*heading).to_string()),
                    "count": parsed.columns.iter().find(|column| column.role == *role).map(|column| column.tasks.len()).unwrap_or(0),
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();

    ok(json!({
        "workspace": state.workspace_path.to_string_lossy().to_string(),
        "watchedBoards": watched_boards,
        "boards": boards,
        "recentActions": [],
    }))
}

async fn load_board_response(state: &Arc<AppState>, project_id: &str) -> Result<Value, (StatusCode, String)> {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(project_id) else {
        return Err((StatusCode::NOT_FOUND, format!("Unknown project: {project_id}")));
    };
    let board_dir = project.board_dir.clone().unwrap_or_else(|| project_id.to_string());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(&board_relative);
    let parsed = parse_board(&board_path, project_id);
    let mut grouped = HashMap::<String, Vec<BoardTaskRecord>>::new();
    let mut ordered_columns = Vec::<(String, String)>::new();

    for column in &parsed.columns {
        grouped
            .entry(column.role.clone())
            .or_default()
            .extend(column.tasks.clone());
        if !ordered_columns.iter().any(|(role, _)| role == &column.role) {
            ordered_columns.push((column.role.clone(), column.heading.clone()));
        }
    }

    if ordered_columns.is_empty() {
        ordered_columns = ROLE_ORDER
            .iter()
            .map(|(role, heading)| ((*role).to_string(), (*heading).to_string()))
            .collect();
    }

    let columns = ordered_columns
        .iter()
        .map(|(role, heading)| {
            let tasks = grouped
                .get(role)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|task| {
                    json!({
                        "id": task.id,
                        "text": task.text,
                        "checked": task.checked,
                        "agent": task.agent,
                        "project": task.project,
                        "type": task.task_type,
                        "priority": task.priority,
                        "taskRef": task.task_ref,
                        "attemptRef": task.attempt_ref,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "role": role,
                "heading": heading,
                "tasks": tasks,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "projectId": project_id,
        "boardPath": board_relative,
        "workspacePath": state.workspace_path.to_string_lossy().to_string(),
        "columns": columns,
        "primaryRoles": ordered_columns.iter().map(|(role, _)| role.as_str()).collect::<Vec<_>>(),
        "watcherHint": "Rust backend board persistence is active.",
    }))
}

fn parse_board(path: &Path, project_id: &str) -> ParsedBoard {
    if !path.exists() {
        return ParsedBoard {
            prefix_lines: Vec::new(),
            columns: Vec::new(),
            settings_block: Vec::new(),
        };
    }

    let Ok(content) = std::fs::read_to_string(path) else {
        return ParsedBoard {
            prefix_lines: Vec::new(),
            columns: Vec::new(),
            settings_block: Vec::new(),
        };
    };

    let mut prefix_lines = Vec::<String>::new();
    let mut columns = Vec::<ParsedBoardColumn>::new();
    let mut settings_block = Vec::<String>::new();
    let mut current_role: Option<String> = None;
    let mut current_heading: Option<String> = None;
    let mut current_tasks = Vec::<BoardTaskRecord>::new();
    let mut seen_heading = false;
    let mut in_settings = false;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed == "%% kanban:settings" {
            in_settings = true;
            settings_block.push(line.to_string());
            continue;
        }
        if in_settings {
            settings_block.push(line.to_string());
            if trimmed == "%%" {
                in_settings = false;
            }
            continue;
        }

        if let Some(heading) = trimmed.strip_prefix("## ") {
            seen_heading = true;
            if let (Some(role), Some(existing_heading)) = (current_role.take(), current_heading.take()) {
                columns.push(ParsedBoardColumn {
                    role,
                    heading: existing_heading,
                    tasks: std::mem::take(&mut current_tasks),
                });
            }
            current_role = Some(normalize_role(heading).to_string());
            current_heading = Some(heading.trim().to_string());
            continue;
        }

        if !seen_heading {
            prefix_lines.push(line.to_string());
            continue;
        }

        let Some(role) = current_role.as_deref() else {
            continue;
        };
        let Some(task) = parse_task_line(trimmed, role, project_id) else {
            continue;
        };
        current_tasks.push(task);
    }

    if let (Some(role), Some(heading)) = (current_role.take(), current_heading.take()) {
        columns.push(ParsedBoardColumn {
            role,
            heading,
            tasks: current_tasks,
        });
    }

    ParsedBoard {
        prefix_lines,
        columns,
        settings_block,
    }
}

fn parse_task_line(line: &str, _role: &str, project_id: &str) -> Option<BoardTaskRecord> {
    let checked = if let Some(rest) = line.strip_prefix("- [ ] ") {
        (false, rest)
    } else if let Some(rest) = line.strip_prefix("- [x] ") {
        (true, rest)
    } else if let Some(rest) = line.strip_prefix("- ") {
        (false, rest)
    } else {
        return None;
    };

    let inline_tags = parse_inline_tags(checked.1);
    let mut segments = checked.1.split(" | ");
    let text = strip_inline_tags(segments.next()?.trim()).to_string();
    let mut metadata: HashMap<&str, String> = HashMap::new();
    for segment in segments {
        let mut parts = segment.splitn(2, ':');
        let key = parts.next().unwrap_or_default().trim();
        let value = parts.next().unwrap_or_default().trim();
        if !key.is_empty() && !value.is_empty() {
            metadata.insert(key, value.to_string());
        }
    }

    Some(BoardTaskRecord {
        id: metadata.remove("id").unwrap_or_else(|| Uuid::new_v4().to_string()),
        text,
        checked: checked.0,
        agent: metadata
            .remove("agent")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("agent").cloned()),
        project: metadata
            .remove("project")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("project").cloned())
            .or_else(|| Some(project_id.to_string())),
        task_type: metadata
            .remove("type")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("type").cloned()),
        priority: metadata
            .remove("priority")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("priority").cloned()),
        task_ref: metadata
            .remove("taskRef")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty()),
        attempt_ref: metadata
            .remove("attemptRef")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty()),
        attachments: metadata
            .remove("attachments")
            .map(|value| value.split(',').map(str::trim).filter(|item| !item.is_empty()).map(ToOwned::to_owned).collect())
            .unwrap_or_default(),
        notes: metadata.remove("notes").map(|value| strip_inline_tags(&value).to_string()),
    })
}

fn parse_inline_tags(value: &str) -> HashMap<String, String> {
    value
        .split_whitespace()
        .filter_map(|token| token.strip_prefix('#'))
        .filter_map(|token| token.split_once('/'))
        .filter_map(|(key, value)| {
            let key = key.trim();
            let value = value.trim();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some((key.to_string(), value.to_string()))
            }
        })
        .collect()
}

fn strip_inline_tags(value: &str) -> &str {
    value.split(" #").next().unwrap_or(value).trim()
}

fn default_heading_for_role(role: &str) -> &'static str {
    ROLE_ORDER
        .iter()
        .find(|(candidate, _)| *candidate == role)
        .map(|(_, heading)| *heading)
        .unwrap_or("To do")
}

fn task_ref_prefix(project_id: &str) -> String {
    let mut prefix = String::new();

    for segment in project_id.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        if segment.is_empty() {
            continue;
        }
        if let Some(first) = segment.chars().next() {
            prefix.push(first.to_ascii_uppercase());
        }
        if prefix.len() >= 3 {
            break;
        }
    }

    if prefix.len() < 3 {
        for ch in project_id.chars().filter(|value| value.is_ascii_alphanumeric()) {
            prefix.push(ch.to_ascii_uppercase());
            if prefix.len() >= 3 {
                break;
            }
        }
    }

    if prefix.is_empty() {
        "TASK".to_string()
    } else {
        prefix
    }
}

fn extract_task_ref_number(task_ref: &str, prefix: &str) -> Option<u32> {
    let trimmed = task_ref.trim();
    if let Some(rest) = trimmed.strip_prefix(prefix) {
        return rest
            .trim_start_matches(|ch: char| ch == '-' || ch == '_' || ch.is_whitespace())
            .parse::<u32>()
            .ok();
    }

    trimmed
        .strip_prefix("task-")
        .or_else(|| trimmed.strip_prefix("TASK-"))
        .and_then(|value| value.parse::<u32>().ok())
}

fn next_human_task_ref(board: &ParsedBoard, project_id: &str) -> String {
    let prefix = task_ref_prefix(project_id);
    let mut highest = 0_u32;

    for column in &board.columns {
        for task in &column.tasks {
            if let Some(task_ref) = task.task_ref.as_deref() {
                if let Some(value) = extract_task_ref_number(task_ref, &prefix) {
                    highest = highest.max(value);
                }
            }
        }
    }

    format!("{prefix}-{:03}", highest + 1)
}

fn split_task_text(text: &str) -> (String, Option<String>) {
    if let Some((title, description)) = text.split_once(" - ") {
        let trimmed_description = description.trim();
        return (
            title.trim().to_string(),
            if trimmed_description.is_empty() {
                None
            } else {
                Some(trimmed_description.to_string())
            },
        );
    }

    (text.trim().to_string(), None)
}

fn apply_optional_text(target: &mut Option<String>, incoming: &Option<String>) {
    let Some(value) = incoming.as_ref() else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        *target = None;
    } else {
        *target = Some(trimmed.to_string());
    }
}

fn apply_task_update(task: &mut BoardTaskRecord, body: &UpdateTaskBody, project_id: &str) {
    let (mut title, mut description) = split_task_text(&task.text);

    if let Some(next_title) = body.title.as_ref() {
        let trimmed = next_title.trim();
        if !trimmed.is_empty() {
            title = trimmed.to_string();
        }
    }
    if let Some(next_description) = body.description.as_ref() {
        let trimmed = next_description.trim();
        description = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    }

    task.text = build_task_text(&title, description.as_deref());
    apply_optional_text(&mut task.agent, &body.agent);
    apply_optional_text(&mut task.task_type, &body.r#type);
    apply_optional_text(&mut task.priority, &body.priority);
    apply_optional_text(&mut task.task_ref, &body.task_ref);
    apply_optional_text(&mut task.attempt_ref, &body.attempt_ref);

    if let Some(checked) = body.checked {
        task.checked = checked;
    }
    if task.project.as_ref().map(|value| value.trim().is_empty()).unwrap_or(true) {
        task.project = Some(project_id.to_string());
    }
}

fn write_parsed_board(path: &Path, board: &ParsedBoard, project_id: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut out = String::new();

    if !board.prefix_lines.is_empty() {
        out.push_str(&board.prefix_lines.join("\n"));
        if !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.ends_with("\n\n") {
            out.push('\n');
        }
    }

    for (index, column) in board.columns.iter().enumerate() {
        out.push_str(&format!("## {}\n", column.heading));
        for task in &column.tasks {
            out.push_str(&build_task_line(task, project_id));
            out.push('\n');
        }
        if index + 1 < board.columns.len() || !board.settings_block.is_empty() {
            out.push('\n');
        }
    }

    if !board.settings_block.is_empty() {
        out.push_str(&board.settings_block.join("\n"));
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }

    if out.is_empty() {
        out.push_str("# Conductor Board\n");
    }

    std::fs::write(path, out)
}

fn insert_task_into_board(path: &Path, role: &str, task: &BoardTaskRecord, project_id: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let task_line = build_task_line(task, project_id);

    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.trim().is_empty() {
        let mut out = String::from("# Conductor Board\n\n");
        for (candidate_role, heading) in ROLE_ORDER {
            out.push_str(&format!("## {heading}\n"));
            if candidate_role == role {
                out.push_str(&task_line);
                out.push('\n');
            }
            out.push('\n');
        }
        return std::fs::write(path, out);
    }

    let mut lines = existing.lines().map(|line| line.to_string()).collect::<Vec<_>>();
    let target_heading_index = lines
        .iter()
        .position(|line| line.trim().strip_prefix("## ").map(|heading| normalize_role(heading) == role).unwrap_or(false));

    if let Some(index) = target_heading_index {
        let mut insert_at = index + 1;
        while insert_at < lines.len() {
            let trimmed = lines[insert_at].trim();
            if trimmed.starts_with("## ") || trimmed == "%% kanban:settings" {
                break;
            }
            insert_at += 1;
        }
        while insert_at > index + 1 && lines[insert_at - 1].trim().is_empty() {
            insert_at -= 1;
        }
        lines.insert(insert_at, task_line);
    } else {
        let settings_index = lines
            .iter()
            .position(|line| line.trim() == "%% kanban:settings")
            .unwrap_or(lines.len());
        let mut insert_at = settings_index;
        while insert_at > 0 && lines[insert_at - 1].trim().is_empty() {
            insert_at -= 1;
        }
        let mut block = Vec::<String>::new();
        if insert_at > 0 && !lines[insert_at - 1].trim().is_empty() {
            block.push(String::new());
        }
        block.push(format!("## {}", default_heading_for_role(role)));
        block.push(task_line);
        block.push(String::new());
        lines.splice(insert_at..insert_at, block);
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(path, out)
}

fn normalize_role(value: &str) -> &'static str {
    match value.trim().to_lowercase().replace(['-', '_', ' '], "").as_str() {
        "todo" | "intake" | "inbox" | "backlog" => "intake",
        "ready" | "readytodispatch" => "ready",
        "dispatching" => "dispatching",
        "inprogress" => "inProgress",
        "needsinput" | "waiting" => "needsInput",
        "error" | "errored" | "failed" => "errored",
        "inreview" | "review" | "prreview" => "review",
        "merge" | "readytomerge" => "merge",
        "done" | "complete" | "completed" => "done",
        "cancelled" | "canceled" | "archived" => "cancelled",
        "blocked" => "blocked",
        _ => "intake",
    }
}

fn build_task_text(title: &str, description: Option<&str>) -> String {
    let description = description.unwrap_or_default().trim();
    if description.is_empty() {
        title.to_string()
    } else {
        format!("{} - {}", title, description)
    }
}

fn sanitize_value(value: &str) -> String {
    value.replace('|', "/").replace('\n', " ").trim().to_string()
}

fn sanitize_tag_value(value: &str) -> String {
    value
        .trim()
        .replace([' ', '/', '\\'], "-")
        .trim_matches('-')
        .to_string()
}

fn build_task_line(task: &BoardTaskRecord, project_id: &str) -> String {
    let checkbox = if task.checked { "[x]" } else { "[ ]" };
    let mut segments = vec![sanitize_value(&task.text), format!("id:{}", sanitize_value(&task.id))];

    if let Some(agent) = task.agent.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("agent:{}", sanitize_value(agent)));
    }
    if let Some(task_type) = task.task_type.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("type:{}", sanitize_value(task_type)));
    }
    if let Some(priority) = task.priority.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("priority:{}", sanitize_value(priority)));
    }
    if let Some(project) = task.project.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("project:{}", sanitize_value(project)));
    } else {
        segments.push(format!("project:{}", sanitize_value(project_id)));
    }
    if let Some(task_ref) = task.task_ref.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("taskRef:{}", sanitize_value(task_ref)));
    }
    if let Some(attempt_ref) = task.attempt_ref.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("attemptRef:{}", sanitize_value(attempt_ref)));
    }
    if !task.attachments.is_empty() {
        segments.push(format!(
            "attachments:{}",
            task.attachments
                .iter()
                .map(|value| sanitize_value(value))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    if let Some(notes) = task.notes.as_deref().filter(|value| !value.trim().is_empty()) {
        segments.push(format!("notes:{}", sanitize_value(notes)));
    }

    let mut inline_tags = Vec::<String>::new();
    if let Some(agent) = task.agent.as_deref().filter(|value| !value.trim().is_empty()) {
        inline_tags.push(format!("#agent/{}", sanitize_tag_value(agent)));
    }
    inline_tags.push(format!(
        "#project/{}",
        sanitize_tag_value(task.project.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(project_id))
    ));
    if let Some(task_type) = task.task_type.as_deref().filter(|value| !value.trim().is_empty()) {
        inline_tags.push(format!("#type/{}", sanitize_tag_value(task_type)));
    }
    if let Some(priority) = task.priority.as_deref().filter(|value| !value.trim().is_empty()) {
        inline_tags.push(format!("#priority/{}", sanitize_tag_value(priority)));
    }

    let mut line = format!("- {} {}", checkbox, segments.join(" | "));
    if !inline_tags.is_empty() {
        line.push(' ');
        line.push_str(&inline_tags.join(" "));
    }
    line
}
