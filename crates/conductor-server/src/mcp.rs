use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::state::{AppState, SessionRecord, SpawnRequest};

const MCP_SERVER_NAME: &str = "conductor";
const MCP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const TOOL_DISPATCH: &str = "conductor_dispatch";
const TOOL_LIST_SESSIONS: &str = "conductor_list_sessions";
const TOOL_SESSION_STATUS: &str = "conductor_session_status";
const TOOL_LIST_PROJECTS: &str = "conductor_list_projects";

#[async_trait]
pub trait McpBackend: Send + Sync {
    async fn dispatch(&self, args: DispatchArgs) -> Result<McpSessionSummary>;
    async fn list_sessions(&self, args: ListSessionsArgs) -> Result<Vec<McpSessionSummary>>;
    async fn session_status(&self, session_id: &str) -> Result<Option<McpSessionSummary>>;
    async fn list_projects(&self) -> Result<Vec<McpProjectSummary>>;
}

#[derive(Clone)]
pub struct AppStateMcpBackend {
    state: Arc<AppState>,
}

impl AppStateMcpBackend {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl McpBackend for AppStateMcpBackend {
    async fn dispatch(&self, args: DispatchArgs) -> Result<McpSessionSummary> {
        let config = self.state.config.read().await.clone();
        let project_id = match args
            .project
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
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
                project.to_string()
            }
            None => config
                .projects
                .keys()
                .next()
                .cloned()
                .ok_or_else(|| anyhow!("No projects configured in conductor.yaml"))?,
        };

        let session = self
            .state
            .spawn_session(SpawnRequest {
                project_id,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStatusArgs {
    pub session_id: String,
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
    use serde_json::json;
    use tokio::io::duplex;

    struct MockBackend;

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
    }

    #[tokio::test]
    async fn tools_list_exposes_four_tools() {
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
        assert_eq!(result["tools"].as_array().unwrap().len(), 4);
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
