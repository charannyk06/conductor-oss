use anyhow::{anyhow, Result as AnyhowResult};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

use crate::dispatcher_task_lifecycle::{
    create_dispatcher_task, update_dispatcher_task, DispatcherTaskCreateInput,
    DispatcherTaskMutationContext, DispatcherTaskUpdateInput,
};
use crate::routes::config::resolve_access_identity;
use crate::state::{resolve_board_file, AppState};
use crate::task_context::ensure_task_brief;

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
        .route(
            "/api/boards",
            get(get_board).post(add_board_task).patch(update_board_task),
        )
        .route("/api/boards/comments", post(add_board_comment))
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
    objective: Option<String>,
    surfaces: Option<Vec<String>>,
    constraints: Option<Vec<String>>,
    dependencies: Option<Vec<String>>,
    acceptance: Option<Vec<String>>,
    skills: Option<Vec<String>>,
    review_refs: Option<Vec<String>>,
    deliverables: Option<Vec<String>>,
    execution_mode: Option<String>,
    issue_id: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
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
    target_index: Option<usize>,
    title: Option<String>,
    description: Option<String>,
    context_notes: Option<String>,
    attachments: Option<Vec<String>>,
    objective: Option<String>,
    surfaces: Option<Vec<String>>,
    constraints: Option<Vec<String>>,
    dependencies: Option<Vec<String>>,
    acceptance: Option<Vec<String>>,
    skills: Option<Vec<String>>,
    review_refs: Option<Vec<String>>,
    deliverables: Option<Vec<String>>,
    execution_mode: Option<String>,
    issue_id: Option<String>,
    github_item_id: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    r#type: Option<String>,
    priority: Option<String>,
    task_ref: Option<String>,
    attempt_ref: Option<String>,
    checked: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBoardCommentBody {
    project_id: String,
    task_id: String,
    body: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BoardTaskPacket {
    pub(crate) objective: Option<String>,
    pub(crate) execution_mode: Option<String>,
    pub(crate) surfaces: Vec<String>,
    pub(crate) constraints: Vec<String>,
    pub(crate) dependencies: Vec<String>,
    pub(crate) acceptance: Vec<String>,
    pub(crate) skills: Vec<String>,
    pub(crate) review_refs: Vec<String>,
    pub(crate) deliverables: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct BoardTaskRecord {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) checked: bool,
    pub(crate) agent: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) task_type: Option<String>,
    pub(crate) priority: Option<String>,
    pub(crate) task_ref: Option<String>,
    pub(crate) attempt_ref: Option<String>,
    pub(crate) issue_id: Option<String>,
    pub(crate) github_item_id: Option<String>,
    pub(crate) attachments: Vec<String>,
    pub(crate) notes: Option<String>,
    pub(crate) packet: BoardTaskPacket,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedBoardColumn {
    pub(crate) role: String,
    pub(crate) heading: String,
    pub(crate) tasks: Vec<BoardTaskRecord>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedBoard {
    pub(crate) prefix_lines: Vec<String>,
    pub(crate) columns: Vec<ParsedBoardColumn>,
    pub(crate) settings_block: Vec<String>,
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
    match create_dispatcher_task(
        &state,
        DispatcherTaskMutationContext {
            activity_source: "board",
            ..DispatcherTaskMutationContext::default()
        },
        DispatcherTaskCreateInput {
            project: Some(body.project_id),
            title: body.title,
            description: body.description,
            context_notes: body.context_notes,
            attachments: body.attachments,
            objective: body.objective,
            execution_mode: body.execution_mode,
            surfaces: body.surfaces,
            constraints: body.constraints,
            dependencies: body.dependencies,
            acceptance: body.acceptance,
            skills: body.skills,
            review_refs: body.review_refs,
            deliverables: body.deliverables,
            agent: body.agent,
            model: body.model,
            reasoning_effort: body.reasoning_effort,
            role: body.role,
            task_type: body.r#type,
            priority: body.priority,
            issue_id: body.issue_id,
            ..DispatcherTaskCreateInput::default()
        },
    )
    .await
    {
        Ok(result) => {
            let mut payload = result.board_payload.clone();
            payload["createdTaskId"] = Value::String(result.task.id);
            created(payload)
        }
        Err(err) => error(board_mutation_status(&err), err.to_string()),
    }
}

async fn update_board_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateTaskBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() || body.task_id.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId and taskId are required");
    }
    match update_dispatcher_task(
        &state,
        DispatcherTaskMutationContext {
            activity_source: "board",
            ..DispatcherTaskMutationContext::default()
        },
        DispatcherTaskUpdateInput {
            project: Some(body.project_id),
            task: Some(body.task_id),
            role: body.role,
            target_index: body.target_index,
            title: body.title,
            description: body.description,
            context_notes: body.context_notes,
            attachments: body.attachments,
            objective: body.objective,
            execution_mode: body.execution_mode,
            surfaces: body.surfaces,
            constraints: body.constraints,
            dependencies: body.dependencies,
            acceptance: body.acceptance,
            skills: body.skills,
            review_refs: body.review_refs,
            deliverables: body.deliverables,
            agent: body.agent,
            model: body.model,
            reasoning_effort: body.reasoning_effort,
            task_type: body.r#type,
            priority: body.priority,
            task_ref: body.task_ref,
            attempt_ref: body.attempt_ref,
            issue_id: body.issue_id,
            github_item_id: body.github_item_id,
            checked: body.checked,
        },
    )
    .await
    {
        Ok(result) => ok(result.board_payload),
        Err(err) => error(board_mutation_status(&err), err.to_string()),
    }
}

fn board_mutation_status(error: &anyhow::Error) -> StatusCode {
    let message = error.to_string();
    if message.starts_with("Unknown project:") || message.contains("not found in project") {
        return StatusCode::NOT_FOUND;
    }
    if message.contains("title is required")
        || message.contains("project is required")
        || message.contains("task is required")
    {
        return StatusCode::BAD_REQUEST;
    }
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn add_board_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AddBoardCommentBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() || body.task_id.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId and taskId are required");
    }
    let trimmed_body = body.body.trim();
    if trimmed_body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Comment body is required");
    }

    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&body.project_id) else {
        return error(
            StatusCode::NOT_FOUND,
            format!("Unknown project: {}", body.project_id),
        );
    };
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| body.project_id.clone());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(&board_relative);
    let board = parse_board(&board_path, &body.project_id);
    let Some(task) = find_task_record(&board, &body.task_id) else {
        return error(
            StatusCode::NOT_FOUND,
            format!("Task {} not found", body.task_id),
        );
    };

    let identity = resolve_access_identity(&headers, &config.access).await;
    let author_email = identity
        .email
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let provider = identity
        .provider
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let author = author_email
        .clone()
        .or_else(|| provider.clone())
        .or_else(local_author_name)
        .unwrap_or_else(|| "local-user".to_string());

    state
        .add_board_comment(
            &body.project_id,
            &body.task_id,
            author.clone(),
            author_email,
            provider,
            trimmed_body.to_string(),
        )
        .await;
    state
        .push_board_activity(
            &body.project_id,
            "comment",
            "added comment",
            format!("{} on {}", author, task.text),
        )
        .await;
    state.publish_snapshot().await;

    match load_board_response(&state, &body.project_id).await {
        Ok(payload) => created(payload),
        Err((status, message)) => error(status, message),
    }
}

async fn board_health(State(state): State<Arc<AppState>>) -> ApiResponse {
    let config = state.config.read().await.clone();
    let watched_boards = config
        .projects
        .iter()
        .map(|(project_id, project)| {
            let board_dir = project
                .board_dir
                .clone()
                .unwrap_or_else(|| project_id.clone());
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

pub(crate) async fn load_board_response(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<Value, (StatusCode, String)> {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(project_id) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Unknown project: {project_id}"),
        ));
    };
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| project_id.to_string());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(&board_relative);
    let parsed = parse_board(&board_path, project_id);
    let task_comments = state.task_comments(project_id).await;
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

    let mut columns = Vec::with_capacity(ordered_columns.len());
    for (role, heading) in &ordered_columns {
        let mut tasks = Vec::new();
        for task in grouped.get(role).cloned().unwrap_or_default() {
            let comments = task_comments
                .get(&task.id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|comment| {
                    json!({
                        "id": comment.id,
                        "taskId": comment.task_id,
                        "author": comment.author,
                        "authorEmail": comment.author_email,
                        "provider": comment.provider,
                        "body": comment.body,
                        "timestamp": comment.timestamp,
                    })
                })
                .collect::<Vec<_>>();
            let brief = ensure_task_brief(state, project_id, project, &task)
                .await
                .ok();

            tasks.push(json!({
                "id": task.id,
                "text": task.text,
                "checked": task.checked,
                "agent": task.agent,
                "model": task.model,
                "reasoningEffort": task.reasoning_effort,
                "project": task.project,
                "type": task.task_type,
                "priority": task.priority,
                "taskRef": task.task_ref,
                "attemptRef": task.attempt_ref,
                "issueId": task.issue_id,
                "githubItemId": task.github_item_id,
                "attachments": task.attachments,
                "notes": task.notes,
                "packet": {
                    "objective": task.packet.objective,
                    "executionMode": task.packet.execution_mode,
                    "surfaces": task.packet.surfaces,
                    "constraints": task.packet.constraints,
                    "dependencies": task.packet.dependencies,
                    "acceptance": task.packet.acceptance,
                    "skills": task.packet.skills,
                    "reviewRefs": task.packet.review_refs,
                    "deliverables": task.packet.deliverables,
                },
                "briefPath": brief.as_ref().map(|value| value.repo_display.clone()),
                "vaultBriefPath": brief.and_then(|value| value.vault_display),
                "commentCount": comments.len(),
                "comments": comments,
            }));
        }
        columns.push(json!({
            "role": role,
            "heading": heading,
            "tasks": tasks,
        }));
    }

    let recent_actions = state
        .recent_board_activity(project_id)
        .await
        .into_iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "source": entry.source,
                "action": entry.action,
                "detail": entry.detail,
                "timestamp": entry.timestamp,
            })
        })
        .collect::<Vec<_>>();
    let recent_webhook_deliveries = state
        .recent_webhook_deliveries(project_id)
        .await
        .into_iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "event": entry.event,
                "action": entry.action,
                "status": entry.status,
                "detail": entry.detail,
                "repository": entry.repository,
                "timestamp": entry.timestamp,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "projectId": project_id,
        "repository": project.repo.clone(),
        "boardPath": board_relative,
        "workspacePath": state.workspace_path.to_string_lossy().to_string(),
        "columns": columns,
        "primaryRoles": ordered_columns.iter().map(|(role, _)| role.as_str()).collect::<Vec<_>>(),
        "githubProject": project.github_project.clone(),
        "recentActions": recent_actions,
        "recentWebhookDeliveries": recent_webhook_deliveries,
    }))
}

pub(crate) fn parse_board(path: &Path, project_id: &str) -> ParsedBoard {
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
            if let (Some(role), Some(existing_heading)) =
                (current_role.take(), current_heading.take())
            {
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

pub(crate) fn parse_task_line(
    line: &str,
    _role: &str,
    project_id: &str,
) -> Option<BoardTaskRecord> {
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
        id: metadata
            .remove("id")
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        text,
        checked: checked.0,
        agent: metadata
            .remove("agent")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("agent").cloned()),
        model: metadata
            .remove("model")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("model").cloned()),
        reasoning_effort: metadata
            .remove("reasoningEffort")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("reasoningEffort").cloned())
            .map(|value| value.to_ascii_lowercase()),
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
        issue_id: metadata
            .remove("issueId")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| inline_tags.get("issue").cloned()),
        github_item_id: metadata
            .remove("githubItemId")
            .map(|value| strip_inline_tags(&value).to_string())
            .filter(|value| !value.is_empty()),
        attachments: metadata
            .remove("attachments")
            .map(|value| parse_metadata_list(&value))
            .unwrap_or_default(),
        notes: metadata
            .remove("notes")
            .map(|value| strip_inline_tags(&value).to_string()),
        packet: BoardTaskPacket {
            objective: metadata
                .remove("objective")
                .map(|value| strip_inline_tags(&value).to_string())
                .filter(|value| !value.is_empty()),
            execution_mode: metadata
                .remove("executionMode")
                .or_else(|| metadata.remove("workspaceMode"))
                .and_then(|value| normalize_execution_mode(value.as_str()).map(str::to_string)),
            surfaces: metadata
                .remove("surfaces")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
            constraints: metadata
                .remove("constraints")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
            dependencies: metadata
                .remove("dependencies")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
            acceptance: metadata
                .remove("acceptance")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
            skills: metadata
                .remove("skills")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
            review_refs: metadata
                .remove("reviewRefs")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
            deliverables: metadata
                .remove("deliverables")
                .map(|value| parse_metadata_list(&value))
                .unwrap_or_default(),
        },
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

pub(crate) fn default_heading_for_role(role: &str) -> &'static str {
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
        for ch in project_id
            .chars()
            .filter(|value| value.is_ascii_alphanumeric())
        {
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

pub(crate) fn next_human_task_ref(board: &ParsedBoard, project_id: &str) -> String {
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

pub(crate) fn split_task_text(text: &str) -> (String, Option<String>) {
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

fn find_task_record<'a>(board: &'a ParsedBoard, task_id: &str) -> Option<&'a BoardTaskRecord> {
    board
        .columns
        .iter()
        .flat_map(|column| column.tasks.iter())
        .find(|task| task.id == task_id)
}

fn board_task_matches_link(task: &BoardTaskRecord, trimmed: &str, normalized: &str) -> bool {
    task.id == trimmed
        || task
            .task_ref
            .as_deref()
            .map(str::trim)
            .is_some_and(|task_ref| {
                task_ref.eq_ignore_ascii_case(trimmed) || task_ref.eq_ignore_ascii_case(normalized)
            })
        || task
            .issue_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|issue_id| {
                let issue_id = issue_id.trim();
                issue_id == normalized
                    || issue_id == trimmed
                    || issue_id.trim_start_matches('#') == normalized
            })
}

pub(crate) async fn resolve_board_task_record(
    state: &Arc<AppState>,
    project_id: &str,
    task_link_key: &str,
) -> Option<BoardTaskRecord> {
    let trimmed = task_link_key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.trim_start_matches('#');

    let board_path = resolve_board_path_for_project(state, project_id)
        .await
        .ok()?;
    let board = parse_board(&board_path, project_id);

    board
        .columns
        .iter()
        .flat_map(|column| column.tasks.iter())
        .find(|task| board_task_matches_link(task, trimmed, normalized))
        .cloned()
}

fn local_author_name() -> Option<String> {
    env::var("USER")
        .ok()
        .or_else(|| env::var("USERNAME").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) async fn resolve_board_path_for_project(
    state: &Arc<AppState>,
    project_id: &str,
) -> AnyhowResult<PathBuf> {
    let config = state.config.read().await.clone();
    let project = config
        .projects
        .get(project_id)
        .ok_or_else(|| anyhow!("Unknown project: {project_id}"))?;
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| project_id.to_string());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    Ok(state.workspace_path.join(board_relative))
}

pub(crate) fn update_task_dispatch_state(
    board: &mut ParsedBoard,
    task_id: &str,
    target_role: &str,
    target_index: Option<usize>,
    attempt_ref: Option<&str>,
) -> bool {
    let canonical_target_role = normalize_role(target_role);
    let mut located: Option<(usize, usize, BoardTaskRecord)> = None;
    for (column_index, column) in board.columns.iter_mut().enumerate() {
        if let Some(task_index) = column.tasks.iter().position(|task| task.id == task_id) {
            let task = column.tasks.remove(task_index);
            located = Some((column_index, task_index, task));
            break;
        }
    }

    let Some((source_column_index, source_task_index, mut task)) = located else {
        return false;
    };

    if let Some(attempt_ref) = attempt_ref.map(str::trim).filter(|value| !value.is_empty()) {
        task.attempt_ref = Some(attempt_ref.to_string());
    }

    let source_role = board.columns[source_column_index].role.clone();
    insert_task_at_position(
        board,
        task,
        &source_role,
        source_task_index,
        canonical_target_role,
        target_index,
    );

    true
}

pub(crate) async fn update_board_task_attempt_ref(
    state: &Arc<AppState>,
    project_id: &str,
    task_id: &str,
    attempt_ref: &str,
    target_role: Option<&str>,
) -> AnyhowResult<()> {
    let board_path = resolve_board_path_for_project(state, project_id).await?;
    let mut board = parse_board(&board_path, project_id);
    let role = target_role.unwrap_or("dispatching");
    if update_task_dispatch_state(&mut board, task_id, role, None, Some(attempt_ref)) {
        write_parsed_board(&board_path, &board, project_id)?;
        state.publish_snapshot().await;
    }
    Ok(())
}

fn insert_task_at_position(
    board: &mut ParsedBoard,
    task: BoardTaskRecord,
    source_role: &str,
    source_task_index: usize,
    target_role: &str,
    target_index: Option<usize>,
) {
    if source_role == target_role {
        if let Some(source_column) = board
            .columns
            .iter_mut()
            .find(|column| column.role == source_role)
        {
            let insert_at = target_index
                .unwrap_or(source_task_index)
                .min(source_column.tasks.len());
            source_column.tasks.insert(insert_at, task);
        } else {
            board.columns.push(ParsedBoardColumn {
                role: target_role.to_string(),
                heading: default_heading_for_role(target_role).to_string(),
                tasks: vec![task],
            });
        }
        return;
    }

    if let Some(target_column) = board
        .columns
        .iter_mut()
        .find(|column| column.role == target_role)
    {
        let insert_at = target_index.unwrap_or(target_column.tasks.len());
        target_column
            .tasks
            .insert(insert_at.min(target_column.tasks.len()), task);
    } else {
        board.columns.push(ParsedBoardColumn {
            role: target_role.to_string(),
            heading: default_heading_for_role(target_role).to_string(),
            tasks: vec![task],
        });
    }
}

pub(crate) fn write_parsed_board(
    path: &Path,
    board: &ParsedBoard,
    project_id: &str,
) -> std::io::Result<()> {
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

pub(crate) fn insert_task_into_board(
    path: &Path,
    role: &str,
    task: &BoardTaskRecord,
    project_id: &str,
) -> std::io::Result<()> {
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

    let mut lines = existing
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let target_heading_index = lines.iter().position(|line| {
        line.trim()
            .strip_prefix("## ")
            .map(|heading| normalize_role(heading) == role)
            .unwrap_or(false)
    });

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

pub(crate) fn normalize_role(value: &str) -> &'static str {
    match value
        .trim()
        .to_lowercase()
        .replace(['-', '_', ' '], "")
        .as_str()
    {
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

pub(crate) fn build_task_text(title: &str, description: Option<&str>) -> String {
    let description = description.unwrap_or_default().trim();
    if description.is_empty() {
        title.to_string()
    } else {
        format!("{} - {}", title, description)
    }
}

fn sanitize_value(value: &str) -> String {
    value
        .replace('|', "/")
        .replace('\n', " ")
        .trim()
        .to_string()
}

fn sanitize_tag_value(value: &str) -> String {
    value
        .trim()
        .replace([' ', '/', '\\'], "-")
        .trim_matches('-')
        .to_string()
}

fn serialize_metadata_list(values: &[String]) -> String {
    let sanitized = values
        .iter()
        .map(|value| sanitize_value(value))
        .collect::<Vec<_>>();
    if sanitized.iter().any(|value| value.contains(',')) {
        serde_json::to_string(&sanitized).unwrap_or_else(|_| sanitized.join(","))
    } else {
        sanitized.join(",")
    }
}

pub(crate) fn build_task_line(task: &BoardTaskRecord, project_id: &str) -> String {
    let checkbox = if task.checked { "[x]" } else { "[ ]" };
    let mut segments = vec![
        sanitize_value(&task.text),
        format!("id:{}", sanitize_value(&task.id)),
    ];

    if let Some(agent) = task
        .agent
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("agent:{}", sanitize_value(agent)));
    }
    if let Some(model) = task
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("model:{}", sanitize_value(model)));
    }
    if let Some(reasoning_effort) = task
        .reasoning_effort
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!(
            "reasoningEffort:{}",
            sanitize_value(reasoning_effort)
        ));
    }
    if let Some(task_type) = task
        .task_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("type:{}", sanitize_value(task_type)));
    }
    if let Some(priority) = task
        .priority
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("priority:{}", sanitize_value(priority)));
    }
    if let Some(project) = task
        .project
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("project:{}", sanitize_value(project)));
    } else {
        segments.push(format!("project:{}", sanitize_value(project_id)));
    }
    if let Some(task_ref) = task
        .task_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("taskRef:{}", sanitize_value(task_ref)));
    }
    if let Some(attempt_ref) = task
        .attempt_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("attemptRef:{}", sanitize_value(attempt_ref)));
    }
    if let Some(issue_id) = task
        .issue_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("issueId:{}", sanitize_value(issue_id)));
    }
    if let Some(github_item_id) = task
        .github_item_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("githubItemId:{}", sanitize_value(github_item_id)));
    }
    if !task.attachments.is_empty() {
        segments.push(format!(
            "attachments:{}",
            serialize_metadata_list(&task.attachments)
        ));
    }
    if let Some(notes) = task
        .notes
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("notes:{}", sanitize_value(notes)));
    }
    if let Some(objective) = task
        .packet
        .objective
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        segments.push(format!("objective:{}", sanitize_value(objective)));
    }
    if let Some(execution_mode) = task.packet.execution_mode.as_deref() {
        segments.push(format!("executionMode:{}", sanitize_value(execution_mode)));
    }
    if !task.packet.surfaces.is_empty() {
        segments.push(format!(
            "surfaces:{}",
            serialize_metadata_list(&task.packet.surfaces)
        ));
    }
    if !task.packet.constraints.is_empty() {
        segments.push(format!(
            "constraints:{}",
            serialize_metadata_list(&task.packet.constraints)
        ));
    }
    if !task.packet.dependencies.is_empty() {
        segments.push(format!(
            "dependencies:{}",
            serialize_metadata_list(&task.packet.dependencies)
        ));
    }
    if !task.packet.acceptance.is_empty() {
        segments.push(format!(
            "acceptance:{}",
            serialize_metadata_list(&task.packet.acceptance)
        ));
    }
    if !task.packet.skills.is_empty() {
        segments.push(format!(
            "skills:{}",
            serialize_metadata_list(&task.packet.skills)
        ));
    }
    if !task.packet.review_refs.is_empty() {
        segments.push(format!(
            "reviewRefs:{}",
            serialize_metadata_list(&task.packet.review_refs)
        ));
    }
    if !task.packet.deliverables.is_empty() {
        segments.push(format!(
            "deliverables:{}",
            serialize_metadata_list(&task.packet.deliverables)
        ));
    }

    let mut inline_tags = Vec::<String>::new();
    if let Some(agent) = task
        .agent
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        inline_tags.push(format!("#agent/{}", sanitize_tag_value(agent)));
    }
    inline_tags.push(format!(
        "#project/{}",
        sanitize_tag_value(
            task.project
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(project_id)
        )
    ));
    if let Some(task_type) = task
        .task_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        inline_tags.push(format!("#type/{}", sanitize_tag_value(task_type)));
    }
    if let Some(priority) = task
        .priority
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        inline_tags.push(format!("#priority/{}", sanitize_tag_value(priority)));
    }
    if let Some(issue_id) = task
        .issue_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        inline_tags.push(format!("#issue/{}", sanitize_tag_value(issue_id)));
    }

    let mut line = format!("- {} {}", checkbox, segments.join(" | "));
    if !inline_tags.is_empty() {
        line.push(' ');
        line.push_str(&inline_tags.join(" "));
    }
    line
}

fn parse_metadata_list(value: &str) -> Vec<String> {
    let trimmed = strip_inline_tags(value).trim();
    if trimmed.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
            return parsed
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect();
        }
    }

    trimmed
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub(crate) fn normalize_execution_mode(value: &str) -> Option<&'static str> {
    match value
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .as_str()
    {
        "worktree" => Some("worktree"),
        "main" | "repo" | "repo_root" | "main_workspace" | "mainworkspace" | "root_workspace" => {
            Some("main_workspace")
        }
        "temp" | "temp_clone" | "tempclone" | "full_clone" | "review_clone" => Some("temp_clone"),
        _ => None,
    }
}

pub(crate) fn board_task_prefers_worktree(task: &BoardTaskRecord) -> Option<bool> {
    match task.packet.execution_mode.as_deref() {
        Some("worktree") => Some(true),
        Some("main_workspace") | Some("temp_clone") => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        board_task_prefers_worktree, build_task_line, normalize_execution_mode, parse_task_line,
        update_task_dispatch_state, BoardTaskPacket, BoardTaskRecord, ParsedBoard,
        ParsedBoardColumn,
    };

    fn task(id: &str) -> BoardTaskRecord {
        BoardTaskRecord {
            id: id.to_string(),
            text: format!("Task {id}"),
            checked: false,
            agent: None,
            model: None,
            reasoning_effort: None,
            project: None,
            task_type: None,
            priority: None,
            task_ref: None,
            attempt_ref: None,
            issue_id: None,
            github_item_id: None,
            attachments: Vec::new(),
            notes: None,
            packet: BoardTaskPacket::default(),
        }
    }

    #[test]
    fn task_line_round_trip_preserves_dispatcher_packet_fields() {
        let task = BoardTaskRecord {
            id: "task-1".to_string(),
            text: "Review implementation - Compare the local branch with the PR".to_string(),
            checked: false,
            agent: Some("codex".to_string()),
            model: Some("gpt-5.4".to_string()),
            reasoning_effort: Some("high".to_string()),
            project: Some("demo".to_string()),
            task_type: Some("review".to_string()),
            priority: Some("high".to_string()),
            task_ref: Some("DEM-001".to_string()),
            attempt_ref: None,
            issue_id: None,
            github_item_id: None,
            attachments: vec!["docs/spec.md".to_string()],
            notes: Some("Focus on behavioral regressions first.".to_string()),
            packet: BoardTaskPacket {
                objective: Some(
                    "Validate the implementation against the PR requirements.".to_string(),
                ),
                execution_mode: Some("temp_clone".to_string()),
                surfaces: vec!["crates/conductor-server/src".to_string()],
                constraints: vec!["Do not mutate the board during review".to_string()],
                dependencies: vec!["PR #42 context".to_string()],
                acceptance: vec!["Summarize findings by severity".to_string()],
                skills: vec!["github".to_string()],
                review_refs: vec!["https://github.com/acme/demo/pull/42".to_string()],
                deliverables: vec!["review summary".to_string()],
            },
        };

        let line = build_task_line(&task, "demo");
        let parsed = parse_task_line(&line, "review", "demo").expect("task should parse");

        assert_eq!(parsed.packet.execution_mode.as_deref(), Some("temp_clone"));
        assert_eq!(
            parsed.packet.objective.as_deref(),
            Some("Validate the implementation against the PR requirements.")
        );
        assert_eq!(parsed.packet.surfaces, vec!["crates/conductor-server/src"]);
        assert_eq!(parsed.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(parsed.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            parsed.packet.review_refs,
            vec!["https://github.com/acme/demo/pull/42"]
        );
        assert_eq!(parsed.packet.deliverables, vec!["review summary"]);
    }

    #[test]
    fn task_line_round_trip_preserves_list_items_with_commas() {
        let task = BoardTaskRecord {
            id: "task-2".to_string(),
            text: "Implement ACP fixes".to_string(),
            checked: false,
            agent: Some("codex".to_string()),
            model: None,
            reasoning_effort: None,
            project: Some("demo".to_string()),
            task_type: Some("fix".to_string()),
            priority: Some("high".to_string()),
            task_ref: Some("DEM-002".to_string()),
            attempt_ref: None,
            issue_id: None,
            github_item_id: None,
            attachments: vec!["docs/spec,final.md".to_string()],
            notes: Some("Keep the dispatcher approval flow intact.".to_string()),
            packet: BoardTaskPacket {
                objective: Some("Fix ACP dispatcher mutations.".to_string()),
                execution_mode: Some("worktree".to_string()),
                surfaces: vec![
                    "crates/conductor-server/src/acp.rs, crates/conductor-server/src/mcp.rs"
                        .to_string(),
                ],
                constraints: vec![
                    "Preserve approval gating, do not widen mutation scope.".to_string()
                ],
                dependencies: vec!["ACP proposal output, board persistence format".to_string()],
                acceptance: vec![
                    "Approvals create tasks, packet fields survive round-trips.".to_string()
                ],
                skills: vec!["rust, testing".to_string()],
                review_refs: vec!["https://example.test/pr/42?view=files,comments".to_string()],
                deliverables: vec!["code patch, regression coverage".to_string()],
            },
        };

        let line = build_task_line(&task, "demo");
        let parsed = parse_task_line(&line, "intake", "demo").expect("task should parse");

        assert_eq!(parsed.attachments, task.attachments);
        assert_eq!(parsed.packet.surfaces, task.packet.surfaces);
        assert_eq!(parsed.packet.constraints, task.packet.constraints);
        assert_eq!(parsed.packet.dependencies, task.packet.dependencies);
        assert_eq!(parsed.packet.acceptance, task.packet.acceptance);
        assert_eq!(parsed.packet.skills, task.packet.skills);
        assert_eq!(parsed.packet.review_refs, task.packet.review_refs);
        assert_eq!(parsed.packet.deliverables, task.packet.deliverables);
    }

    #[test]
    fn execution_mode_aliases_normalize_and_drive_worktree_preference() {
        assert_eq!(
            normalize_execution_mode("main workspace"),
            Some("main_workspace")
        );
        assert_eq!(normalize_execution_mode("temp-clone"), Some("temp_clone"));
        assert_eq!(normalize_execution_mode("worktree"), Some("worktree"));

        let mut task = task("task-1");
        task.packet.execution_mode = Some("temp_clone".to_string());
        assert_eq!(board_task_prefers_worktree(&task), Some(false));
        task.packet.execution_mode = Some("worktree".to_string());
        assert_eq!(board_task_prefers_worktree(&task), Some(true));
    }

    #[test]
    fn update_task_dispatch_state_normalizes_same_role_variants() {
        let mut board = ParsedBoard {
            prefix_lines: Vec::new(),
            columns: vec![ParsedBoardColumn {
                role: "inProgress".to_string(),
                heading: "In progress".to_string(),
                tasks: vec![task("task-1"), task("task-2")],
            }],
            settings_block: Vec::new(),
        };

        let updated =
            update_task_dispatch_state(&mut board, "task-1", "In progress", None, Some("a-1"));

        assert!(updated);
        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].role, "inProgress");
        assert_eq!(board.columns[0].tasks.len(), 2);
        assert_eq!(board.columns[0].tasks[0].id, "task-1");
        assert_eq!(
            board.columns[0].tasks[0].attempt_ref.as_deref(),
            Some("a-1")
        );
        assert_eq!(board.columns[0].tasks[1].id, "task-2");
    }

    #[test]
    fn update_task_dispatch_state_reuses_existing_canonical_target_column() {
        let mut board = ParsedBoard {
            prefix_lines: Vec::new(),
            columns: vec![
                ParsedBoardColumn {
                    role: "intake".to_string(),
                    heading: "To do".to_string(),
                    tasks: vec![task("task-1")],
                },
                ParsedBoardColumn {
                    role: "inProgress".to_string(),
                    heading: "In progress".to_string(),
                    tasks: vec![task("task-2")],
                },
            ],
            settings_block: Vec::new(),
        };

        let updated = update_task_dispatch_state(&mut board, "task-1", "in_progress", None, None);

        assert!(updated);
        assert_eq!(board.columns.len(), 2);
        assert!(board.columns[0].tasks.is_empty());
        assert_eq!(board.columns[1].role, "inProgress");
        assert_eq!(board.columns[1].tasks.len(), 2);
        assert_eq!(board.columns[1].tasks[1].id, "task-1");
    }

    #[test]
    fn update_task_dispatch_state_creates_columns_with_canonical_role_and_heading() {
        let mut board = ParsedBoard {
            prefix_lines: Vec::new(),
            columns: vec![ParsedBoardColumn {
                role: "intake".to_string(),
                heading: "To do".to_string(),
                tasks: vec![task("task-1")],
            }],
            settings_block: Vec::new(),
        };

        let updated = update_task_dispatch_state(&mut board, "task-1", "In progress", None, None);

        assert!(updated);
        assert_eq!(board.columns.len(), 2);
        assert!(board.columns[0].tasks.is_empty());
        assert_eq!(board.columns[1].role, "inProgress");
        assert_eq!(board.columns[1].heading, "In progress");
        assert_eq!(board.columns[1].tasks.len(), 1);
        assert_eq!(board.columns[1].tasks[0].id, "task-1");
    }

    #[test]
    fn update_task_dispatch_state_reorders_within_same_column_when_target_index_is_provided() {
        let mut board = ParsedBoard {
            prefix_lines: Vec::new(),
            columns: vec![ParsedBoardColumn {
                role: "ready".to_string(),
                heading: "Ready".to_string(),
                tasks: vec![task("task-1"), task("task-2"), task("task-3")],
            }],
            settings_block: Vec::new(),
        };

        let updated = update_task_dispatch_state(&mut board, "task-1", "ready", Some(2), None);

        assert!(updated);
        assert_eq!(board.columns[0].tasks.len(), 3);
        assert_eq!(board.columns[0].tasks[0].id, "task-2");
        assert_eq!(board.columns[0].tasks[1].id, "task-3");
        assert_eq!(board.columns[0].tasks[2].id, "task-1");
    }

    #[test]
    fn update_task_dispatch_state_inserts_into_target_column_at_requested_index() {
        let mut board = ParsedBoard {
            prefix_lines: Vec::new(),
            columns: vec![
                ParsedBoardColumn {
                    role: "ready".to_string(),
                    heading: "Ready".to_string(),
                    tasks: vec![task("task-1")],
                },
                ParsedBoardColumn {
                    role: "inProgress".to_string(),
                    heading: "In progress".to_string(),
                    tasks: vec![task("task-2"), task("task-3")],
                },
            ],
            settings_block: Vec::new(),
        };

        let updated = update_task_dispatch_state(&mut board, "task-1", "inProgress", Some(0), None);

        assert!(updated);
        assert!(board.columns[0].tasks.is_empty());
        assert_eq!(board.columns[1].tasks.len(), 3);
        assert_eq!(board.columns[1].tasks[0].id, "task-1");
        assert_eq!(board.columns[1].tasks[1].id, "task-2");
        assert_eq!(board.columns[1].tasks[2].id, "task-3");
    }
}
