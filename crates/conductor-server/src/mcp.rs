use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::routes::boards::{
    build_task_text, default_heading_for_role, insert_task_into_board, load_board_response,
    next_human_task_ref, normalize_execution_mode, normalize_role, parse_board,
    resolve_board_path_for_project, resolve_board_task_record, split_task_text, write_parsed_board,
    BoardTaskPacket, BoardTaskRecord, ParsedBoard, ParsedBoardColumn,
};
use crate::state::{
    dispatcher_preferred_implementation_agent, dispatcher_preferred_implementation_model,
    dispatcher_preferred_implementation_reasoning_effort, AppState, SessionRecord, SessionStatus,
    SpawnRequest,
};

const MCP_SERVER_NAME: &str = "conductor";
const MCP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const TOOL_DISPATCH: &str = "conductor_dispatch";
const TOOL_LIST_SESSIONS: &str = "conductor_list_sessions";
const TOOL_SESSION_STATUS: &str = "conductor_session_status";
const TOOL_LIST_PROJECTS: &str = "conductor_list_projects";
const TOOL_GET_BOARD: &str = "conductor_get_board";
const TOOL_CREATE_BOARD_TASK: &str = "conductor_create_board_task";
const TOOL_UPDATE_BOARD_TASK: &str = "conductor_update_board_task";
const TOOL_TASK_GRAPH: &str = "conductor_task_graph";
const MCP_CALLER_SESSION_ENV: &str = "CONDUCTOR_SESSION_ID";
const MCP_CALLER_PROJECT_ENV: &str = "CONDUCTOR_PROJECT_ID";
const ACP_SESSION_KIND: &str = "project_dispatcher";
const ACP_APPROVAL_STATE_METADATA_KEY: &str = "acpPlanApprovalState";
const ACP_APPROVAL_GRANTED: &str = "approved_for_next_mutation";

#[async_trait]
pub trait McpBackend: Send + Sync {
    async fn dispatch(&self, args: DispatchArgs) -> Result<McpSessionSummary>;
    async fn list_sessions(&self, args: ListSessionsArgs) -> Result<Vec<McpSessionSummary>>;
    async fn session_status(&self, session_id: &str) -> Result<Option<McpSessionSummary>>;
    async fn list_projects(&self) -> Result<Vec<McpProjectSummary>>;
    async fn get_board(&self, args: GetBoardArgs) -> Result<Value>;
    async fn create_board_task(&self, args: CreateBoardTaskArgs) -> Result<Value>;
    async fn update_board_task(&self, args: UpdateBoardTaskArgs) -> Result<Value>;
    async fn task_graph(&self, args: TaskGraphArgs) -> Result<Value>;
}

#[derive(Clone)]
pub struct AppStateMcpBackend {
    state: Arc<AppState>,
}

impl AppStateMcpBackend {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    async fn resolve_project_id(&self, requested: Option<&str>) -> Result<String> {
        let config = self.state.config.read().await.clone();
        match requested.map(str::trim).filter(|value| !value.is_empty()) {
            Some(project) => {
                if !config.projects.contains_key(project) {
                    let available = config
                        .projects
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ");
                    bail!("Unknown project \"{project}\". Available: {available}");
                }
                Ok(project.to_string())
            }
            None => config
                .projects
                .keys()
                .next()
                .cloned()
                .ok_or_else(|| anyhow!("No projects configured in conductor.yaml")),
        }
    }

    async fn caller_session(&self) -> Result<Option<SessionRecord>> {
        let session_id = std::env::var(MCP_CALLER_SESSION_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(session_id) = session_id else {
            return Ok(None);
        };
        if let Some(session) = self.state.get_session(&session_id).await {
            return Ok(Some(session));
        }
        self.state
            .get_dispatcher_thread(&session_id)
            .await
            .map(Some)
            .ok_or_else(|| anyhow!("MCP caller session \"{session_id}\" was not found"))
    }

    async fn ensure_board_mutation_allowed(&self, project_id: &str) -> Result<()> {
        let Some(session) = self.caller_session().await? else {
            return Ok(());
        };
        if session.metadata.get("sessionKind").map(String::as_str) != Some(ACP_SESSION_KIND) {
            return Ok(());
        }
        let caller_project = std::env::var(MCP_CALLER_PROJECT_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| session.project_id.clone());
        if caller_project != project_id || session.project_id != project_id {
            bail!("ACP dispatcher cannot mutate board tasks for another project");
        }
        let approved = session
            .metadata
            .get(ACP_APPROVAL_STATE_METADATA_KEY)
            .map(String::as_str)
            == Some(ACP_APPROVAL_GRANTED);
        let active_turn = matches!(session.status, SessionStatus::Working);
        if approved && active_turn {
            return Ok(());
        }
        bail!("ACP dispatcher board mutations are disabled for this plan-only turn");
    }
}

#[async_trait]
impl McpBackend for AppStateMcpBackend {
    async fn dispatch(&self, args: DispatchArgs) -> Result<McpSessionSummary> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;

        let session = self
            .state
            .spawn_session(SpawnRequest {
                project_id,
                bridge_id: None,
                prompt: args
                    .prompt
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| args.task.clone()),
                issue_id: None,
                agent: args.agent.clone(),
                use_worktree: Some(true),
                permission_mode: None,
                model: args.model.clone(),
                reasoning_effort: args.reasoning_effort.clone(),
                branch: args.branch.clone(),
                base_branch: args.base_branch.clone(),
                task_id: None,
                task_ref: None,
                attempt_id: None,
                parent_task_id: None,
                retry_of_session_id: None,
                profile: None,
                session_kind: None,
                brief_path: None,
                attachments: Vec::new(),
                source: "mcp".to_string(),
            })
            .await?;

        Ok(McpSessionSummary::from_record(&session))
    }

    async fn list_sessions(&self, args: ListSessionsArgs) -> Result<Vec<McpSessionSummary>> {
        let mut sessions = self.state.all_sessions().await;
        if let Some(project) = args
            .project
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sessions.retain(|session| session.project_id == project);
        }
        if let Some(status) = args
            .status
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            sessions.retain(|session| session.status.to_string() == status);
        }
        Ok(sessions
            .into_iter()
            .map(|session| McpSessionSummary::from_record(&session))
            .collect())
    }

    async fn session_status(&self, session_id: &str) -> Result<Option<McpSessionSummary>> {
        Ok(self
            .state
            .get_session(session_id)
            .await
            .map(|session| McpSessionSummary::from_record(&session)))
    }

    async fn list_projects(&self) -> Result<Vec<McpProjectSummary>> {
        let config = self.state.config.read().await.clone();
        Ok(config
            .projects
            .into_iter()
            .map(|(id, project)| McpProjectSummary {
                id,
                name: project.name,
                repo: project.repo,
                path: project.path,
                default_branch: project.default_branch,
                agent: project.agent,
                runtime: project.runtime,
            })
            .collect())
    }

    async fn get_board(&self, args: GetBoardArgs) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        load_board_response(&self.state, &project_id)
            .await
            .map_err(|(_, message)| anyhow!(message))
    }

    async fn create_board_task(&self, args: CreateBoardTaskArgs) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        self.ensure_board_mutation_allowed(&project_id).await?;
        let caller_session = self.caller_session().await?;
        let title = args.title.trim().to_string();
        if title.is_empty() {
            bail!("title is required");
        }

        let board_path = resolve_board_path_for_project(&self.state, &project_id).await?;
        let board = parse_board(&board_path, &project_id);
        let role = normalize_role(args.role.as_deref().unwrap_or("intake"));
        let attachments = merge_dispatcher_turn_attachments(
            caller_session.as_ref(),
            args.attachments.unwrap_or_default(),
        );
        let notes = trimmed_option(args.context_notes);
        let task_type = trimmed_option(args.task_type);
        let agent = effective_dispatcher_task_agent(caller_session.as_ref(), args.agent);
        let model = effective_dispatcher_task_model(caller_session.as_ref(), args.model);
        let reasoning_effort = effective_dispatcher_task_reasoning_effort(
            caller_session.as_ref(),
            args.reasoning_effort,
        );
        let packet = BoardTaskPacket {
            objective: trimmed_option(args.objective),
            execution_mode: args
                .execution_mode
                .as_deref()
                .and_then(normalize_execution_mode)
                .map(str::to_string),
            surfaces: sanitize_string_list(args.surfaces.unwrap_or_default()),
            constraints: sanitize_string_list(args.constraints.unwrap_or_default()),
            dependencies: sanitize_string_list(args.dependencies.unwrap_or_default()),
            acceptance: sanitize_string_list(args.acceptance.unwrap_or_default()),
            skills: sanitize_string_list(args.skills.unwrap_or_default()),
            review_refs: sanitize_string_list(args.review_refs.unwrap_or_default()),
            deliverables: sanitize_string_list(args.deliverables.unwrap_or_default()),
        };
        validate_dispatcher_task_handoff(
            caller_session.as_ref(),
            &title,
            task_type.as_deref(),
            notes.as_deref(),
            &attachments,
            &packet,
            agent.as_deref(),
        )?;

        let task = BoardTaskRecord {
            id: uuid::Uuid::new_v4().to_string(),
            text: build_task_text(&title, args.description.as_deref()),
            checked: args.checked.unwrap_or(false),
            agent,
            model,
            reasoning_effort,
            project: Some(project_id.clone()),
            task_type,
            priority: trimmed_option(args.priority),
            task_ref: Some(next_human_task_ref(&board, &project_id)),
            attempt_ref: trimmed_option(args.attempt_ref),
            issue_id: trimmed_option(args.issue_id),
            github_item_id: trimmed_option(args.github_item_id),
            attachments,
            notes,
            packet,
        };

        insert_task_into_board(&board_path, role, &task, &project_id)?;
        self.state
            .push_board_activity(&project_id, "mcp", "created task", task.text.clone())
            .await;
        self.state.publish_snapshot().await;

        let mut payload = load_board_response(&self.state, &project_id)
            .await
            .map_err(|(_, message)| anyhow!(message))?;
        payload["createdTaskId"] = Value::String(task.id.clone());
        payload["task"] = board_task_value(&task, role);
        Ok(payload)
    }

    async fn update_board_task(&self, args: UpdateBoardTaskArgs) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        self.ensure_board_mutation_allowed(&project_id).await?;
        let task_lookup = args
            .task
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("task is required"))?;
        let existing = resolve_board_task_record(&self.state, &project_id, task_lookup)
            .await
            .ok_or_else(|| {
                anyhow!("Board task \"{task_lookup}\" not found in project \"{project_id}\"")
            })?;
        let board_path = resolve_board_path_for_project(&self.state, &project_id).await?;
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

        let source_role = board.columns[source_column_index].role.clone();
        apply_board_task_update(&mut task, &args, &project_id);
        let target_role = args
            .role
            .as_deref()
            .map(normalize_role)
            .unwrap_or(source_role.as_str())
            .to_string();
        insert_board_task_at_position(
            &mut board,
            task.clone(),
            &source_role,
            source_task_index,
            &target_role,
            args.target_index,
        );
        write_parsed_board(&board_path, &board, &project_id)?;
        self.state
            .push_board_activity(&project_id, "mcp", "updated task", task.text.clone())
            .await;
        self.state.publish_snapshot().await;

        let mut payload = load_board_response(&self.state, &project_id)
            .await
            .map_err(|(_, message)| anyhow!(message))?;
        payload["updatedTaskId"] = Value::String(task.id.clone());
        payload["task"] = board_task_value(&task, &target_role);
        Ok(payload)
    }

    async fn task_graph(&self, args: TaskGraphArgs) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        let task_lookup = args
            .task
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("task is required"))?;
        let board_task = resolve_board_task_record(&self.state, &project_id, task_lookup)
            .await
            .ok_or_else(|| {
                anyhow!("Board task \"{task_lookup}\" not found in project \"{project_id}\"")
            })?;
        let board_payload = load_board_response(&self.state, &project_id)
            .await
            .map_err(|(_, message)| anyhow!(message))?;
        let task_role = find_board_task_role(&board_payload, &board_task.id);
        let sessions = self.state.all_sessions().await;
        let mut attempts = sessions
            .iter()
            .filter(|session| session.metadata.get("taskId").map(String::as_str) == Some(board_task.id.as_str()))
            .map(|session| {
                json!({
                    "attemptId": session.metadata.get("attemptId").cloned().unwrap_or_else(|| format!("a-{}", session.id)),
                    "sessionId": session.id,
                    "status": session.status,
                    "activity": session.activity,
                    "agent": session.agent,
                    "model": session.model,
                    "branch": session.branch,
                    "summary": session.summary.clone().or_else(|| session.metadata.get("summary").cloned()),
                    "createdAt": session.created_at,
                    "lastActivityAt": session.last_activity_at,
                })
            })
            .collect::<Vec<_>>();
        attempts
            .sort_by(|left, right| left["createdAt"].as_str().cmp(&right["createdAt"].as_str()));

        let mut children = sessions
            .iter()
            .filter(|session| {
                session.metadata.get("parentTaskId").map(String::as_str)
                    == Some(board_task.id.as_str())
            })
            .filter_map(|session| session.metadata.get("taskId").cloned())
            .collect::<Vec<_>>();
        children.sort();
        children.dedup();

        let (title, description) = split_task_text(&board_task.text);
        Ok(json!({
            "projectId": project_id,
            "task": {
                "id": board_task.id,
                "title": title,
                "description": description,
                "role": task_role,
                "taskRef": board_task.task_ref,
                "attemptRef": board_task.attempt_ref,
                "issueId": board_task.issue_id,
                "priority": board_task.priority,
                "agent": board_task.agent,
                "attachments": board_task.attachments,
                "notes": board_task.notes,
            },
            "childrenTaskIds": children,
            "attempts": attempts,
        }))
    }
}

pub async fn serve_stdio(backend: Arc<dyn McpBackend>) -> Result<()> {
    serve_stdio_streams(backend, tokio::io::stdin(), tokio::io::stdout()).await
}

pub async fn serve_stdio_streams<R, W>(
    backend: Arc<dyn McpBackend>,
    reader: R,
    writer: W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut writer = writer;

    while let Some(request) = read_jsonrpc_request(&mut reader).await? {
        if let Some(response) = handle_jsonrpc_request(backend.as_ref(), request).await? {
            write_jsonrpc_response(&mut writer, &response).await?;
            writer.flush().await?;
        }
    }

    Ok(())
}

async fn read_jsonrpc_request<R>(reader: &mut BufReader<R>) -> Result<Option<JsonRpcRequest>>
where
    R: AsyncRead + Unpin,
{
    let mut content_length = None;
    let mut line = String::new();

    loop {
        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            return Ok(None);
        }

        if line == "\r\n" || line == "\n" {
            break;
        }

        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .context("Invalid Content-Length header")?,
                );
            }
        }
    }

    let length = content_length.ok_or_else(|| anyhow!("Missing Content-Length header"))?;
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload)
        .context("Failed to decode JSON-RPC request")
        .map(Some)
}

async fn write_jsonrpc_response<W>(writer: &mut W, response: &JsonRpcResponse) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(response)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(&body).await?;
    Ok(())
}

pub async fn handle_jsonrpc_request(
    backend: &dyn McpBackend,
    request: JsonRpcRequest,
) -> Result<Option<JsonRpcResponse>> {
    let id = request.id.clone();
    let make_response = |payload| {
        id.as_ref().map(|request_id| JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: request_id.clone(),
            payload,
        })
    };

    let payload = match request.method.as_str() {
        "initialize" => JsonRpcPayload::Result(json!({
            "protocolVersion": request
                .params
                .as_ref()
                .and_then(|value| value.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05"),
            "capabilities": {
                "tools": { "listChanged": false }
            },
            "serverInfo": {
                "name": MCP_SERVER_NAME,
                "version": MCP_SERVER_VERSION,
            }
        })),
        "ping" => JsonRpcPayload::Result(json!({})),
        "tools/list" => JsonRpcPayload::Result(json!({
            "tools": tool_definitions(),
        })),
        "resources/list" => JsonRpcPayload::Result(json!({
            "resources": []
        })),
        "resources/templates/list" => JsonRpcPayload::Result(json!({
            "resourceTemplates": []
        })),
        "prompts/list" => JsonRpcPayload::Result(json!({
            "prompts": []
        })),
        "tools/call" => match request.params {
            Some(params) => JsonRpcPayload::Result(handle_tool_call(backend, params).await?),
            None => JsonRpcPayload::Error(JsonRpcError {
                code: -32602,
                message: "Missing tool call params".to_string(),
                data: None,
            }),
        },
        other => JsonRpcPayload::Error(JsonRpcError {
            code: -32601,
            message: format!("Unknown method: {other}"),
            data: None,
        }),
    };

    Ok(make_response(payload))
}

async fn handle_tool_call(backend: &dyn McpBackend, params: Value) -> Result<Value> {
    let call: ToolCallRequest =
        serde_json::from_value(params).context("Invalid tools/call request payload")?;
    let arguments = call.arguments.unwrap_or(Value::Object(Default::default()));

    match call.name.as_str() {
        TOOL_DISPATCH => match serde_json::from_value::<DispatchArgs>(arguments) {
            Ok(args) => match backend.dispatch(args).await {
                Ok(session) => Ok(tool_success(json!(session))),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!("Invalid dispatch arguments: {err}"))),
        },
        TOOL_LIST_SESSIONS => match serde_json::from_value::<ListSessionsArgs>(arguments) {
            Ok(args) => match backend.list_sessions(args).await {
                Ok(sessions) => Ok(tool_success(json!(sessions))),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!(
                "Invalid list_sessions arguments: {err}"
            ))),
        },
        TOOL_SESSION_STATUS => match serde_json::from_value::<SessionStatusArgs>(arguments) {
            Ok(args) => match backend.session_status(&args.session_id).await {
                Ok(Some(session)) => Ok(tool_success(json!(session))),
                Ok(None) => Ok(tool_error(format!(
                    "Session \"{}\" not found",
                    args.session_id
                ))),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!(
                "Invalid session_status arguments: {err}"
            ))),
        },
        TOOL_LIST_PROJECTS => match backend.list_projects().await {
            Ok(projects) => Ok(tool_success(json!(projects))),
            Err(err) => Ok(tool_error(err.to_string())),
        },
        TOOL_GET_BOARD => match serde_json::from_value::<GetBoardArgs>(arguments) {
            Ok(args) => match backend.get_board(args).await {
                Ok(board) => Ok(tool_success(board)),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!("Invalid get_board arguments: {err}"))),
        },
        TOOL_CREATE_BOARD_TASK => match serde_json::from_value::<CreateBoardTaskArgs>(arguments) {
            Ok(args) => match backend.create_board_task(args).await {
                Ok(payload) => Ok(tool_success(payload)),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!(
                "Invalid create_board_task arguments: {err}"
            ))),
        },
        TOOL_UPDATE_BOARD_TASK => match serde_json::from_value::<UpdateBoardTaskArgs>(arguments) {
            Ok(args) => match backend.update_board_task(args).await {
                Ok(payload) => Ok(tool_success(payload)),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!(
                "Invalid update_board_task arguments: {err}"
            ))),
        },
        TOOL_TASK_GRAPH => match serde_json::from_value::<TaskGraphArgs>(arguments) {
            Ok(args) => match backend.task_graph(args).await {
                Ok(payload) => Ok(tool_success(payload)),
                Err(err) => Ok(tool_error(err.to_string())),
            },
            Err(err) => Ok(tool_error(format!("Invalid task_graph arguments: {err}"))),
        },
        other => Ok(tool_error(format!("Unknown tool: {other}"))),
    }
}

fn tool_success(value: Value) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
        }],
        "isError": false,
    })
}

fn tool_error(message: String) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": format!("Error: {message}"),
        }],
        "isError": true,
    })
}

fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: TOOL_DISPATCH.to_string(),
            description: "Create and dispatch a new Conductor session".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "Task prompt for the agent" },
                    "project": { "type": "string", "description": "Optional project ID" },
                    "agent": { "type": "string", "description": "Optional agent override" },
                    "model": { "type": "string", "description": "Optional model override" },
                    "reasoning_effort": { "type": "string", "description": "Optional reasoning effort override" },
                    "branch": { "type": "string", "description": "Optional branch override" },
                    "base_branch": { "type": "string", "description": "Optional base branch override" },
                    "prompt": { "type": "string", "description": "Optional prompt override" }
                },
                "required": ["task"]
            }),
        },
        ToolDefinition {
            name: TOOL_LIST_SESSIONS.to_string(),
            description: "List active Conductor sessions".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project filter" },
                    "status": { "type": "string", "description": "Optional status filter" }
                }
            }),
        },
        ToolDefinition {
            name: TOOL_SESSION_STATUS.to_string(),
            description: "Get the current status for a specific session".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session identifier" }
                },
                "required": ["session_id"]
            }),
        },
        ToolDefinition {
            name: TOOL_LIST_PROJECTS.to_string(),
            description: "List projects configured in conductor.yaml".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolDefinition {
            name: TOOL_GET_BOARD.to_string(),
            description: "Get the current Conductor board snapshot for a project, including lifecycle columns and tasks".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" }
                }
            }),
        },
        ToolDefinition {
            name: TOOL_CREATE_BOARD_TASK.to_string(),
            description: "Create a new task directly on the Conductor board for a project. ACP dispatcher turns must provide a launch-ready handoff packet, and current-turn attachments are inherited automatically.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" },
                    "title": { "type": "string", "description": "Task title" },
                    "description": { "type": "string", "description": "Optional task description" },
                    "context_notes": { "type": "string", "description": "Optional orchestration notes for the task" },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional attachment paths. ACP dispatcher turns also inherit the current turn's recorded attachments." },
                    "objective": { "type": "string", "description": "Explicit objective for the task brief and worker handoff" },
                    "execution_mode": { "type": "string", "description": "Execution mode for spawned work: worktree, main_workspace, or temp_clone" },
                    "surfaces": { "type": "array", "items": { "type": "string" }, "description": "Exact files, folders, APIs, or product surfaces to inspect" },
                    "constraints": { "type": "array", "items": { "type": "string" }, "description": "Non-negotiable constraints, guardrails, or rules" },
                    "dependencies": { "type": "array", "items": { "type": "string" }, "description": "Upstream tasks, context, or blockers this task depends on" },
                    "acceptance": { "type": "array", "items": { "type": "string" }, "description": "Acceptance criteria for completion or review sign-off" },
                    "skills": { "type": "array", "items": { "type": "string" }, "description": "Suggested skills, domains, or tools the worker should lean on" },
                    "review_refs": { "type": "array", "items": { "type": "string" }, "description": "PR URLs, issue URLs, commits, or branch refs to review" },
                    "deliverables": { "type": "array", "items": { "type": "string" }, "description": "Expected outputs such as code patch, review report, migration, or checklist update" },
                    "agent": { "type": "string", "description": "Preferred coding agent" },
                    "model": { "type": "string", "description": "Preferred coding model" },
                    "reasoning_effort": { "type": "string", "description": "Preferred coding reasoning level" },
                    "role": { "type": "string", "description": "Board lifecycle column (intake, ready, dispatching, inProgress, needsInput, blocked, errored, review, merge, done, cancelled)" },
                    "task_type": { "type": "string", "description": "Task type label such as feature, fix, review, chore, docs" },
                    "priority": { "type": "string", "description": "Priority label" },
                    "issue_id": { "type": "string", "description": "Optional linked issue identifier" },
                    "attempt_ref": { "type": "string", "description": "Optional linked session or attempt reference" },
                    "checked": { "type": "boolean", "description": "Optional checkbox state" }
                },
                "required": ["title"]
            }),
        },
        ToolDefinition {
            name: TOOL_UPDATE_BOARD_TASK.to_string(),
            description: "Update an existing Conductor board task by task ID, task ref, or linked issue ID".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" },
                    "task": { "type": "string", "description": "Board task ID, taskRef, or linked issue ID" },
                    "role": { "type": "string", "description": "Optional target lifecycle column" },
                    "target_index": { "type": "integer", "description": "Optional insertion index in the target column" },
                    "title": { "type": "string", "description": "Optional replacement title" },
                    "description": { "type": "string", "description": "Optional replacement description" },
                    "context_notes": { "type": "string", "description": "Optional replacement notes" },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement attachment paths" },
                    "objective": { "type": "string", "description": "Optional replacement objective for the task brief" },
                    "execution_mode": { "type": "string", "description": "Optional execution mode override: worktree, main_workspace, or temp_clone" },
                    "surfaces": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement surfaces list" },
                    "constraints": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement constraints list" },
                    "dependencies": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement dependencies list" },
                    "acceptance": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement acceptance criteria list" },
                    "skills": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement skills list" },
                    "review_refs": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement review references list" },
                    "deliverables": { "type": "array", "items": { "type": "string" }, "description": "Optional replacement deliverables list" },
                    "agent": { "type": "string", "description": "Optional preferred coding agent" },
                    "model": { "type": "string", "description": "Optional preferred coding model" },
                    "reasoning_effort": { "type": "string", "description": "Optional preferred coding reasoning level" },
                    "task_type": { "type": "string", "description": "Optional task type label" },
                    "priority": { "type": "string", "description": "Optional priority label" },
                    "task_ref": { "type": "string", "description": "Optional replacement human task ref" },
                    "attempt_ref": { "type": "string", "description": "Optional linked session or attempt ref" },
                    "issue_id": { "type": "string", "description": "Optional linked issue ID" },
                    "github_item_id": { "type": "string", "description": "Optional linked GitHub item ID" },
                    "checked": { "type": "boolean", "description": "Optional checkbox state" }
                },
                "required": ["task"]
            }),
        },
        ToolDefinition {
            name: TOOL_TASK_GRAPH.to_string(),
            description: "Inspect a board task's lifecycle, including linked attempts and child tasks".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" },
                    "task": { "type": "string", "description": "Board task ID, taskRef, or linked issue ID" }
                },
                "required": ["task"]
            }),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DispatchArgs {
    pub task: String,
    pub project: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ListSessionsArgs {
    pub project: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GetBoardArgs {
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CreateBoardTaskArgs {
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
pub struct UpdateBoardTaskArgs {
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskGraphArgs {
    pub project: Option<String>,
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStatusArgs {
    pub session_id: String,
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

fn insert_board_task_at_position(
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

fn apply_board_task_update(
    task: &mut BoardTaskRecord,
    args: &UpdateBoardTaskArgs,
    project_id: &str,
) {
    let (mut title, mut description) = split_task_text(&task.text);

    if let Some(next_title) = args
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        title = next_title.to_string();
    }
    if let Some(next_description) = args.description.as_ref() {
        let trimmed = next_description.trim();
        description = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }

    task.text = build_task_text(&title, description.as_deref());
    if let Some(value) = args.agent.as_ref() {
        task.agent = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.model.as_ref() {
        task.model = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.reasoning_effort.as_ref() {
        task.reasoning_effort =
            trimmed_option(Some(value.clone())).map(|item| item.to_ascii_lowercase());
    }
    if let Some(value) = args.task_type.as_ref() {
        task.task_type = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.priority.as_ref() {
        task.priority = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.task_ref.as_ref() {
        task.task_ref = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.attempt_ref.as_ref() {
        task.attempt_ref = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.issue_id.as_ref() {
        task.issue_id = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.github_item_id.as_ref() {
        task.github_item_id = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.context_notes.as_ref() {
        task.notes = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.objective.as_ref() {
        task.packet.objective = trimmed_option(Some(value.clone()));
    }
    if let Some(value) = args.execution_mode.as_deref() {
        task.packet.execution_mode = normalize_execution_mode(value).map(str::to_string);
    }
    if let Some(checked) = args.checked {
        task.checked = checked;
    }
    if let Some(attachments) = args.attachments.as_ref() {
        task.attachments = sanitize_string_list(attachments.clone());
    }
    if let Some(values) = args.surfaces.as_ref() {
        task.packet.surfaces = sanitize_string_list(values.clone());
    }
    if let Some(values) = args.constraints.as_ref() {
        task.packet.constraints = sanitize_string_list(values.clone());
    }
    if let Some(values) = args.dependencies.as_ref() {
        task.packet.dependencies = sanitize_string_list(values.clone());
    }
    if let Some(values) = args.acceptance.as_ref() {
        task.packet.acceptance = sanitize_string_list(values.clone());
    }
    if let Some(values) = args.skills.as_ref() {
        task.packet.skills = sanitize_string_list(values.clone());
    }
    if let Some(values) = args.review_refs.as_ref() {
        task.packet.review_refs = sanitize_string_list(values.clone());
    }
    if let Some(values) = args.deliverables.as_ref() {
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

fn board_task_value(task: &BoardTaskRecord, role: &str) -> Value {
    let (title, description) = split_task_text(&task.text);
    json!({
        "id": task.id,
        "role": role,
        "title": title,
        "description": description,
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
            "objective": task.packet.objective.clone(),
            "executionMode": task.packet.execution_mode.clone(),
            "surfaces": task.packet.surfaces.clone(),
            "constraints": task.packet.constraints.clone(),
            "dependencies": task.packet.dependencies.clone(),
            "acceptance": task.packet.acceptance.clone(),
            "skills": task.packet.skills.clone(),
            "reviewRefs": task.packet.review_refs.clone(),
            "deliverables": task.packet.deliverables.clone(),
        },
    })
}

fn find_board_task_role(board_payload: &Value, task_id: &str) -> Option<String> {
    board_payload
        .get("columns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|column| {
            let role = column.get("role").and_then(Value::as_str)?;
            let tasks = column.get("tasks").and_then(Value::as_array)?;
            tasks
                .iter()
                .any(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
                .then(|| role.to_string())
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionSummary {
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub activity: Option<String>,
    pub branch: Option<String>,
    pub issue_id: Option<String>,
    pub workspace_path: Option<String>,
    pub summary: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
}

impl McpSessionSummary {
    fn from_record(record: &SessionRecord) -> Self {
        Self {
            id: record.id.clone(),
            project_id: record.project_id.clone(),
            status: record.status.to_string(),
            activity: record.activity.clone(),
            branch: record.branch.clone(),
            issue_id: record.issue_id.clone(),
            workspace_path: record.workspace_path.clone(),
            summary: record
                .summary
                .clone()
                .or_else(|| record.metadata.get("summary").cloned()),
            created_at: record.created_at.clone(),
            last_activity_at: record.last_activity_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectSummary {
    pub id: String,
    pub name: Option<String>,
    pub repo: Option<String>,
    pub path: String,
    pub default_branch: String,
    pub agent: Option<String>,
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolDefinition {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct ToolCallRequest {
    name: String,
    arguments: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(flatten)]
    pub payload: JsonRpcPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum JsonRpcPayload {
    Result(Value),
    Error(JsonRpcError),
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use conductor_core::config::{ConductorConfig, PreferencesConfig, ProjectConfig};
    use conductor_db::Database;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::sync::{Arc, OnceLock};
    use tokio::io::duplex;
    use tokio::sync::Mutex;
    use uuid::Uuid;

    struct MockBackend;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    async fn build_app_state(label: &str) -> (std::path::PathBuf, Arc<AppState>) {
        let root = std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        fs::create_dir_all(&repo).expect("test repo should be created");
        fs::write(
            repo.join("CONDUCTOR.md"),
            [
                "## Inbox",
                "",
                "## Ready to Dispatch",
                "",
                "## Dispatching",
                "",
            ]
            .join("\n"),
        )
        .expect("board should be created");

        let config = ConductorConfig {
            workspace: root.clone(),
            preferences: PreferencesConfig {
                coding_agent: "codex".to_string(),
                ..PreferencesConfig::default()
            },
            projects: BTreeMap::from([(
                "demo".to_string(),
                ProjectConfig {
                    path: repo.to_string_lossy().to_string(),
                    agent: Some("codex".to_string()),
                    runtime: Some("ttyd".to_string()),
                    default_branch: "main".to_string(),
                    ..ProjectConfig::default()
                },
            )]),
            ..ConductorConfig::default()
        };
        let db = Database::in_memory()
            .await
            .expect("test db should initialize");
        let state = AppState::new(root.join("conductor.yaml"), config, db).await;
        (root, state)
    }

    #[async_trait]
    impl McpBackend for MockBackend {
        async fn dispatch(&self, args: DispatchArgs) -> Result<McpSessionSummary> {
            Ok(McpSessionSummary {
                id: "session-1".to_string(),
                project_id: args.project.unwrap_or_else(|| "demo".to_string()),
                status: "working".to_string(),
                activity: Some("active".to_string()),
                branch: Some("session/demo".to_string()),
                issue_id: None,
                workspace_path: Some("/tmp/demo".to_string()),
                summary: Some(args.task),
                created_at: Utc::now().to_rfc3339(),
                last_activity_at: Utc::now().to_rfc3339(),
            })
        }

        async fn list_sessions(&self, _args: ListSessionsArgs) -> Result<Vec<McpSessionSummary>> {
            Ok(vec![McpSessionSummary {
                id: "session-1".to_string(),
                project_id: "demo".to_string(),
                status: "needs_input".to_string(),
                activity: Some("waiting_input".to_string()),
                branch: Some("session/demo".to_string()),
                issue_id: None,
                workspace_path: Some("/tmp/demo".to_string()),
                summary: Some("Ready".to_string()),
                created_at: Utc::now().to_rfc3339(),
                last_activity_at: Utc::now().to_rfc3339(),
            }])
        }

        async fn session_status(&self, session_id: &str) -> Result<Option<McpSessionSummary>> {
            Ok((session_id == "session-1").then(|| McpSessionSummary {
                id: "session-1".to_string(),
                project_id: "demo".to_string(),
                status: "needs_input".to_string(),
                activity: Some("waiting_input".to_string()),
                branch: Some("session/demo".to_string()),
                issue_id: None,
                workspace_path: Some("/tmp/demo".to_string()),
                summary: Some("Ready".to_string()),
                created_at: Utc::now().to_rfc3339(),
                last_activity_at: Utc::now().to_rfc3339(),
            }))
        }

        async fn list_projects(&self) -> Result<Vec<McpProjectSummary>> {
            Ok(vec![McpProjectSummary {
                id: "demo".to_string(),
                name: Some("Demo".to_string()),
                repo: Some("acme/widgets".to_string()),
                path: "/tmp/demo".to_string(),
                default_branch: "main".to_string(),
                agent: Some("codex".to_string()),
                runtime: Some("ttyd".to_string()),
            }])
        }

        async fn get_board(&self, args: GetBoardArgs) -> Result<Value> {
            Ok(json!({
                "projectId": args.project.unwrap_or_else(|| "demo".to_string()),
                "columns": [],
            }))
        }

        async fn create_board_task(&self, args: CreateBoardTaskArgs) -> Result<Value> {
            Ok(json!({
                "createdTaskId": "task-1",
                "task": {
                    "title": args.title,
                }
            }))
        }

        async fn update_board_task(&self, args: UpdateBoardTaskArgs) -> Result<Value> {
            Ok(json!({
                "updatedTaskId": "task-1",
                "task": {
                    "task": args.task,
                }
            }))
        }

        async fn task_graph(&self, args: TaskGraphArgs) -> Result<Value> {
            Ok(json!({
                "task": {
                    "id": args.task.unwrap_or_else(|| "task-1".to_string()),
                },
                "attempts": [],
            }))
        }
    }

    #[tokio::test]
    async fn tools_list_exposes_eight_tools() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(1)),
                method: "tools/list".to_string(),
                params: None,
            },
        )
        .await
        .unwrap()
        .unwrap();

        let JsonRpcPayload::Result(result) = response.payload else {
            panic!("expected tools/list result payload");
        };
        assert_eq!(result["tools"].as_array().unwrap().len(), 8);
    }

    #[tokio::test]
    async fn tools_call_dispatch_returns_text_content() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(2)),
                method: "tools/call".to_string(),
                params: Some(json!({
                    "name": TOOL_DISPATCH,
                    "arguments": {
                        "task": "Investigate bug",
                        "project": "demo"
                    }
                })),
            },
        )
        .await
        .unwrap()
        .unwrap();

        let JsonRpcPayload::Result(result) = response.payload else {
            panic!("expected tools/call result payload");
        };
        assert_eq!(result["isError"], false);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Investigate bug"));
    }

    #[tokio::test]
    async fn unknown_tool_returns_mcp_error_payload() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(3)),
                method: "tools/call".to_string(),
                params: Some(json!({
                    "name": "unknown",
                    "arguments": {}
                })),
            },
        )
        .await
        .unwrap()
        .unwrap();

        let JsonRpcPayload::Result(result) = response.payload else {
            panic!("expected tools/call result payload");
        };
        assert_eq!(result["isError"], true);
    }

    #[tokio::test]
    async fn tools_call_create_board_task_returns_task_payload() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(4)),
                method: "tools/call".to_string(),
                params: Some(json!({
                    "name": TOOL_CREATE_BOARD_TASK,
                    "arguments": {
                        "project": "demo",
                        "title": "Phase 2 heartbeat integration"
                    }
                })),
            },
        )
        .await
        .unwrap()
        .unwrap();

        let JsonRpcPayload::Result(result) = response.payload else {
            panic!("expected tools/call result payload");
        };
        assert_eq!(result["isError"], false);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Phase 2 heartbeat integration"));
    }

    #[tokio::test]
    async fn acp_dispatcher_can_create_board_tasks_without_extra_approval_turn() {
        let _env_guard = env_lock().lock().await;
        let (root, state) = build_app_state("mcp-acp-default-create-task").await;
        let mut dispatcher = state
            .create_project_dispatcher_thread(
                "demo",
                crate::state::CreateDispatcherThreadOptions::default(),
            )
            .await
            .expect("dispatcher thread should be created");
        dispatcher.status = SessionStatus::Working;
        state
            .replace_dispatcher_thread(dispatcher.clone())
            .await
            .expect("dispatcher thread should persist");

        std::env::set_var(MCP_CALLER_SESSION_ENV, &dispatcher.id);
        std::env::set_var(MCP_CALLER_PROJECT_ENV, "demo");

        let backend = AppStateMcpBackend::new(Arc::clone(&state));
        let payload = backend
            .create_board_task(CreateBoardTaskArgs {
                project: Some("demo".to_string()),
                title: "Dispatcher created task".to_string(),
                objective: Some("Create the implementation handoff task on the board.".to_string()),
                execution_mode: Some("worktree".to_string()),
                surfaces: Some(vec!["crates/conductor-server/src/mcp.rs".to_string()]),
                constraints: Some(vec!["Preserve existing board semantics.".to_string()]),
                acceptance: Some(vec!["Task is written to CONDUCTOR.md.".to_string()]),
                skills: Some(vec!["rust".to_string(), "board orchestration".to_string()]),
                deliverables: Some(vec!["launch-ready board task".to_string()]),
                role: Some("intake".to_string()),
                ..CreateBoardTaskArgs::default()
            })
            .await
            .expect("ACP dispatcher should be allowed to create a board task");

        assert_eq!(payload["task"]["title"], "Dispatcher created task");
        assert_eq!(payload["task"]["agent"], "codex");
        let board_contents = fs::read_to_string(root.join("repo").join("CONDUCTOR.md"))
            .expect("board should be readable");
        assert!(board_contents.contains("Dispatcher created task"));

        std::env::remove_var(MCP_CALLER_SESSION_ENV);
        std::env::remove_var(MCP_CALLER_PROJECT_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn acp_dispatcher_create_task_inherits_turn_attachments() {
        let _env_guard = env_lock().lock().await;
        let (root, state) = build_app_state("mcp-acp-attachment-handoff").await;
        let mut dispatcher = state
            .create_project_dispatcher_thread(
                "demo",
                crate::state::CreateDispatcherThreadOptions::default(),
            )
            .await
            .expect("dispatcher thread should be created");
        dispatcher.status = SessionStatus::Working;
        dispatcher
            .conversation
            .push(crate::state::ConversationEntry {
                id: Uuid::new_v4().to_string(),
                kind: "user_message".to_string(),
                source: "dashboard".to_string(),
                text: "Please review the incident doc and create tasks.".to_string(),
                created_at: Utc::now().to_rfc3339(),
                attachments: vec!["docs/incidents/dispatcher-audit.md".to_string()],
                metadata: HashMap::new(),
            });
        state
            .replace_dispatcher_thread(dispatcher.clone())
            .await
            .expect("dispatcher thread should persist");

        std::env::set_var(MCP_CALLER_SESSION_ENV, &dispatcher.id);
        std::env::set_var(MCP_CALLER_PROJECT_ENV, "demo");

        let backend = AppStateMcpBackend::new(Arc::clone(&state));
        let payload = backend
            .create_board_task(CreateBoardTaskArgs {
                project: Some("demo".to_string()),
                title: "Dispatcher attachment handoff".to_string(),
                objective: Some(
                    "Turn the incident doc into an actionable worker task.".to_string(),
                ),
                execution_mode: Some("main_workspace".to_string()),
                surfaces: Some(vec![
                    "crates/conductor-server/src/state/acp_dispatcher.rs".to_string(),
                    "crates/conductor-server/src/mcp.rs".to_string(),
                ]),
                review_refs: Some(vec!["docs/incidents/dispatcher-audit.md".to_string()]),
                acceptance: Some(vec![
                    "Task packet references the incident context.".to_string()
                ]),
                skills: Some(vec!["rust".to_string(), "dispatcher review".to_string()]),
                deliverables: Some(vec!["review findings".to_string()]),
                task_type: Some("review".to_string()),
                role: Some("review".to_string()),
                ..CreateBoardTaskArgs::default()
            })
            .await
            .expect("ACP dispatcher should be allowed to create a board task");

        assert_eq!(payload["task"]["agent"], "codex");
        assert_eq!(
            payload["task"]["attachments"],
            json!(["docs/incidents/dispatcher-audit.md"])
        );
        let board_contents = fs::read_to_string(root.join("repo").join("CONDUCTOR.md"))
            .expect("board should be readable");
        assert!(board_contents.contains("attachments:docs/incidents/dispatcher-audit.md"));

        std::env::remove_var(MCP_CALLER_SESSION_ENV);
        std::env::remove_var(MCP_CALLER_PROJECT_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn acp_dispatcher_rejects_incomplete_task_handoff_packets() {
        let _env_guard = env_lock().lock().await;
        let (root, state) = build_app_state("mcp-acp-reject-thin-task").await;
        let mut dispatcher = state
            .create_project_dispatcher_thread(
                "demo",
                crate::state::CreateDispatcherThreadOptions::default(),
            )
            .await
            .expect("dispatcher thread should be created");
        dispatcher.status = SessionStatus::Working;
        state
            .replace_dispatcher_thread(dispatcher.clone())
            .await
            .expect("dispatcher thread should persist");

        std::env::set_var(MCP_CALLER_SESSION_ENV, &dispatcher.id);
        std::env::set_var(MCP_CALLER_PROJECT_ENV, "demo");

        let backend = AppStateMcpBackend::new(Arc::clone(&state));
        let err = backend
            .create_board_task(CreateBoardTaskArgs {
                project: Some("demo".to_string()),
                title: "Thin dispatcher task".to_string(),
                role: Some("intake".to_string()),
                ..CreateBoardTaskArgs::default()
            })
            .await
            .expect_err("ACP dispatcher should be blocked from creating thin task packets");

        let message = err.to_string();
        assert!(message.contains("launch-ready implementation handoff packet"));
        assert!(message.contains("objective"));
        assert!(message.contains("execution_mode"));
        assert!(message.contains("surfaces"));
        assert!(message.contains("acceptance"));
        assert!(message.contains("skills"));
        assert!(message.contains("deliverables"));

        let board_contents = fs::read_to_string(root.join("repo").join("CONDUCTOR.md"))
            .expect("board should be readable");
        assert!(!board_contents.contains("Thin dispatcher task"));

        std::env::remove_var(MCP_CALLER_SESSION_ENV);
        std::env::remove_var(MCP_CALLER_PROJECT_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn resources_list_returns_empty_payload() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(5)),
                method: "resources/list".to_string(),
                params: None,
            },
        )
        .await
        .unwrap()
        .unwrap();

        let JsonRpcPayload::Result(result) = response.payload else {
            panic!("expected resources/list result payload");
        };
        assert_eq!(result["resources"], json!([]));
    }

    #[tokio::test]
    async fn stdio_response_is_framed_with_content_length() {
        let response = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: json!(1),
            payload: JsonRpcPayload::Result(json!({ "ok": true })),
        };
        let (mut client, mut server) = duplex(1024);

        write_jsonrpc_response(&mut server, &response)
            .await
            .unwrap();
        server.shutdown().await.unwrap();

        let mut output = Vec::new();
        client.read_to_end(&mut output).await.unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.starts_with("Content-Length: "));
        assert!(output.contains("\r\n\r\n{\"jsonrpc\":\"2.0\""));
    }
}
