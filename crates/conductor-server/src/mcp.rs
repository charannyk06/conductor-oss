use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::dispatcher_task_lifecycle::{
    create_dispatcher_task, handoff_dispatcher_task, update_dispatcher_task,
    DispatcherTaskCreateInput, DispatcherTaskHandoffInput, DispatcherTaskMutationContext,
    DispatcherTaskUpdateInput,
};
use crate::routes::boards::{load_board_response, resolve_board_task_record, split_task_text};
use crate::state::{AppState, SessionRecord, SessionStatus, SpawnRequest};

const MCP_SERVER_NAME: &str = "conductor";
const MCP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const TOOL_DISPATCH: &str = "conductor_dispatch";
const TOOL_LIST_SESSIONS: &str = "conductor_list_sessions";
const TOOL_SESSION_STATUS: &str = "conductor_session_status";
const TOOL_LIST_PROJECTS: &str = "conductor_list_projects";
const TOOL_GET_BOARD: &str = "conductor_get_board";
const TOOL_DISPATCHER_CREATE_TASK: &str = "conductor_dispatcher_create_task";
const TOOL_DISPATCHER_UPDATE_TASK: &str = "conductor_dispatcher_update_task";
const TOOL_DISPATCHER_HANDOFF_TASK: &str = "conductor_dispatcher_handoff_task";
const LEGACY_TOOL_CREATE_BOARD_TASK: &str = "conductor_create_board_task";
const LEGACY_TOOL_UPDATE_BOARD_TASK: &str = "conductor_update_board_task";
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
    async fn create_dispatcher_task(&self, args: DispatcherTaskCreateInput) -> Result<Value>;
    async fn update_dispatcher_task(&self, args: DispatcherTaskUpdateInput) -> Result<Value>;
    async fn handoff_dispatcher_task(&self, args: DispatcherTaskHandoffInput) -> Result<Value>;
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

    async fn create_dispatcher_task(&self, args: DispatcherTaskCreateInput) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        self.ensure_board_mutation_allowed(&project_id).await?;
        let caller_session = self.caller_session().await?;
        let activity_source = if caller_session
            .as_ref()
            .is_some_and(is_acp_dispatcher_session)
        {
            "dispatcher"
        } else {
            "mcp"
        };
        let mut args = args;
        args.project = Some(project_id);
        let result = create_dispatcher_task(
            &self.state,
            DispatcherTaskMutationContext {
                activity_source,
                caller_session,
                dispatcher_thread_id: None,
            },
            args,
        )
        .await?;
        Ok(result.response_payload())
    }

    async fn update_dispatcher_task(&self, args: DispatcherTaskUpdateInput) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        self.ensure_board_mutation_allowed(&project_id).await?;
        let caller_session = self.caller_session().await?;
        let activity_source = if caller_session
            .as_ref()
            .is_some_and(is_acp_dispatcher_session)
        {
            "dispatcher"
        } else {
            "mcp"
        };
        let mut args = args;
        args.project = Some(project_id);
        let result = update_dispatcher_task(
            &self.state,
            DispatcherTaskMutationContext {
                activity_source,
                caller_session,
                dispatcher_thread_id: None,
            },
            args,
        )
        .await?;
        Ok(result.response_payload())
    }

    async fn handoff_dispatcher_task(&self, args: DispatcherTaskHandoffInput) -> Result<Value> {
        let project_id = self.resolve_project_id(args.project.as_deref()).await?;
        self.ensure_board_mutation_allowed(&project_id).await?;
        let caller_session = self.caller_session().await?;
        let activity_source = if caller_session
            .as_ref()
            .is_some_and(is_acp_dispatcher_session)
        {
            "dispatcher"
        } else {
            "mcp"
        };
        let mut args = args;
        args.project = Some(project_id);
        let result = handoff_dispatcher_task(
            &self.state,
            DispatcherTaskMutationContext {
                activity_source,
                caller_session,
                dispatcher_thread_id: None,
            },
            args,
        )
        .await?;
        Ok(result.response_payload())
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

    while let Some((request, wire_format)) = read_jsonrpc_request(&mut reader).await? {
        if let Some(response) = handle_jsonrpc_request(backend.as_ref(), request).await? {
            write_jsonrpc_response(&mut writer, &response, wire_format).await?;
            writer.flush().await?;
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JsonRpcWireFormat {
    ContentLength,
    NewlineDelimited,
}

async fn read_jsonrpc_request<R>(
    reader: &mut BufReader<R>,
) -> Result<Option<(JsonRpcRequest, JsonRpcWireFormat)>>
where
    R: AsyncRead + Unpin,
{
    let mut line = String::new();

    loop {
        line.clear();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            return Ok(None);
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('{') {
            let request = serde_json::from_str(trimmed)
                .context("Failed to decode newline-delimited JSON-RPC request")?;
            return Ok(Some((request, JsonRpcWireFormat::NewlineDelimited)));
        }

        let mut content_length = None;
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
        let request =
            serde_json::from_slice(&payload).context("Failed to decode JSON-RPC request")?;
        return Ok(Some((request, JsonRpcWireFormat::ContentLength)));
    }
}

async fn write_jsonrpc_response<W>(
    writer: &mut W,
    response: &JsonRpcResponse,
    wire_format: JsonRpcWireFormat,
) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(response)?;
    match wire_format {
        JsonRpcWireFormat::ContentLength => {
            let header = format!("Content-Length: {}\r\n\r\n", body.len());
            writer.write_all(header.as_bytes()).await?;
            writer.write_all(&body).await?;
        }
        JsonRpcWireFormat::NewlineDelimited => {
            writer.write_all(&body).await?;
            writer.write_all(b"\n").await?;
        }
    }
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
        TOOL_DISPATCHER_CREATE_TASK | LEGACY_TOOL_CREATE_BOARD_TASK => {
            match serde_json::from_value::<DispatcherTaskCreateInput>(arguments) {
                Ok(args) => match backend.create_dispatcher_task(args).await {
                    Ok(payload) => Ok(tool_success(payload)),
                    Err(err) => Ok(tool_error(err.to_string())),
                },
                Err(err) => Ok(tool_error(format!(
                    "Invalid dispatcher_create_task arguments: {err}"
                ))),
            }
        }
        TOOL_DISPATCHER_UPDATE_TASK | LEGACY_TOOL_UPDATE_BOARD_TASK => {
            match serde_json::from_value::<DispatcherTaskUpdateInput>(arguments) {
                Ok(args) => match backend.update_dispatcher_task(args).await {
                    Ok(payload) => Ok(tool_success(payload)),
                    Err(err) => Ok(tool_error(err.to_string())),
                },
                Err(err) => Ok(tool_error(format!(
                    "Invalid dispatcher_update_task arguments: {err}"
                ))),
            }
        }
        TOOL_DISPATCHER_HANDOFF_TASK => {
            match serde_json::from_value::<DispatcherTaskHandoffInput>(arguments) {
                Ok(args) => match backend.handoff_dispatcher_task(args).await {
                    Ok(payload) => Ok(tool_success(payload)),
                    Err(err) => Ok(tool_error(err.to_string())),
                },
                Err(err) => Ok(tool_error(format!(
                    "Invalid dispatcher_handoff_task arguments: {err}"
                ))),
            }
        }
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
            description: "Get the current Conductor board snapshot for a project, including lifecycle columns and tasks. ACP dispatchers should inspect this before deciding whether to create or update board tasks.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" }
                }
            }),
        },
        ToolDefinition {
            name: TOOL_DISPATCHER_CREATE_TASK.to_string(),
            description: "Create a new first-class dispatcher task for a project. The board remains the projection surface, but ACP dispatchers must provide a launch-ready handoff packet, current-turn file attachments are inherited automatically, and `surfaces` plus `skills` should name the exact reference files and worker guidance required to execute the task.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" },
                    "title": { "type": "string", "description": "Task title" },
                    "description": { "type": "string", "description": "Optional task description" },
                    "context_notes": { "type": "string", "description": "Optional orchestration notes for the task, including key context that is not obvious from the title" },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Optional attachment paths. ACP dispatcher turns also inherit the current turn's recorded attachments." },
                    "objective": { "type": "string", "description": "Explicit objective for the task brief and worker handoff" },
                    "execution_mode": { "type": "string", "description": "Execution mode for spawned work: worktree, main_workspace, or temp_clone" },
                    "surfaces": { "type": "array", "items": { "type": "string" }, "description": "Exact reference files, folders, APIs, tests, routes, or product surfaces to inspect" },
                    "constraints": { "type": "array", "items": { "type": "string" }, "description": "Non-negotiable constraints, guardrails, or rules" },
                    "dependencies": { "type": "array", "items": { "type": "string" }, "description": "Upstream tasks, context, or blockers this task depends on" },
                    "acceptance": { "type": "array", "items": { "type": "string" }, "description": "Acceptance criteria for completion or review sign-off" },
                    "skills": { "type": "array", "items": { "type": "string" }, "description": "Suggested skills, domains, installed skill IDs, or tools the worker should lean on" },
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
            name: TOOL_DISPATCHER_UPDATE_TASK.to_string(),
            description: "Update an existing first-class dispatcher task by task ID, task ref, or linked issue ID. The updated task is then projected back onto the Conductor board.".to_string(),
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
            name: TOOL_DISPATCHER_HANDOFF_TASK.to_string(),
            description: "Explicitly hand off an existing dispatcher task for execution. This validates the execution packet, updates the task, and by default moves it into the ready column so it can be launched from the card.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Optional project ID; defaults to the first configured project" },
                    "task": { "type": "string", "description": "Board task ID, taskRef, or linked issue ID" },
                    "role": { "type": "string", "description": "Optional target lifecycle column. Defaults to ready for handoff." },
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

pub type CreateBoardTaskArgs = DispatcherTaskCreateInput;
pub type UpdateBoardTaskArgs = DispatcherTaskUpdateInput;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskGraphArgs {
    pub project: Option<String>,
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStatusArgs {
    pub session_id: String,
}

fn is_acp_dispatcher_session(session: &SessionRecord) -> bool {
    session.metadata.get("sessionKind").map(String::as_str) == Some(ACP_SESSION_KIND)
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
pub enum JsonRpcPayload {
    #[serde(rename = "result")]
    Result(Value),
    #[serde(rename = "error")]
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

        async fn create_dispatcher_task(&self, args: DispatcherTaskCreateInput) -> Result<Value> {
            Ok(json!({
                "operation": "create",
                "createdTaskId": "task-1",
                "task": {
                    "title": args.title,
                }
            }))
        }

        async fn update_dispatcher_task(&self, args: DispatcherTaskUpdateInput) -> Result<Value> {
            Ok(json!({
                "operation": "update",
                "updatedTaskId": "task-1",
                "task": {
                    "task": args.task,
                }
            }))
        }

        async fn handoff_dispatcher_task(&self, args: DispatcherTaskHandoffInput) -> Result<Value> {
            Ok(json!({
                "operation": "handoff",
                "handedOffTaskId": "task-1",
                "task": {
                    "task": args.task,
                    "role": args.role.unwrap_or_else(|| "ready".to_string()),
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
    async fn tools_list_exposes_nine_tools() {
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
        assert_eq!(result["tools"].as_array().unwrap().len(), 9);
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
    async fn tools_call_dispatcher_create_task_returns_task_payload() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(4)),
                method: "tools/call".to_string(),
                params: Some(json!({
                    "name": TOOL_DISPATCHER_CREATE_TASK,
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
    async fn tools_call_dispatcher_handoff_task_returns_task_payload() {
        let response = handle_jsonrpc_request(
            &MockBackend,
            JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(41)),
                method: "tools/call".to_string(),
                params: Some(json!({
                    "name": TOOL_DISPATCHER_HANDOFF_TASK,
                    "arguments": {
                        "project": "demo",
                        "task": "DEM-123"
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
            .contains("\"operation\": \"handoff\""));
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
            .create_dispatcher_task(CreateBoardTaskArgs {
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
            .create_dispatcher_task(CreateBoardTaskArgs {
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
    async fn acp_dispatcher_create_task_enriches_handoff_from_turn_context() {
        let _env_guard = env_lock().lock().await;
        let (root, state) = build_app_state("mcp-acp-enriched-handoff").await;
        let repo = root.join("repo");
        fs::create_dir_all(repo.join("docs").join("incidents"))
            .expect("docs dir should be created");
        fs::write(
            repo.join("docs")
                .join("incidents")
                .join("dispatcher-audit.md"),
            "# Dispatcher audit\n",
        )
        .expect("attachment should exist");

        let mut dispatcher = state
            .create_project_dispatcher_thread(
                "demo",
                crate::state::CreateDispatcherThreadOptions::default(),
            )
            .await
            .expect("dispatcher thread should be created");
        dispatcher.status = SessionStatus::Working;
        dispatcher.metadata.insert(
            crate::state::ACP_ACTIVE_SKILLS_METADATA_KEY.to_string(),
            serde_json::to_string(&vec!["rust".to_string(), "dispatcher-review".to_string()])
                .expect("skills should serialize"),
        );
        dispatcher
            .conversation
            .push(crate::state::ConversationEntry {
                id: Uuid::new_v4().to_string(),
                kind: "user_message".to_string(),
                source: "dispatcher_ui".to_string(),
                text: "Review the dispatcher audit and turn it into a concrete board task."
                    .to_string(),
                created_at: Utc::now().to_rfc3339(),
                attachments: vec![
                    "docs/incidents/dispatcher-audit.md".to_string(),
                    "https://github.com/acme/conductor/pull/42".to_string(),
                ],
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
            .create_dispatcher_task(CreateBoardTaskArgs {
                project: Some("demo".to_string()),
                title: "Review dispatcher audit findings".to_string(),
                objective: Some(
                    "Capture the concrete dispatcher gaps found in the audit.".to_string(),
                ),
                execution_mode: Some("main_workspace".to_string()),
                acceptance: Some(vec![
                    "The worker can review the audit without reopening dispatcher chat."
                        .to_string(),
                ]),
                deliverables: Some(vec![
                    "review findings".to_string(),
                    "recommended fixes".to_string(),
                ]),
                task_type: Some("review".to_string()),
                role: Some("review".to_string()),
                ..CreateBoardTaskArgs::default()
            })
            .await
            .expect("dispatcher context should enrich the handoff packet");

        assert_eq!(
            payload["task"]["attachments"],
            json!([
                "docs/incidents/dispatcher-audit.md",
                "https://github.com/acme/conductor/pull/42"
            ])
        );
        assert_eq!(
            payload["task"]["notes"],
            "Review the dispatcher audit and turn it into a concrete board task."
        );
        assert_eq!(
            payload["task"]["packet"]["surfaces"],
            json!(["docs/incidents/dispatcher-audit.md"])
        );
        assert_eq!(
            payload["task"]["packet"]["reviewRefs"],
            json!([
                "docs/incidents/dispatcher-audit.md",
                "https://github.com/acme/conductor/pull/42"
            ])
        );
        assert_eq!(
            payload["task"]["packet"]["skills"],
            json!(["rust", "dispatcher-review"])
        );

        std::env::remove_var(MCP_CALLER_SESSION_ENV);
        std::env::remove_var(MCP_CALLER_PROJECT_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn acp_dispatcher_can_update_and_handoff_existing_tasks_deterministically() {
        let _env_guard = env_lock().lock().await;
        let (root, state) = build_app_state("mcp-acp-update-handoff").await;
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
        let create_payload = backend
            .create_dispatcher_task(CreateBoardTaskArgs {
                project: Some("demo".to_string()),
                title: "Dispatcher lifecycle seed".to_string(),
                context_notes: Some(
                    "Seed task for deterministic lifecycle assertions.".to_string(),
                ),
                objective: Some("Create a seed dispatcher task.".to_string()),
                execution_mode: Some("worktree".to_string()),
                surfaces: Some(vec!["crates/conductor-server/src/mcp.rs".to_string()]),
                acceptance: Some(vec!["A seed task exists on the board.".to_string()]),
                skills: Some(vec![
                    "rust".to_string(),
                    "dispatcher orchestration".to_string(),
                ]),
                deliverables: Some(vec!["seed task".to_string()]),
                role: Some("intake".to_string()),
                ..CreateBoardTaskArgs::default()
            })
            .await
            .expect("dispatcher should create a seed task");
        let task_ref = create_payload["task"]["taskRef"]
            .as_str()
            .expect("task ref should be present")
            .to_string();

        let update_payload = backend
            .update_dispatcher_task(UpdateBoardTaskArgs {
                project: Some("demo".to_string()),
                task: Some(task_ref.clone()),
                title: Some("Dispatcher lifecycle review".to_string()),
                context_notes: Some("Expand the seed task into a review task.".to_string()),
                role: Some("review".to_string()),
                task_type: Some("review".to_string()),
                execution_mode: Some("main_workspace".to_string()),
                surfaces: Some(vec![
                    "crates/conductor-server/src/mcp.rs".to_string(),
                    "crates/conductor-server/src/state/acp_dispatcher.rs".to_string(),
                ]),
                review_refs: Some(vec!["docs/dispatcher-audit.md".to_string()]),
                acceptance: Some(vec!["The review task stays launch-ready.".to_string()]),
                skills: Some(vec!["rust".to_string(), "dispatcher review".to_string()]),
                deliverables: Some(vec!["review memo".to_string()]),
                ..UpdateBoardTaskArgs::default()
            })
            .await
            .expect("dispatcher should update the task");
        assert_eq!(update_payload["task"]["taskRef"], task_ref);
        assert_eq!(update_payload["task"]["role"], "review");

        let handoff_payload = backend
            .handoff_dispatcher_task(UpdateBoardTaskArgs {
                project: Some("demo".to_string()),
                task: Some(task_ref.clone()),
                context_notes: Some("Ready for worker execution.".to_string()),
                task_type: Some("feature".to_string()),
                execution_mode: Some("worktree".to_string()),
                surfaces: Some(vec![
                    "crates/conductor-server/src/state/acp_dispatcher.rs".to_string()
                ]),
                acceptance: Some(vec![
                    "Worker can start directly from the ready card.".to_string()
                ]),
                skills: Some(vec![
                    "rust".to_string(),
                    "dispatcher orchestration".to_string(),
                ]),
                deliverables: Some(vec!["implemented dispatcher lifecycle".to_string()]),
                ..UpdateBoardTaskArgs::default()
            })
            .await
            .expect("dispatcher should hand off the task");
        assert_eq!(handoff_payload["task"]["taskRef"], task_ref);
        assert_eq!(handoff_payload["task"]["role"], "ready");

        let persisted = state
            .get_dispatcher_thread(&dispatcher.id)
            .await
            .expect("dispatcher thread should still exist");
        let lifecycle_events = persisted
            .conversation
            .iter()
            .filter_map(|entry| entry.metadata.get("eventType").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            lifecycle_events,
            vec![
                "dispatcher_task_created",
                "dispatcher_task_updated",
                "dispatcher_task_handed_off"
            ]
        );

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
            .create_dispatcher_task(CreateBoardTaskArgs {
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

        write_jsonrpc_response(&mut server, &response, JsonRpcWireFormat::ContentLength)
            .await
            .unwrap();
        server.shutdown().await.unwrap();

        let mut output = Vec::new();
        client.read_to_end(&mut output).await.unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.starts_with("Content-Length: "));
        assert!(output.contains("\r\n\r\n{\"jsonrpc\":\"2.0\""));
    }

    #[tokio::test]
    async fn stdio_supports_newline_delimited_jsonrpc() {
        let request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}\n";
        let input = request.as_bytes().to_vec();
        let backend: Arc<dyn McpBackend> = Arc::new(MockBackend);
        let (mut client, server) = duplex(4096);

        let task = tokio::spawn(async move {
            serve_stdio_streams(backend, std::io::Cursor::new(input), server)
                .await
                .expect("newline-delimited stdio should succeed");
        });

        let mut output = String::new();
        client.read_to_string(&mut output).await.unwrap();
        task.await.unwrap();

        assert!(output.starts_with("{\"jsonrpc\":\"2.0\""));
        assert!(output.ends_with('\n'));
        let response: serde_json::Value =
            serde_json::from_str(output.trim()).expect("response should be valid JSON");
        assert_eq!(response["id"], 1);
        assert!(response["result"]["tools"].is_array());
    }
}
