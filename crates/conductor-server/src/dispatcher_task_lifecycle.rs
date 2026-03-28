use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

use crate::routes::boards::{
    build_task_text, default_heading_for_role, insert_task_into_board, load_board_response,
    next_human_task_ref, normalize_execution_mode, normalize_role, parse_board,
    resolve_board_path_for_project, resolve_board_task_record, split_task_text, write_parsed_board,
    BoardTaskPacket, BoardTaskRecord, ParsedBoard, ParsedBoardColumn,
};
use crate::state::{
    dispatcher_preferred_implementation_agent, dispatcher_preferred_implementation_model,
    dispatcher_preferred_implementation_reasoning_effort, AppState, SessionRecord,
    ACP_ACTIVE_SKILLS_METADATA_KEY,
};

const ACP_SESSION_KIND: &str = "project_dispatcher";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DispatcherTaskOperation {
    Create,
    Update,
    Handoff,
}

impl DispatcherTaskOperation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Handoff => "handoff",
        }
    }

    fn board_activity_action(self) -> &'static str {
        match self {
            Self::Create => "created task",
            Self::Update => "updated task",
            Self::Handoff => "handed off task",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DispatcherTaskMutationContext {
    pub(crate) activity_source: &'static str,
    pub(crate) caller_session: Option<SessionRecord>,
    pub(crate) dispatcher_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DispatcherTaskCreateInput {
    pub project: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub context_notes: Option<String>,
    pub attachments: Option<Vec<String>>,
    pub objective: Option<String>,
    pub execution_mode: Option<String>,
    pub surfaces: Option<Vec<String>>,
    pub constraints: Option<Vec<String>>,
    pub dependencies: Option<Vec<String>>,
    pub acceptance: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub review_refs: Option<Vec<String>>,
    pub deliverables: Option<Vec<String>>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub role: Option<String>,
    #[serde(alias = "type")]
    pub task_type: Option<String>,
    pub priority: Option<String>,
    pub issue_id: Option<String>,
    pub attempt_ref: Option<String>,
    pub github_item_id: Option<String>,
    pub checked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DispatcherTaskUpdateInput {
    pub project: Option<String>,
    pub task: Option<String>,
    pub role: Option<String>,
    pub target_index: Option<usize>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub context_notes: Option<String>,
    pub attachments: Option<Vec<String>>,
    pub objective: Option<String>,
    pub execution_mode: Option<String>,
    pub surfaces: Option<Vec<String>>,
    pub constraints: Option<Vec<String>>,
    pub dependencies: Option<Vec<String>>,
    pub acceptance: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub review_refs: Option<Vec<String>>,
    pub deliverables: Option<Vec<String>>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    #[serde(alias = "type")]
    pub task_type: Option<String>,
    pub priority: Option<String>,
    pub task_ref: Option<String>,
    pub attempt_ref: Option<String>,
    pub issue_id: Option<String>,
    pub github_item_id: Option<String>,
    pub checked: Option<bool>,
}

pub type DispatcherTaskHandoffInput = DispatcherTaskUpdateInput;

#[derive(Debug, Clone)]
pub(crate) struct DispatcherTaskMutationResult {
    pub(crate) operation: DispatcherTaskOperation,
    pub(crate) task: BoardTaskRecord,
    pub(crate) role: String,
    pub(crate) board_payload: Value,
}

impl DispatcherTaskMutationResult {
    pub(crate) fn response_payload(&self) -> Value {
        let mut payload = self.board_payload.clone();
        payload["operation"] = Value::String(self.operation.as_str().to_string());
        payload["task"] = board_task_value(&self.task, &self.role);
        match self.operation {
            DispatcherTaskOperation::Create => {
                payload["createdTaskId"] = Value::String(self.task.id.clone());
            }
            DispatcherTaskOperation::Update => {
                payload["updatedTaskId"] = Value::String(self.task.id.clone());
            }
            DispatcherTaskOperation::Handoff => {
                payload["handedOffTaskId"] = Value::String(self.task.id.clone());
            }
        }
        payload
    }
}

pub(crate) async fn create_dispatcher_task(
    state: &Arc<AppState>,
    context: DispatcherTaskMutationContext,
    input: DispatcherTaskCreateInput,
) -> Result<DispatcherTaskMutationResult> {
    let project_id = required_project_id(&input.project)?;
    let title = input.title.trim().to_string();
    if title.is_empty() {
        bail!("title is required");
    }

    let board_path = resolve_board_path_for_project(state, &project_id).await?;
    let board = parse_board(&board_path, &project_id);
    let role = normalize_role(input.role.as_deref().unwrap_or("intake")).to_string();
    let caller_session = context.caller_session.as_ref();
    let mut attachments =
        merge_dispatcher_turn_attachments(caller_session, input.attachments.unwrap_or_default());
    let mut notes = trimmed_option(input.context_notes);
    let task_type = trimmed_option(input.task_type);
    let agent = effective_dispatcher_task_agent(caller_session, input.agent);
    let model = effective_dispatcher_task_model(caller_session, input.model);
    let reasoning_effort =
        effective_dispatcher_task_reasoning_effort(caller_session, input.reasoning_effort);
    let mut packet = BoardTaskPacket {
        objective: trimmed_option(input.objective),
        execution_mode: input
            .execution_mode
            .as_deref()
            .and_then(normalize_execution_mode)
            .map(str::to_string),
        surfaces: sanitize_string_list(input.surfaces.unwrap_or_default()),
        constraints: sanitize_string_list(input.constraints.unwrap_or_default()),
        dependencies: sanitize_string_list(input.dependencies.unwrap_or_default()),
        acceptance: sanitize_string_list(input.acceptance.unwrap_or_default()),
        skills: sanitize_string_list(input.skills.unwrap_or_default()),
        review_refs: sanitize_string_list(input.review_refs.unwrap_or_default()),
        deliverables: sanitize_string_list(input.deliverables.unwrap_or_default()),
    };
    enrich_dispatcher_task_handoff(
        state,
        &project_id,
        caller_session,
        task_type.as_deref(),
        &mut notes,
        &mut attachments,
        &mut packet,
    )
    .await;
    validate_dispatcher_task_handoff(
        caller_session,
        &title,
        task_type.as_deref(),
        notes.as_deref(),
        &attachments,
        &packet,
        agent.as_deref(),
    )?;

    let task = BoardTaskRecord {
        id: Uuid::new_v4().to_string(),
        text: build_task_text(&title, input.description.as_deref()),
        checked: input.checked.unwrap_or(false),
        agent,
        model,
        reasoning_effort,
        project: Some(project_id.clone()),
        task_type,
        priority: trimmed_option(input.priority),
        task_ref: Some(next_human_task_ref(&board, &project_id)),
        attempt_ref: trimmed_option(input.attempt_ref),
        issue_id: trimmed_option(input.issue_id),
        github_item_id: trimmed_option(input.github_item_id),
        attachments,
        notes,
        packet,
    };

    insert_task_into_board(&board_path, &role, &task, &project_id)?;

    finalize_dispatcher_task_mutation(
        state,
        context,
        DispatcherTaskOperation::Create,
        project_id,
        task,
        role,
    )
    .await
}

pub(crate) async fn update_dispatcher_task(
    state: &Arc<AppState>,
    context: DispatcherTaskMutationContext,
    input: DispatcherTaskUpdateInput,
) -> Result<DispatcherTaskMutationResult> {
    mutate_existing_dispatcher_task(state, context, DispatcherTaskOperation::Update, input, None)
        .await
}

pub(crate) async fn handoff_dispatcher_task(
    state: &Arc<AppState>,
    context: DispatcherTaskMutationContext,
    input: DispatcherTaskHandoffInput,
) -> Result<DispatcherTaskMutationResult> {
    mutate_existing_dispatcher_task(
        state,
        context,
        DispatcherTaskOperation::Handoff,
        input,
        Some("ready"),
    )
    .await
}

async fn mutate_existing_dispatcher_task(
    state: &Arc<AppState>,
    context: DispatcherTaskMutationContext,
    operation: DispatcherTaskOperation,
    input: DispatcherTaskUpdateInput,
    default_role: Option<&str>,
) -> Result<DispatcherTaskMutationResult> {
    let project_id = required_project_id(&input.project)?;
    let task_lookup = input
        .task
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("task is required"))?;
    let existing = resolve_board_task_record(state, &project_id, task_lookup)
        .await
        .ok_or_else(|| {
            anyhow!("Board task \"{task_lookup}\" not found in project \"{project_id}\"")
        })?;
    let board_path = resolve_board_path_for_project(state, &project_id).await?;
    let mut board = parse_board(&board_path, &project_id);

    let mut located: Option<(usize, usize, BoardTaskRecord)> = None;
    for (column_index, column) in board.columns.iter_mut().enumerate() {
        if let Some(task_index) = column.tasks.iter().position(|task| task.id == existing.id) {
            let task = column.tasks.remove(task_index);
            located = Some((column_index, task_index, task));
            break;
        }
    }

    let Some((source_column_index, source_task_index, mut task)) = located else {
        bail!(
            "Board task \"{}\" could not be updated because it disappeared from the board",
            existing.id
        );
    };

    let caller_session = context.caller_session.as_ref();
    let source_role = board.columns[source_column_index].role.clone();
    apply_task_update(&mut task, &input, &project_id);
    task.attachments = merge_dispatcher_turn_attachments(caller_session, task.attachments.clone());
    enrich_dispatcher_task_handoff(
        state,
        &project_id,
        caller_session,
        task.task_type.as_deref(),
        &mut task.notes,
        &mut task.attachments,
        &mut task.packet,
    )
    .await;
    validate_dispatcher_task_handoff(
        caller_session,
        split_task_text(&task.text).0.as_str(),
        task.task_type.as_deref(),
        task.notes.as_deref(),
        &task.attachments,
        &task.packet,
        task.agent.as_deref(),
    )?;
    let target_role = input
        .role
        .as_deref()
        .map(normalize_role)
        .or(default_role)
        .unwrap_or(source_role.as_str())
        .to_string();
    insert_task_at_position(
        &mut board,
        task.clone(),
        &source_role,
        source_task_index,
        &target_role,
        input.target_index,
    );
    write_parsed_board(&board_path, &board, &project_id)?;

    finalize_dispatcher_task_mutation(state, context, operation, project_id, task, target_role)
        .await
}

async fn finalize_dispatcher_task_mutation(
    state: &Arc<AppState>,
    context: DispatcherTaskMutationContext,
    operation: DispatcherTaskOperation,
    project_id: String,
    task: BoardTaskRecord,
    role: String,
) -> Result<DispatcherTaskMutationResult> {
    state
        .push_board_activity(
            &project_id,
            context.activity_source,
            operation.board_activity_action(),
            task.text.clone(),
        )
        .await;
    state.publish_snapshot().await;

    if let Some(thread_id) = effective_dispatcher_thread_id(&context) {
        if let Err(err) = state
            .record_dispatcher_task_lifecycle_event(&thread_id, operation, &task, &role)
            .await
        {
            tracing::warn!(
                thread_id = %thread_id,
                task_id = %task.id,
                error = %err,
                "failed to record dispatcher task lifecycle event"
            );
        }
    }

    let board_payload = load_board_response(state, &project_id)
        .await
        .map_err(|(_, message)| anyhow!(message))?;

    Ok(DispatcherTaskMutationResult {
        operation,
        task,
        role,
        board_payload,
    })
}

fn effective_dispatcher_thread_id(context: &DispatcherTaskMutationContext) -> Option<String> {
    context.dispatcher_thread_id.clone().or_else(|| {
        context
            .caller_session
            .as_ref()
            .filter(|session| is_acp_dispatcher_session(session))
            .map(|session| session.id.clone())
    })
}

fn board_task_value(task: &BoardTaskRecord, role: &str) -> Value {
    let (title, description) = split_task_text(&task.text);
    json!({
        "id": task.id,
        "title": title,
        "description": description,
        "text": task.text,
        "role": role,
        "checked": task.checked,
        "agent": task.agent,
        "model": task.model,
        "reasoningEffort": task.reasoning_effort,
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
            "surfaces": task.packet.surfaces.clone(),
            "constraints": task.packet.constraints.clone(),
            "dependencies": task.packet.dependencies.clone(),
            "acceptance": task.packet.acceptance.clone(),
            "skills": task.packet.skills.clone(),
            "reviewRefs": task.packet.review_refs.clone(),
            "deliverables": task.packet.deliverables.clone(),
        }
    })
}

fn required_project_id(project: &Option<String>) -> Result<String> {
    project
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("project is required"))
}

fn trimmed_option(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn sanitize_string_list(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn is_acp_dispatcher_session(session: &SessionRecord) -> bool {
    session.metadata.get("sessionKind").map(String::as_str) == Some(ACP_SESSION_KIND)
}

fn latest_dispatcher_turn_attachments(session: &SessionRecord) -> Vec<String> {
    session
        .conversation
        .iter()
        .rev()
        .find(|entry| entry.kind == "user_message")
        .map(|entry| sanitize_string_list(entry.attachments.clone()))
        .unwrap_or_default()
}

fn latest_dispatcher_turn_text(session: &SessionRecord) -> Option<String> {
    session
        .conversation
        .iter()
        .rev()
        .find(|entry| entry.kind == "user_message")
        .and_then(|entry| trimmed_option(Some(entry.text.clone())))
}

fn dispatcher_active_skills(session: &SessionRecord) -> Vec<String> {
    session
        .metadata
        .get(ACP_ACTIVE_SKILLS_METADATA_KEY)
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .map(sanitize_string_list)
        .unwrap_or_default()
}

fn attachment_looks_like_url(value: &str) -> bool {
    matches!(
        url::Url::parse(value).ok().as_ref().map(url::Url::scheme),
        Some("http" | "https")
    )
}

fn normalize_attachment_surface(
    workspace_root: &Path,
    project_root: &Path,
    attachment: &str,
) -> Option<String> {
    let trimmed = attachment.trim();
    if trimmed.is_empty() || attachment_looks_like_url(trimmed) {
        return None;
    }

    let candidate = if trimmed.starts_with("file://") {
        url::Url::parse(trimmed).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(trimmed)
    };

    if !candidate.is_absolute() {
        return Some(trimmed.replace('\\', "/"));
    }

    let display = candidate
        .strip_prefix(project_root)
        .or_else(|_| candidate.strip_prefix(workspace_root))
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| candidate.to_string_lossy().replace('\\', "/"));

    (!display.trim().is_empty()).then_some(display)
}

fn attachment_review_ref(
    workspace_root: &Path,
    project_root: &Path,
    attachment: &str,
) -> Option<String> {
    let trimmed = attachment.trim();
    if trimmed.is_empty() {
        return None;
    }
    if attachment_looks_like_url(trimmed) {
        return Some(trimmed.to_string());
    }
    normalize_attachment_surface(workspace_root, project_root, trimmed)
}

async fn enrich_dispatcher_task_handoff(
    state: &AppState,
    project_id: &str,
    caller_session: Option<&SessionRecord>,
    task_type: Option<&str>,
    notes: &mut Option<String>,
    attachments: &mut Vec<String>,
    packet: &mut BoardTaskPacket,
) {
    let Some(session) = caller_session.filter(|session| is_acp_dispatcher_session(session)) else {
        return;
    };

    if notes.is_none() {
        *notes = latest_dispatcher_turn_text(session);
    }

    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(project_id) else {
        if packet.skills.is_empty() {
            packet.skills = dispatcher_active_skills(session);
        } else {
            packet.skills = sanitize_string_list(packet.skills.clone());
        }
        return;
    };
    let project_root = state.resolve_project_path(project);

    let inferred_surfaces = attachments
        .iter()
        .filter_map(|attachment| {
            normalize_attachment_surface(&state.workspace_path, &project_root, attachment)
        })
        .collect::<Vec<_>>();
    let inferred_review_refs = attachments
        .iter()
        .filter_map(|attachment| {
            attachment_review_ref(&state.workspace_path, &project_root, attachment)
        })
        .collect::<Vec<_>>();

    if !inferred_surfaces.is_empty() {
        let mut merged = packet.surfaces.clone();
        merged.extend(inferred_surfaces);
        packet.surfaces = sanitize_string_list(merged);
    } else {
        packet.surfaces = sanitize_string_list(packet.surfaces.clone());
    }

    if task_type
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("review"))
    {
        let mut merged = packet.review_refs.clone();
        merged.extend(inferred_review_refs);
        packet.review_refs = sanitize_string_list(merged);
    } else {
        packet.review_refs = sanitize_string_list(packet.review_refs.clone());
    }

    if packet.skills.is_empty() {
        packet.skills = dispatcher_active_skills(session);
    } else {
        packet.skills = sanitize_string_list(packet.skills.clone());
    }

    *attachments = sanitize_string_list(attachments.clone());
}

fn merge_dispatcher_turn_attachments(
    caller_session: Option<&SessionRecord>,
    attachments: Vec<String>,
) -> Vec<String> {
    let mut effective = sanitize_string_list(attachments);
    let Some(session) = caller_session.filter(|session| is_acp_dispatcher_session(session)) else {
        return effective;
    };

    for attachment in latest_dispatcher_turn_attachments(session) {
        if !effective.iter().any(|item| item == &attachment) {
            effective.push(attachment);
        }
    }

    effective
}

fn effective_dispatcher_task_agent(
    caller_session: Option<&SessionRecord>,
    agent: Option<String>,
) -> Option<String> {
    trimmed_option(agent).or_else(|| {
        caller_session
            .filter(|session| is_acp_dispatcher_session(session))
            .map(dispatcher_preferred_implementation_agent)
    })
}

fn effective_dispatcher_task_model(
    caller_session: Option<&SessionRecord>,
    model: Option<String>,
) -> Option<String> {
    trimmed_option(model).or_else(|| {
        caller_session
            .filter(|session| is_acp_dispatcher_session(session))
            .and_then(dispatcher_preferred_implementation_model)
    })
}

fn effective_dispatcher_task_reasoning_effort(
    caller_session: Option<&SessionRecord>,
    reasoning_effort: Option<String>,
) -> Option<String> {
    trimmed_option(reasoning_effort)
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| {
            caller_session
                .filter(|session| is_acp_dispatcher_session(session))
                .and_then(dispatcher_preferred_implementation_reasoning_effort)
                .map(|value| value.to_ascii_lowercase())
        })
}

fn validate_dispatcher_task_handoff(
    caller_session: Option<&SessionRecord>,
    title: &str,
    task_type: Option<&str>,
    notes: Option<&str>,
    attachments: &[String],
    packet: &BoardTaskPacket,
    agent: Option<&str>,
) -> Result<()> {
    if !caller_session.is_some_and(is_acp_dispatcher_session) {
        return Ok(());
    }

    let mut missing = Vec::new();
    if agent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        missing.push("agent");
    }
    if packet
        .objective
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        missing.push("objective");
    }
    if packet.execution_mode.is_none() {
        missing.push("execution_mode");
    }
    if packet.acceptance.is_empty() {
        missing.push("acceptance");
    }
    if packet.skills.is_empty() {
        missing.push("skills");
    }
    if packet.deliverables.is_empty() {
        missing.push("deliverables");
    }

    let review_task = task_type
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("review"));
    if review_task {
        if packet.review_refs.is_empty() {
            missing.push("review_refs");
        }
        if packet.surfaces.is_empty() {
            missing.push("surfaces");
        }
    } else if packet.surfaces.is_empty() {
        missing.push("surfaces");
    }

    let has_context = notes
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        || !attachments.is_empty()
        || !packet.constraints.is_empty()
        || !packet.dependencies.is_empty()
        || !packet.review_refs.is_empty();
    if !has_context {
        missing.push("context_notes/attachments/dependencies/constraints/review_refs");
    }

    if missing.is_empty() {
        return Ok(());
    }

    let task_kind = if review_task {
        "review"
    } else {
        "implementation"
    };
    bail!(
        "ACP dispatcher task \"{title}\" is missing a launch-ready {task_kind} handoff packet. Missing: {}.",
        missing.join(", ")
    );
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
        let insert_at = target_index.unwrap_or(0).min(target_column.tasks.len());
        target_column.tasks.insert(insert_at, task);
    } else {
        board.columns.push(ParsedBoardColumn {
            role: target_role.to_string(),
            heading: default_heading_for_role(target_role).to_string(),
            tasks: vec![task],
        });
    }
}

fn apply_task_update(
    task: &mut BoardTaskRecord,
    input: &DispatcherTaskUpdateInput,
    project_id: &str,
) {
    let (mut title, mut description) = split_task_text(&task.text);

    if let Some(next_title) = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        title = next_title.to_string();
    }
    if let Some(next_description) = input.description.as_ref() {
        let trimmed = next_description.trim();
        description = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }

    task.text = build_task_text(&title, description.as_deref());
    if let Some(value) = input.agent.as_ref() {
        task.agent = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.model.as_ref() {
        task.model = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.reasoning_effort.as_ref() {
        task.reasoning_effort =
            trimmed_option(Some(value.clone())).map(|item| item.to_ascii_lowercase());
    }
    if let Some(value) = input.task_type.as_ref() {
        task.task_type = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.priority.as_ref() {
        task.priority = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.task_ref.as_ref() {
        task.task_ref = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.attempt_ref.as_ref() {
        task.attempt_ref = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.issue_id.as_ref() {
        task.issue_id = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.github_item_id.as_ref() {
        task.github_item_id = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.context_notes.as_ref() {
        task.notes = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.objective.as_ref() {
        task.packet.objective = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = input.execution_mode.as_deref() {
        task.packet.execution_mode = normalize_execution_mode(value).map(str::to_string);
    }
    if let Some(checked) = input.checked {
        task.checked = checked;
    }
    if let Some(attachments) = input.attachments.as_ref() {
        task.attachments = sanitize_string_list(attachments.clone());
    }
    if let Some(values) = input.surfaces.as_ref() {
        task.packet.surfaces = sanitize_string_list(values.clone());
    }
    if let Some(values) = input.constraints.as_ref() {
        task.packet.constraints = sanitize_string_list(values.clone());
    }
    if let Some(values) = input.dependencies.as_ref() {
        task.packet.dependencies = sanitize_string_list(values.clone());
    }
    if let Some(values) = input.acceptance.as_ref() {
        task.packet.acceptance = sanitize_string_list(values.clone());
    }
    if let Some(values) = input.skills.as_ref() {
        task.packet.skills = sanitize_string_list(values.clone());
    }
    if let Some(values) = input.review_refs.as_ref() {
        task.packet.review_refs = sanitize_string_list(values.clone());
    }
    if let Some(values) = input.deliverables.as_ref() {
        task.packet.deliverables = sanitize_string_list(values.clone());
    }
    if task
        .project
        .as_ref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        task.project = Some(project_id.to_string());
    }
}
