use anyhow::{anyhow, bail, Context, Result};
use conductor_core::config::ProjectConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};
use url::Url;
use uuid::Uuid;

use crate::acp_prompt::{
    acp_dispatcher_turn_allows_board_mutations, rewrite_acp_dispatcher_command,
};
use crate::state::{
    dispatcher_implementation_agent_options, dispatcher_implementation_model_options,
    dispatcher_implementation_reasoning_options, dispatcher_preferred_implementation_agent,
    dispatcher_preferred_implementation_model,
    dispatcher_preferred_implementation_reasoning_effort, parse_acp_mcp_servers,
    serialize_mcp_servers, AppState, CreateDispatcherThreadOptions, DispatcherSelectOption,
    DispatcherTurnRequest, SessionRecord, SessionStatus, ACP_SESSION_MCP_SERVERS_METADATA_KEY,
};

const ACP_SERVER_NAME: &str = "conductor-acp";
const ACP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_SESSION_KIND: &str = "project_dispatcher";
const ACP_MODE_DISPATCHER: &str = "dispatcher";
const ACP_CONFIG_IMPLEMENTATION_AGENT: &str = "implementation_agent";
const ACP_CONFIG_MODEL: &str = "model";
const ACP_CONFIG_THOUGHT_LEVEL: &str = "thought_level";
const ACP_APPROVAL_STATE_METADATA_KEY: &str = "acpPlanApprovalState";
const ACP_APPROVAL_REQUIRED: &str = "approval_required";
const ACP_APPROVAL_GRANTED: &str = "approved_for_next_mutation";
const ACP_PROMPT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const ACP_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_CANCEL_GRACE_PERIOD: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JsonRpcWireFormat {
    ContentLength,
    NewlineDelimited,
}

#[derive(Clone)]
struct AcpServer {
    state: Arc<AppState>,
    in_flight_prompts: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AcpServer {
    fn new(state: Arc<AppState>) -> Self {
        Self {
            state,
            in_flight_prompts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn handle_request<W>(
        self: &Arc<Self>,
        request: JsonRpcRequest,
        writer: &Arc<Mutex<W>>,
        wire_format: JsonRpcWireFormat,
    ) -> Result<()>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        match request.method.as_str() {
            "authenticate" => {
                let _ = deserialize_params::<AuthenticateRequest>(&request)?;
                let response = make_success_response(&request, json!({}))?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "initialize" => {
                let response = make_success_response(
                    &request,
                    json!({
                        "protocolVersion": request
                            .params
                            .as_ref()
                            .and_then(|value| value.get("protocolVersion"))
                            .and_then(Value::as_u64)
                            .unwrap_or(ACP_PROTOCOL_VERSION),
                        "agentCapabilities": {
                            "loadSession": true,
                            "promptCapabilities": {
                                "audio": false,
                                "embeddedContext": true,
                                "image": false
                            },
                            "mcpCapabilities": {
                                "http": false,
                                "sse": false,
                                "acp": false
                            },
                            "sessionCapabilities": {
                                "list": {}
                            }
                        },
                        "agentInfo": {
                            "name": ACP_SERVER_NAME,
                            "version": ACP_SERVER_VERSION
                        },
                        "authMethods": []
                    }),
                )?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "ping" => {
                let response = make_success_response(&request, json!({}))?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "session/list" => {
                let params = deserialize_params::<ListSessionsRequest>(&request)?;
                let sessions = self.list_sessions(params).await?;
                let response = make_success_response(
                    &request,
                    json!({
                        "sessions": sessions,
                        "nextCursor": Value::Null
                    }),
                )?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "session/new" => {
                let params = deserialize_params::<NewSessionRequest>(&request)?;
                let response_payload = self.new_session(params).await?;
                let response = make_success_response(&request, response_payload)?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "session/load" => {
                let params = deserialize_params::<LoadSessionRequest>(&request)?;
                let (session, payload) = self.load_session(params).await?;
                stream_full_session_history(writer, wire_format, &session).await?;
                let response = make_success_response(&request, payload)?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "session/set_config_option" => {
                let params = deserialize_params::<SetSessionConfigOptionRequest>(&request)?;
                let payload = self.set_config_option(params).await?;
                let response = make_success_response(&request, payload)?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "session/set_mode" => {
                let params = deserialize_params::<SetSessionModeRequest>(&request)?;
                self.set_mode(params).await?;
                let response = make_success_response(&request, json!({}))?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
            "session/cancel" => {
                let params = deserialize_params::<CancelNotification>(&request)?;
                self.cancel_session(&params.session_id).await?;
            }
            "session/prompt" => {
                let server = Arc::clone(self);
                let writer = Arc::clone(writer);
                let request_id = request.id.clone();
                tokio::spawn(async move {
                    if let Err(err) = server
                        .handle_prompt_request(request, writer.clone(), wire_format)
                        .await
                    {
                        tracing::warn!(error = %err, "ACP prompt request failed");
                        if let Some(id) = request_id {
                            let response = JsonRpcResponse {
                                jsonrpc: "2.0".to_string(),
                                id,
                                payload: JsonRpcPayload::Error(JsonRpcError {
                                    code: -32000,
                                    message: err.to_string(),
                                    data: None,
                                }),
                            };
                            let _ = write_jsonrpc_message(&writer, wire_format, &response).await;
                        }
                    }
                });
            }
            other => {
                let response = make_error_response(
                    &request,
                    -32601,
                    format!("Unknown ACP method: {other}"),
                    None,
                )?;
                write_jsonrpc_message(writer, wire_format, &response).await?;
            }
        }

        Ok(())
    }

    async fn list_sessions(&self, params: ListSessionsRequest) -> Result<Vec<Value>> {
        let filter_cwd = params.cwd.as_deref().map(PathBuf::from);
        let mut sessions = self
            .state
            .all_dispatcher_threads()
            .await
            .into_iter()
            .filter(is_acp_dispatcher_session)
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.last_activity_at.cmp(&left.last_activity_at));
        Ok(sessions
            .into_iter()
            .filter(|session| {
                if let Some(filter_cwd) = filter_cwd.as_ref() {
                    if let Some(session_cwd) = session_cwd(&self.state, session) {
                        return Path::new(&session_cwd).starts_with(filter_cwd)
                            || filter_cwd.starts_with(Path::new(&session_cwd));
                    }
                    return false;
                }
                true
            })
            .map(|session| session_info_value(&self.state, &session))
            .collect())
    }

    async fn new_session(&self, params: NewSessionRequest) -> Result<Value> {
        let cwd = PathBuf::from(&params.cwd);
        if !cwd.is_absolute() {
            bail!("session/new cwd must be an absolute path");
        }
        let session_mcp_servers = parse_acp_mcp_servers(&params.mcp_servers)?;
        let session_meta = parse_conductor_meta(params.meta.as_ref());
        let dispatcher_model = session_meta.model.clone();
        let dispatcher_reasoning_effort = session_meta.reasoning_effort.clone();
        let (project_id, _project) = self
            .resolve_project_from_cwd(&cwd, session_meta.project_id.as_deref())
            .await?;
        let mut updated = self
            .state
            .create_project_dispatcher_thread(
                &project_id,
                CreateDispatcherThreadOptions {
                    bridge_id: None,
                    dispatcher_agent: session_meta.dispatcher_agent,
                    implementation_agent: session_meta.implementation_agent,
                    dispatcher_model,
                    dispatcher_reasoning_effort,
                    implementation_model: session_meta.model,
                    implementation_reasoning_effort: session_meta.reasoning_effort,
                    force_new: true,
                },
            )
            .await?;
        updated.workspace_path = Some(cwd.to_string_lossy().to_string());
        updated
            .metadata
            .insert("agentCwd".to_string(), cwd.to_string_lossy().to_string());
        if let Some(serialized) = serialize_mcp_servers(&session_mcp_servers) {
            updated
                .metadata
                .insert(ACP_SESSION_MCP_SERVERS_METADATA_KEY.to_string(), serialized);
        }
        updated.summary = Some("ACP dispatcher created".to_string());
        updated
            .metadata
            .insert("summary".to_string(), "ACP dispatcher created".to_string());
        updated.conversation.clear();
        self.state
            .replace_dispatcher_thread(updated.clone())
            .await?;
        if let Err(err) = self.state.sync_acp_dispatcher_state(&updated).await {
            tracing::warn!(session_id = %updated.id, error = %err, "failed to sync ACP dispatcher after session/new");
        }
        Ok(json!({
            "sessionId": updated.id,
            "configOptions": session_config_options(&updated),
            "modes": dispatcher_mode_state(),
            "_meta": dispatcher_response_meta(&updated),
        }))
    }

    async fn load_session(&self, params: LoadSessionRequest) -> Result<(SessionRecord, Value)> {
        let session_mcp_servers = parse_acp_mcp_servers(&params.mcp_servers)?;
        let mut session = self
            .state
            .get_dispatcher_thread(&params.session_id)
            .await
            .with_context(|| format!("Unknown ACP session {}", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!(
                "Session {} is not an ACP dispatcher session",
                params.session_id
            );
        }
        let cwd = PathBuf::from(&params.cwd);
        if !cwd.is_absolute() {
            bail!("session/load cwd must be an absolute path");
        }
        let serialized = serialize_mcp_servers(&session_mcp_servers);
        let metadata_changed = match serialized {
            Some(serialized) => {
                let changed = session
                    .metadata
                    .get(ACP_SESSION_MCP_SERVERS_METADATA_KEY)
                    .map(String::as_str)
                    != Some(serialized.as_str());
                if changed {
                    session
                        .metadata
                        .insert(ACP_SESSION_MCP_SERVERS_METADATA_KEY.to_string(), serialized);
                }
                changed
            }
            None => session
                .metadata
                .remove(ACP_SESSION_MCP_SERVERS_METADATA_KEY)
                .is_some(),
        };
        if metadata_changed {
            self.state
                .replace_dispatcher_thread(session.clone())
                .await
                .with_context(|| format!("Failed to update ACP session {}", params.session_id))?;
        }
        Ok((
            session.clone(),
            json!({
                "configOptions": session_config_options(&session),
                "modes": dispatcher_mode_state(),
                "_meta": dispatcher_response_meta(&session),
            }),
        ))
    }

    async fn set_config_option(&self, params: SetSessionConfigOptionRequest) -> Result<Value> {
        let session = self
            .state
            .get_dispatcher_thread(&params.session_id)
            .await
            .with_context(|| format!("Unknown ACP session {}", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!(
                "Session {} is not an ACP dispatcher session",
                params.session_id
            );
        }

        let session = match params.config_id.as_str() {
            ACP_CONFIG_IMPLEMENTATION_AGENT => {
                self.state
                    .update_dispatcher_preferences(
                        &params.session_id,
                        Some(params.value),
                        None,
                        None,
                    )
                    .await?
            }
            ACP_CONFIG_MODEL => {
                self.state
                    .update_dispatcher_runtime_preferences(
                        &params.session_id,
                        Some(params.value),
                        None,
                    )
                    .await?
            }
            ACP_CONFIG_THOUGHT_LEVEL => {
                self.state
                    .update_dispatcher_runtime_preferences(
                        &params.session_id,
                        None,
                        Some(params.value),
                    )
                    .await?
            }
            other => bail!("Unsupported ACP config option `{other}`"),
        };
        Ok(json!({
            "configOptions": session_config_options(&session)
        }))
    }

    async fn set_mode(&self, params: SetSessionModeRequest) -> Result<()> {
        if params.mode_id != ACP_MODE_DISPATCHER {
            bail!(
                "Unsupported ACP mode `{}`. Only `{}` is available",
                params.mode_id,
                ACP_MODE_DISPATCHER
            );
        }
        let mut session = self
            .state
            .get_dispatcher_thread(&params.session_id)
            .await
            .with_context(|| format!("Unknown ACP session {}", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!(
                "Session {} is not an ACP dispatcher session",
                params.session_id
            );
        }
        session
            .metadata
            .insert("acpMode".to_string(), ACP_MODE_DISPATCHER.to_string());
        session.last_activity_at = chrono::Utc::now().to_rfc3339();
        self.state.replace_dispatcher_thread(session).await?;
        Ok(())
    }

    async fn cancel_session(&self, session_id: &str) -> Result<()> {
        if let Some(flag) = self.in_flight_prompts.lock().await.get(session_id).cloned() {
            flag.store(true, Ordering::SeqCst);
        }
        if let Err(err) = self.state.interrupt_dispatcher(session_id).await {
            tracing::debug!(session_id, error = %err, "ACP cancel could not interrupt live session");
        }
        Ok(())
    }

    async fn handle_prompt_request<W>(
        self: Arc<Self>,
        request: JsonRpcRequest,
        writer: Arc<Mutex<W>>,
        wire_format: JsonRpcWireFormat,
    ) -> Result<()>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let params = deserialize_params::<PromptRequest>(&request)?;
        let session = self
            .wait_for_dispatcher_thread(&params.session_id, ACP_SESSION_READY_TIMEOUT)
            .await
            .with_context(|| format!("ACP session {} is not ready", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!(
                "Session {} is not an ACP dispatcher session",
                params.session_id
            );
        }

        let cancel_flag = {
            let mut in_flight = self.in_flight_prompts.lock().await;
            if in_flight.contains_key(&params.session_id) {
                bail!(
                    "ACP session {} already has a prompt in flight",
                    params.session_id
                );
            }
            let flag = Arc::new(AtomicBool::new(false));
            in_flight.insert(params.session_id.clone(), flag.clone());
            flag
        };

        let response = self
            .run_prompt_turn(
                &request,
                &params,
                session,
                cancel_flag.clone(),
                &writer,
                wire_format,
            )
            .await;
        self.in_flight_prompts
            .lock()
            .await
            .remove(&params.session_id);
        let response = response?;
        write_jsonrpc_message(&writer, wire_format, &response).await?;
        Ok(())
    }

    async fn run_prompt_turn<W>(
        &self,
        request: &JsonRpcRequest,
        params: &PromptRequest,
        session: SessionRecord,
        cancel_flag: Arc<AtomicBool>,
        writer: &Arc<Mutex<W>>,
        wire_format: JsonRpcWireFormat,
    ) -> Result<JsonRpcResponse>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let prompt_meta = parse_conductor_meta(params.meta.as_ref());
        let prompt = parse_prompt_blocks(&params.prompt)?;
        let user_message_id = params
            .message_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let raw_prompt_message = prompt.user_message.clone();
        let next_approval_state = if acp_dispatcher_turn_allows_board_mutations(&raw_prompt_message)
        {
            ACP_APPROVAL_GRANTED
        } else {
            ACP_APPROVAL_REQUIRED
        };
        if approval_state(&session) != next_approval_state {
            self.update_approval_state(&params.session_id, next_approval_state)
                .await?;
        }
        let turn_is_approved = next_approval_state == ACP_APPROVAL_GRANTED;
        let dispatch_message = dispatcher_message_from_prompt_content(&prompt);
        let effective_model = prompt_meta.model.or_else(|| session.model.clone());
        let effective_reasoning = prompt_meta
            .reasoning_effort
            .or_else(|| session.reasoning_effort.clone());
        let turn_request = DispatcherTurnRequest {
            message: raw_prompt_message.clone(),
            runtime_message: Some(dispatch_message),
            source: "acp".to_string(),
            entry_id: Some(user_message_id.clone()),
            recorded_attachments: prompt.recorded_attachments.clone(),
            runtime_attachments: prompt.runtime_attachments.clone(),
            runtime_context: prompt.runtime_context.clone(),
            model: effective_model.clone(),
            reasoning_effort: effective_reasoning.clone(),
            metadata: HashMap::new(),
        };
        let initial_session = self
            .state
            .get_dispatcher_thread(&params.session_id)
            .await
            .unwrap_or_else(|| session.clone());
        let mut cursor = PromptStreamCursor::from_session(&initial_session);
        stream_static_session_updates(writer, wire_format, &initial_session, &mut cursor).await?;
        let initial_plan_stage = if turn_is_approved {
            "approved_execution"
        } else {
            "planning"
        };
        stream_plan_update(
            writer,
            wire_format,
            &params.session_id,
            plan_entries(initial_plan_stage),
        )
        .await?;
        let launched_session = self
            .ensure_prompt_runtime(&params.session_id, turn_request.clone())
            .await?;
        if launched_session.is_none() {
            self.state
                .send_to_dispatcher_thread(&params.session_id, turn_request)
                .await?;
        }
        let current_session = match launched_session {
            Some(session) => Some(session),
            None => self.state.get_dispatcher_thread(&params.session_id).await,
        };
        if let Some(current) = current_session {
            stream_prompt_delta(writer, wire_format, &current, &mut cursor).await?;
        }

        let started_at = Instant::now();
        let mut stop_reason;
        loop {
            let current = self
                .state
                .get_dispatcher_thread(&params.session_id)
                .await
                .with_context(|| {
                    format!(
                        "ACP session {} disappeared during prompt",
                        params.session_id
                    )
                })?;
            stream_prompt_delta(writer, wire_format, &current, &mut cursor).await?;

            if cancel_flag.load(Ordering::SeqCst) {
                stop_reason = "cancelled".to_string();
                if started_at.elapsed() >= ACP_CANCEL_GRACE_PERIOD {
                    break;
                }
            } else if prompt_turn_complete(&current) {
                stop_reason = prompt_stop_reason(&current);
                break;
            }

            sleep(ACP_PROMPT_POLL_INTERVAL).await;
        }

        finalize_open_tool_call(
            writer,
            wire_format,
            &params.session_id,
            &mut cursor,
            if stop_reason == "refusal" || stop_reason == "cancelled" {
                "failed"
            } else {
                "completed"
            },
        )
        .await?;
        let plan_state = if stop_reason == "end_turn" && turn_is_approved {
            "completed"
        } else if stop_reason == "end_turn" {
            "awaiting_approval"
        } else {
            "cancelled"
        };
        stream_plan_update(
            writer,
            wire_format,
            &params.session_id,
            plan_entries(plan_state),
        )
        .await?;

        make_success_response(
            request,
            json!({
                "stopReason": stop_reason,
                "userMessageId": user_message_id,
            }),
        )
    }

    async fn resolve_project_from_cwd(
        &self,
        cwd: &Path,
        requested_project_id: Option<&str>,
    ) -> Result<(String, ProjectConfig)> {
        let config = self.state.config.read().await.clone();
        if let Some(project_id) = requested_project_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let project = config
                .projects
                .get(project_id)
                .cloned()
                .with_context(|| format!("Unknown project `{project_id}`"))?;
            return Ok((project_id.to_string(), project));
        }

        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        let mut best_match: Option<(usize, String, ProjectConfig)> = None;
        for (project_id, project) in config.projects.iter() {
            let root = self.state.resolve_project_path(project);
            let root = root.canonicalize().unwrap_or(root);
            let matches = cwd.starts_with(&root);
            if !matches {
                continue;
            }
            let score = root.components().count();
            let replace = best_match
                .as_ref()
                .map(|(best_score, _, _)| score > *best_score)
                .unwrap_or(true);
            if replace {
                best_match = Some((score, project_id.clone(), project.clone()));
            }
        }

        if let Some((_, project_id, project)) = best_match {
            return Ok((project_id, project));
        }

        if config.projects.len() == 1 {
            let (project_id, project) = config.projects.into_iter().next().expect("single project");
            return Ok((project_id, project));
        }

        let available = config
            .projects
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        Err(anyhow!(
            "Could not map cwd `{}` to a configured project. Available projects: {}",
            cwd.display(),
            available
        ))
    }

    async fn wait_for_dispatcher_thread(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Option<SessionRecord> {
        let started_at = Instant::now();
        loop {
            if let Some(session) = self.state.get_dispatcher_thread(session_id).await {
                if session.status != SessionStatus::Queued
                    && session.status != SessionStatus::Spawning
                {
                    return Some(session);
                }
            }
            if started_at.elapsed() >= timeout {
                return self.state.get_dispatcher_thread(session_id).await;
            }
            sleep(ACP_PROMPT_POLL_INTERVAL).await;
        }
    }

    async fn ensure_prompt_runtime(
        &self,
        session_id: &str,
        request: DispatcherTurnRequest,
    ) -> Result<Option<SessionRecord>> {
        if self.state.dispatcher_runtime_attached(session_id).await {
            return Ok(None);
        }
        self.state
            .send_to_dispatcher_thread(session_id, request)
            .await?;
        Ok(self.state.get_dispatcher_thread(session_id).await)
    }

    async fn update_approval_state(&self, session_id: &str, approval_state: &str) -> Result<()> {
        let mut session = self
            .state
            .get_dispatcher_thread(session_id)
            .await
            .with_context(|| format!("Unknown ACP session {session_id}"))?;
        session.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            approval_state.to_string(),
        );
        session.last_activity_at = chrono::Utc::now().to_rfc3339();
        self.state.replace_dispatcher_thread(session).await
    }
}

pub async fn serve_stdio(state: Arc<AppState>) -> Result<()> {
    serve_stdio_streams(state, tokio::io::stdin(), tokio::io::stdout()).await
}

pub async fn serve_stdio_streams<R, W>(state: Arc<AppState>, reader: R, writer: W) -> Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let server = Arc::new(AcpServer::new(state));
    let mut reader = BufReader::new(reader);
    let writer = Arc::new(Mutex::new(writer));

    while let Some((request, wire_format)) = read_jsonrpc_request(&mut reader).await? {
        server.handle_request(request, &writer, wire_format).await?;
    }

    Ok(())
}

fn is_acp_dispatcher_session(session: &SessionRecord) -> bool {
    session.metadata.get("sessionKind").map(String::as_str) == Some(ACP_SESSION_KIND)
}

fn session_cwd(_state: &Arc<AppState>, session: &SessionRecord) -> Option<String> {
    session
        .metadata
        .get("agentCwd")
        .cloned()
        .or_else(|| session.workspace_path.clone())
}

fn session_title(session: &SessionRecord) -> String {
    session
        .summary
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("ACP / {}", session.project_id))
}

fn prompt_turn_dispatch_message(raw_prompt_message: &str) -> String {
    if raw_prompt_message.trim().is_empty() {
        rewrite_acp_dispatcher_command(raw_prompt_message)
    } else {
        raw_prompt_message.to_string()
    }
}

fn dispatcher_message_from_prompt_content(prompt: &ParsedPromptBlocks) -> String {
    if prompt.user_message.trim().is_empty() && prompt.has_non_text_content {
        "Review the provided ACP context and respond according to the current ACP execution mode."
            .to_string()
    } else {
        prompt_turn_dispatch_message(&prompt.user_message)
    }
}

fn dispatcher_mode_state() -> Value {
    json!({
        "availableModes": [
            {
                "id": ACP_MODE_DISPATCHER,
                "name": "Dispatcher",
                "description": "Long-lived ACP orchestration mode for shaping board tasks, managing memory, and dispatching implementation sessions through the locally available coding agents."
            }
        ],
        "currentModeId": ACP_MODE_DISPATCHER
    })
}

fn select_option_value(option: DispatcherSelectOption) -> Value {
    json!({
        "value": option.value,
        "name": option.name,
        "description": option.description,
    })
}

fn config_options_with_current(
    options: &'static [DispatcherSelectOption],
    current_value: &str,
    fallback_name: &str,
    fallback_description: &str,
) -> Vec<Value> {
    let normalized_current = current_value.trim();
    let mut values = options
        .iter()
        .copied()
        .map(select_option_value)
        .collect::<Vec<_>>();
    if !normalized_current.is_empty()
        && !options
            .iter()
            .any(|option| option.value == normalized_current)
    {
        values.insert(
            0,
            json!({
                "value": normalized_current,
                "name": fallback_name,
                "description": fallback_description,
            }),
        );
    }
    values
}

fn dispatcher_response_meta(session: &SessionRecord) -> Value {
    json!({
        "approvalState": approval_state(session),
        "requiresApproval": approval_state(session) != ACP_APPROVAL_GRANTED,
        "sessionKind": ACP_SESSION_KIND,
        "implementationAgent": dispatcher_preferred_implementation_agent(session),
        "implementationModel": dispatcher_preferred_implementation_model(session),
        "implementationReasoningEffort": dispatcher_preferred_implementation_reasoning_effort(session),
    })
}

fn session_config_options(session: &SessionRecord) -> Value {
    let dispatcher_agent = session.agent.trim().to_ascii_lowercase();
    let dispatcher_model = session.model.clone().unwrap_or_default();
    let dispatcher_reasoning = session.reasoning_effort.clone().unwrap_or_default();
    let implementation_agent = dispatcher_preferred_implementation_agent(session);
    let model_options = dispatcher_implementation_model_options(&dispatcher_agent);
    let reasoning_options = dispatcher_implementation_reasoning_options(&dispatcher_agent);

    let mut config_options = Vec::new();

    if !dispatcher_model.trim().is_empty() || !model_options.is_empty() {
        config_options.push(json!({
            "id": ACP_CONFIG_MODEL,
            "type": "select",
            "category": "model",
            "name": "Model",
            "description": "Model for the dispatcher session.",
            "currentValue": dispatcher_model,
            "options": config_options_with_current(
                model_options,
                &dispatcher_model,
                dispatcher_model.trim(),
                "Current stored dispatcher model.",
            ),
        }));
    }

    if !dispatcher_reasoning.trim().is_empty() || !reasoning_options.is_empty() {
        config_options.push(json!({
            "id": ACP_CONFIG_THOUGHT_LEVEL,
            "type": "select",
            "category": "thought_level",
            "name": "Thinking",
            "description": "Reasoning level for the dispatcher session.",
            "currentValue": dispatcher_reasoning,
            "options": config_options_with_current(
                reasoning_options,
                &dispatcher_reasoning,
                dispatcher_reasoning.trim(),
                "Current stored dispatcher reasoning level.",
            ),
        }));
    }

    config_options.push(json!({
        "id": ACP_CONFIG_IMPLEMENTATION_AGENT,
        "type": "select",
        "category": "other",
        "name": "Coding Agent",
        "description": "Preferred coding agent for board tasks created by the ACP dispatcher.",
        "currentValue": implementation_agent,
        "options": dispatcher_implementation_agent_options()
            .iter()
            .copied()
            .map(select_option_value)
            .collect::<Vec<_>>(),
    }));

    json!(config_options)
}

fn session_info_value(state: &Arc<AppState>, session: &SessionRecord) -> Value {
    json!({
        "sessionId": session.id.clone(),
        "cwd": session_cwd(state, session).unwrap_or_default(),
        "title": session_title(session),
        "updatedAt": session.last_activity_at.clone(),
        "_meta": dispatcher_response_meta(session),
    })
}

fn approval_state(session: &SessionRecord) -> &'static str {
    match session
        .metadata
        .get(ACP_APPROVAL_STATE_METADATA_KEY)
        .map(String::as_str)
    {
        Some(ACP_APPROVAL_GRANTED) => ACP_APPROVAL_GRANTED,
        _ => ACP_APPROVAL_REQUIRED,
    }
}

fn prompt_turn_complete(session: &SessionRecord) -> bool {
    !matches!(
        &session.status,
        SessionStatus::Working | SessionStatus::Spawning | SessionStatus::Queued
    )
}

fn prompt_stop_reason(session: &SessionRecord) -> String {
    match &session.status {
        SessionStatus::Errored => "refusal".to_string(),
        SessionStatus::Killed | SessionStatus::Archived | SessionStatus::Terminated => {
            "cancelled".to_string()
        }
        _ => "end_turn".to_string(),
    }
}

fn parse_conductor_meta(meta: Option<&Value>) -> ConductorMeta {
    let conductor = meta.and_then(|value| value.get("conductor")).or(meta);
    ConductorMeta {
        project_id: meta_string(conductor, "projectId"),
        dispatcher_agent: meta_string(conductor, "agent"),
        implementation_agent: meta_string(conductor, "implementationAgent"),
        model: meta_string(conductor, "model"),
        reasoning_effort: meta_string(conductor, "reasoningEffort"),
    }
}

fn meta_string(meta: Option<&Value>, key: &str) -> Option<String> {
    meta.and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Default)]
struct ParsedPromptBlocks {
    user_message: String,
    recorded_attachments: Vec<String>,
    runtime_attachments: Vec<String>,
    runtime_context: Option<String>,
    has_non_text_content: bool,
}

fn parse_prompt_blocks(blocks: &[Value]) -> Result<ParsedPromptBlocks> {
    let mut text_parts = Vec::new();
    let mut recorded_attachments = Vec::new();
    let mut runtime_attachments = Vec::new();
    let mut runtime_context_sections = Vec::new();
    let mut has_non_text_content = false;

    for block in blocks {
        let Some(block_type) = block.get("type").and_then(Value::as_str) else {
            continue;
        };
        match block_type {
            "text" => {
                if let Some(text) = block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    text_parts.push(text.to_string());
                }
            }
            "resource_link" => {
                if let Some(uri) = block
                    .get("uri")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|uri| !uri.is_empty())
                {
                    if prompt_attachment_should_be_recorded(uri) {
                        push_unique_string(&mut recorded_attachments, uri);
                    }
                    push_unique_string(&mut runtime_attachments, uri);
                    has_non_text_content = true;
                }
            }
            "resource" => {
                if let Some(resource) = block.get("resource") {
                    if let Some(uri) = resource
                        .get("uri")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|uri| !uri.is_empty())
                    {
                        if prompt_attachment_should_be_recorded(uri) {
                            push_unique_string(&mut recorded_attachments, uri);
                        }
                    }
                    if let Some(section) = render_embedded_resource_for_runtime(resource) {
                        runtime_context_sections.push(section);
                    }
                    has_non_text_content = true;
                }
            }
            _ => {}
        }
    }

    Ok(ParsedPromptBlocks {
        user_message: text_parts.join("\n\n"),
        recorded_attachments,
        runtime_attachments,
        runtime_context: render_prompt_runtime_context(&runtime_context_sections),
        has_non_text_content,
    })
}

fn prompt_attachment_should_be_recorded(uri: &str) -> bool {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !trimmed.contains("://") {
        return true;
    }
    matches!(
        Url::parse(trimmed).ok().as_ref().map(Url::scheme),
        Some("file")
    )
}

fn push_unique_string(items: &mut Vec<String>, value: &str) {
    if !items.iter().any(|item| item == value) {
        items.push(value.to_string());
    }
}

fn render_embedded_resource_for_runtime(resource: &Value) -> Option<String> {
    let uri = resource
        .get("uri")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("embedded-resource");
    let mime_type = resource
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(text) = resource
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let mut header = format!("<resource uri=\"{uri}\"");
        if let Some(mime_type) = mime_type {
            header.push_str(&format!(" mimeType=\"{mime_type}\""));
        }
        header.push('>');
        return Some(format!("{header}\n{text}\n</resource>"));
    }

    resource
        .get("blob")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|blob| {
            let mut header = format!("<resource uri=\"{uri}\"");
            if let Some(mime_type) = mime_type {
                header.push_str(&format!(" mimeType=\"{mime_type}\""));
            }
            header.push('>');
            format!(
                "{header}\nBinary embedded content omitted from transcript adaptation ({} base64 chars).\n</resource>",
                blob.len()
            )
        })
}

fn render_prompt_runtime_context(sections: &[String]) -> Option<String> {
    (!sections.is_empty()).then(|| format!("ACP embedded context:\n{}", sections.join("\n\n")))
}

async fn stream_full_session_history<W>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    session: &SessionRecord,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut cursor = PromptStreamCursor::default();
    stream_static_session_updates(writer, wire_format, session, &mut cursor).await?;
    stream_prompt_delta(writer, wire_format, session, &mut cursor).await?;
    if let Some(status) = historical_tool_call_final_status(session) {
        finalize_open_tool_call(writer, wire_format, &session.id, &mut cursor, status).await?;
    }
    Ok(())
}

async fn stream_prompt_delta<W>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    session: &SessionRecord,
    cursor: &mut PromptStreamCursor,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    stream_static_session_updates(writer, wire_format, session, cursor).await?;
    let current_title = session_title(session);
    if cursor.last_title.as_ref() != Some(&current_title)
        || cursor.last_updated_at.as_ref() != Some(&session.last_activity_at)
    {
        send_session_update(
            writer,
            wire_format,
            &session.id,
            json!({
                "sessionUpdate": "session_info_update",
                "title": current_title,
                "updatedAt": session.last_activity_at.clone(),
                "_meta": dispatcher_response_meta(session)
            }),
        )
        .await?;
        cursor.last_title = Some(session_title(session));
        cursor.last_updated_at = Some(session.last_activity_at.clone());
    }

    for entry in session.conversation.iter() {
        let sent_chars = cursor.sent_lengths.get(&entry.id).copied().unwrap_or(0);
        let total_chars = entry.text.chars().count();
        if total_chars <= sent_chars {
            continue;
        }
        let delta = entry.text.chars().skip(sent_chars).collect::<String>();
        if let Some(tool_kind) = entry.metadata.get("toolKind").and_then(Value::as_str) {
            if tool_kind != "thinking" {
                if cursor.open_tool_call_id.as_ref() != Some(&entry.id) {
                    finalize_open_tool_call(writer, wire_format, &session.id, cursor, "completed")
                        .await?;
                }
                let tool_call_id = entry.id.clone();
                let update = if cursor.announced_tool_calls.insert(tool_call_id.clone()) {
                    cursor.open_tool_call_id = Some(tool_call_id.clone());
                    tool_call_event(entry, &delta, "tool_call")
                } else {
                    tool_call_event(entry, &delta, "tool_call_update")
                };
                send_session_update(writer, wire_format, &session.id, update).await?;
            } else {
                for update in updates_for_entry(entry, &delta) {
                    send_session_update(writer, wire_format, &session.id, update).await?;
                }
            }
        } else {
            finalize_open_tool_call(writer, wire_format, &session.id, cursor, "completed").await?;
            for update in updates_for_entry(entry, &delta) {
                send_session_update(writer, wire_format, &session.id, update).await?;
            }
        }
        cursor.sent_lengths.insert(entry.id.clone(), total_chars);
    }

    Ok(())
}

fn updates_for_entry(entry: &conductor_core::types::ConversationEntry, delta: &str) -> Vec<Value> {
    if entry
        .metadata
        .get("acpInternalBootstrap")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Vec::new();
    }
    if delta.is_empty() {
        return Vec::new();
    }
    let text_content = json!({
        "type": "text",
        "text": delta,
    });
    let mut meta = json!({
        "source": entry.source.clone(),
    });
    if !entry.metadata.is_empty() {
        let runtime = entry
            .metadata
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<String, Value>>();
        meta["runtime"] = Value::Object(runtime);
    }

    match entry.kind.as_str() {
        "user_message" => vec![json!({
            "sessionUpdate": "user_message_chunk",
            "content": text_content,
            "_meta": meta,
        })],
        "assistant_message" => vec![json!({
            "sessionUpdate": "agent_message_chunk",
            "content": text_content,
            "_meta": meta,
        })],
        "status_message" => {
            if entry.metadata.get("toolKind").and_then(Value::as_str) == Some("thinking") {
                vec![json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "content": text_content,
                    "_meta": meta,
                })]
            } else {
                vec![json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": text_content,
                    "_meta": meta,
                })]
            }
        }
        "system_message" => vec![json!({
            "sessionUpdate": "agent_message_chunk",
            "content": text_content,
            "_meta": meta,
        })],
        _ => Vec::new(),
    }
}

fn historical_tool_call_final_status(session: &SessionRecord) -> Option<&'static str> {
    if matches!(
        session.status,
        SessionStatus::Working | SessionStatus::Spawning | SessionStatus::Queued
    ) {
        return None;
    }

    Some(match session.status {
        SessionStatus::Errored | SessionStatus::Killed | SessionStatus::Terminated => "failed",
        _ => "completed",
    })
}

fn tool_call_event(
    entry: &conductor_core::types::ConversationEntry,
    delta: &str,
    event_type: &str,
) -> Value {
    let text_content = json!([{
        "type": "content",
        "content": {
            "type": "text",
            "text": delta,
        },
    }]);
    let tool_kind = normalize_tool_kind(
        entry
            .metadata
            .get("toolKind")
            .and_then(Value::as_str)
            .unwrap_or("other"),
    );
    let status = normalize_tool_status(
        entry
            .metadata
            .get("toolStatus")
            .and_then(Value::as_str)
            .unwrap_or("running"),
    );
    let title = entry
        .metadata
        .get("toolTitle")
        .and_then(Value::as_str)
        .unwrap_or(entry.text.as_str());
    let raw_output = json!({
        "source": entry.source,
        "text": entry.text,
    });
    json!({
        "sessionUpdate": event_type,
        "toolCallId": entry.id,
        "title": title,
        "status": status,
        "kind": tool_kind,
        "content": text_content,
        "rawOutput": raw_output,
        "_meta": {
            "runtime": entry.metadata,
        }
    })
}

async fn finalize_open_tool_call<W>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    session_id: &str,
    cursor: &mut PromptStreamCursor,
    status: &str,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let Some(tool_call_id) = cursor.open_tool_call_id.take() else {
        return Ok(());
    };
    send_session_update(
        writer,
        wire_format,
        session_id,
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool_call_id,
            "status": status,
        }),
    )
    .await
}

async fn stream_static_session_updates<W>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    session: &SessionRecord,
    cursor: &mut PromptStreamCursor,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let approval_state = approval_state(session);
    let config_options = session_config_options(session);
    let config_signature = config_options.to_string();
    if !cursor.commands_sent {
        send_session_update(
            writer,
            wire_format,
            &session.id,
            json!({
                "sessionUpdate": "available_commands_update",
                "availableCommands": available_commands_value(),
                "_meta": {
                    "approvalState": approval_state,
                    "requiresApproval": approval_state != ACP_APPROVAL_GRANTED,
                }
            }),
        )
        .await?;
        cursor.commands_sent = true;
    }
    if !cursor.config_sent || cursor.config_signature.as_deref() != Some(config_signature.as_str())
    {
        send_session_update(
            writer,
            wire_format,
            &session.id,
            json!({
                "sessionUpdate": "config_option_update",
                "configOptions": config_options,
                "_meta": {
                    "approvalState": approval_state,
                    "requiresApproval": approval_state != ACP_APPROVAL_GRANTED,
                }
            }),
        )
        .await?;
        cursor.config_sent = true;
        cursor.config_signature = Some(config_signature);
    }
    if !cursor.mode_sent || cursor.approval_state.as_deref() != Some(approval_state) {
        send_session_update(
            writer,
            wire_format,
            &session.id,
            json!({
                "sessionUpdate": "current_mode_update",
                "currentModeId": ACP_MODE_DISPATCHER,
                "_meta": {
                    "approvalState": approval_state,
                    "requiresApproval": approval_state != ACP_APPROVAL_GRANTED,
                }
            }),
        )
        .await?;
        cursor.mode_sent = true;
        cursor.approval_state = Some(approval_state.to_string());
    }
    Ok(())
}

async fn stream_plan_update<W>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    session_id: &str,
    entries: Value,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    send_session_update(
        writer,
        wire_format,
        session_id,
        json!({
            "sessionUpdate": "plan",
            "entries": entries,
        }),
    )
    .await
}

async fn send_session_update<W>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    session_id: &str,
    update: Value,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let notification = JsonRpcNotification {
        jsonrpc: "2.0".to_string(),
        method: "session/update".to_string(),
        params: json!({
            "sessionId": session_id,
            "update": update,
        }),
    };
    write_jsonrpc_message(writer, wire_format, &notification).await
}

fn normalize_tool_kind(tool_kind: &str) -> &str {
    match tool_kind {
        "read" => "read",
        "write" | "edit" | "multiedit" => "edit",
        "grep" | "glob" | "ls" | "find" | "open" | "search" => "search",
        "websearch" => "search",
        "webfetch" => "fetch",
        "bash" | "command" | "task" => "execute",
        "thinking" => "think",
        _ => "other",
    }
}

fn normalize_tool_status(tool_status: &str) -> &str {
    match tool_status {
        "running" => "in_progress",
        "completed" => "completed",
        "failed" => "failed",
        "pending" => "pending",
        _ => "in_progress",
    }
}

fn available_commands_value() -> Value {
    json!([
        {
            "name": "board",
            "description": "Summarize current board state, priorities, and blockers."
        },
        {
            "name": "memory",
            "description": "Summarize ACP long-term and session memory."
        },
        {
            "name": "heartbeat",
            "description": "Run an ACP heartbeat review and surface deferred follow-ups."
        },
        {
            "name": "handoff",
            "description": "Refine a task for implementation handoff with context, skills, and the best-fit agent.",
            "input": {
                "hint": "task-ref or task title"
            }
        },
        {
            "name": "plan",
            "description": "Switch the next dispatcher turn into plan-only mode so ACP pauses before mutating the board."
        },
        {
            "name": "approve",
            "description": "If ACP is in plan-only mode, approve the current proposal so it can apply the agreed board tasks."
        },
        {
            "name": "reject",
            "description": "Reject or revise the current dispatcher proposal and keep the board unchanged."
        }
    ])
}

fn plan_entries(stage: &str) -> Value {
    let (review, inspect, proposal, approval, memory) = match stage {
        "completed" => (
            "completed",
            "completed",
            "completed",
            "completed",
            "completed",
        ),
        "awaiting_approval" => (
            "completed",
            "completed",
            "completed",
            "in_progress",
            "completed",
        ),
        "approved_execution" => (
            "completed",
            "completed",
            "completed",
            "completed",
            "in_progress",
        ),
        "cancelled" => (
            "completed",
            "completed",
            "in_progress",
            "pending",
            "pending",
        ),
        _ => ("in_progress", "pending", "pending", "pending", "pending"),
    };
    json!([
        {
            "content": "Review the user request and ACP memory context",
            "priority": "high",
            "status": review
        },
        {
            "content": "Inspect board state, blockers, and in-flight work",
            "priority": "high",
            "status": inspect
        },
        {
            "content": "Finalize the proposal: plan, intended tool calls, and exact board/task mutations",
            "priority": "high",
            "status": proposal
        },
        {
            "content": "Apply board mutations now, or pause in plan-only mode for review",
            "priority": "high",
            "status": approval
        },
        {
            "content": "Record follow-ups, heartbeat items, and durable directives",
            "priority": "medium",
            "status": memory
        }
    ])
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
                .context("Failed to decode newline-delimited ACP JSON-RPC request")?;
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
            serde_json::from_slice(&payload).context("Failed to decode ACP JSON-RPC request")?;
        return Ok(Some((request, JsonRpcWireFormat::ContentLength)));
    }
}

async fn write_jsonrpc_message<W, T>(
    writer: &Arc<Mutex<W>>,
    wire_format: JsonRpcWireFormat,
    message: &T,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
    T: Serialize,
{
    let body = serde_json::to_vec(message)?;
    let mut writer = writer.lock().await;
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
    writer.flush().await?;
    Ok(())
}

fn deserialize_params<T>(request: &JsonRpcRequest) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let params = request
        .params
        .clone()
        .ok_or_else(|| anyhow!("Missing params for {}", request.method))?;
    serde_json::from_value(params).with_context(|| format!("Invalid params for {}", request.method))
}

fn make_success_response(request: &JsonRpcRequest, result: Value) -> Result<JsonRpcResponse> {
    let id = request
        .id
        .clone()
        .ok_or_else(|| anyhow!("Missing request id for {}", request.method))?;
    Ok(JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        payload: JsonRpcPayload::Result(result),
    })
}

fn make_error_response(
    request: &JsonRpcRequest,
    code: i64,
    message: String,
    data: Option<Value>,
) -> Result<JsonRpcResponse> {
    let id = request
        .id
        .clone()
        .ok_or_else(|| anyhow!("Missing request id for {}", request.method))?;
    Ok(JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        payload: JsonRpcPayload::Error(JsonRpcError {
            code,
            message,
            data,
        }),
    })
}

#[derive(Debug, Clone, Default)]
struct PromptStreamCursor {
    sent_lengths: HashMap<String, usize>,
    last_title: Option<String>,
    last_updated_at: Option<String>,
    approval_state: Option<String>,
    config_signature: Option<String>,
    announced_tool_calls: HashSet<String>,
    open_tool_call_id: Option<String>,
    commands_sent: bool,
    config_sent: bool,
    mode_sent: bool,
}

impl PromptStreamCursor {
    fn from_session(session: &SessionRecord) -> Self {
        let config_options = session_config_options(session);
        Self {
            sent_lengths: session
                .conversation
                .iter()
                .map(|entry| (entry.id.clone(), entry.text.chars().count()))
                .collect(),
            last_title: Some(session_title(session)),
            last_updated_at: Some(session.last_activity_at.clone()),
            approval_state: Some(approval_state(session).to_string()),
            config_signature: Some(config_options.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default)]
struct ConductorMeta {
    project_id: Option<String>,
    dispatcher_agent: Option<String>,
    implementation_agent: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticateRequest {
    #[allow(dead_code)]
    method_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionsRequest {
    #[allow(dead_code)]
    cursor: Option<String>,
    cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionRequest {
    cwd: String,
    #[serde(default)]
    mcp_servers: Value,
    #[serde(default, rename = "_meta")]
    meta: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadSessionRequest {
    cwd: String,
    #[serde(default)]
    mcp_servers: Value,
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRequest {
    session_id: String,
    #[serde(default)]
    message_id: Option<String>,
    prompt: Vec<Value>,
    #[serde(default, rename = "_meta")]
    meta: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionConfigOptionRequest {
    session_id: String,
    config_id: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionModeRequest {
    session_id: String,
    mode_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelNotification {
    session_id: String,
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
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    params: Value,
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
    use super::{
        approval_state, dispatcher_message_from_prompt_content, parse_prompt_blocks,
        prompt_turn_dispatch_message, read_jsonrpc_request, session_config_options,
        stream_full_session_history, tool_call_event, updates_for_entry, write_jsonrpc_message,
        AcpServer, CreateDispatcherThreadOptions, JsonRpcNotification, JsonRpcWireFormat,
        LoadSessionRequest, ACP_APPROVAL_GRANTED, ACP_CONFIG_IMPLEMENTATION_AGENT,
        ACP_CONFIG_MODEL, ACP_CONFIG_THOUGHT_LEVEL,
    };
    use crate::mcp::{AppStateMcpBackend, CreateBoardTaskArgs, McpBackend};
    use crate::state::{
        AppState, ConversationEntry, SessionRecord, SessionStatus,
        ACP_SESSION_MCP_SERVERS_METADATA_KEY,
    };
    use anyhow::Result;
    use async_trait::async_trait;
    use conductor_core::config::{ConductorConfig, PreferencesConfig, ProjectConfig};
    use conductor_core::types::AgentKind;
    use conductor_db::Database;
    use conductor_executors::executor::{
        Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions,
    };
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::{atomic::AtomicBool, OnceLock};
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{mpsc, oneshot, Mutex};
    use tokio::time::{sleep, Duration};
    use url::Url;
    use uuid::Uuid;

    struct PromptCompletionExecutor;

    #[async_trait]
    impl Executor for PromptCompletionExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "ACP Prompt Completion Test Executor"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/true")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, _options: SpawnOptions) -> Result<ExecutorHandle> {
            let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8);
            tokio::spawn(async move {
                sleep(Duration::from_millis(20)).await;
                let _ = output_tx
                    .send(ExecutorOutput::Completed { exit_code: 0 })
                    .await;
            });
            let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(8);
            tokio::spawn(async move { while input_rx.recv().await.is_some() {} });
            let (kill_tx, _kill_rx) = oneshot::channel();
            Ok(ExecutorHandle::new(
                1,
                AgentKind::Codex,
                output_rx,
                input_tx,
                kill_tx,
            ))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            Vec::new()
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    async fn build_test_state(label: &str) -> (std::path::PathBuf, Arc<AppState>) {
        let root = std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        fs::create_dir_all(&repo).expect("test repo should be created");
        fs::write(repo.join("CONDUCTOR.md"), "## Inbox\n").expect("board should be created");

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
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(PromptCompletionExecutor));
        (root, state)
    }

    fn test_dispatcher_session(
        agent: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> SessionRecord {
        let mut session = SessionRecord::builder(
            "session-1".to_string(),
            "project-1".to_string(),
            agent.to_string(),
            "prompt".to_string(),
        )
        .model(model.map(str::to_string))
        .reasoning_effort(reasoning_effort.map(str::to_string))
        .build();
        session
            .metadata
            .insert("sessionKind".to_string(), "project_dispatcher".to_string());
        session
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn session_config_options_follow_zed_order_and_use_dispatcher_runtime_model() {
        let mut session =
            test_dispatcher_session("claude-code", Some("claude-opus-4-6"), Some("medium"));
        session
            .metadata
            .insert("acpImplementationAgent".to_string(), "codex".to_string());
        session
            .metadata
            .insert("acpImplementationModel".to_string(), "gpt-5.4".to_string());
        session.metadata.insert(
            "acpImplementationReasoningEffort".to_string(),
            "high".to_string(),
        );

        let config_options = session_config_options(&session);
        let items = config_options.as_array().expect("config options array");

        assert_eq!(items[0]["id"], Value::String(ACP_CONFIG_MODEL.to_string()));
        assert_eq!(items[0]["category"], Value::String("model".to_string()));
        assert_eq!(
            items[0]["currentValue"],
            Value::String("claude-opus-4-6".to_string())
        );
        assert_eq!(
            items[1]["id"],
            Value::String(ACP_CONFIG_THOUGHT_LEVEL.to_string())
        );
        assert_eq!(
            items[1]["currentValue"],
            Value::String("medium".to_string())
        );
        assert_eq!(
            items[2]["id"],
            Value::String(ACP_CONFIG_IMPLEMENTATION_AGENT.to_string())
        );
        assert_eq!(items[2]["currentValue"], Value::String("codex".to_string()));
    }

    #[test]
    fn session_config_options_keep_unknown_dispatcher_model_visible() {
        let session = test_dispatcher_session("codex", Some("gpt-5.4-preview"), None);
        let config_options = session_config_options(&session);
        let items = config_options.as_array().expect("config options array");
        let model_options = items[0]["options"].as_array().expect("model options array");

        assert_eq!(
            model_options[0]["value"],
            Value::String("gpt-5.4-preview".to_string())
        );
    }

    #[test]
    fn prompt_turn_dispatch_message_preserves_explicit_commands() {
        assert_eq!(prompt_turn_dispatch_message("approve"), "approve");
        assert_eq!(prompt_turn_dispatch_message("/board"), "/board");
        assert_eq!(
            prompt_turn_dispatch_message("   "),
            "Review the current dispatcher state, summarize the plan status, and respond according to the current ACP execution mode."
        );
    }

    #[test]
    fn parse_prompt_blocks_keeps_embedded_context_out_of_user_message_text() {
        let parsed = parse_prompt_blocks(&[
            json!({
                "type": "text",
                "text": "Investigate why dispatcher turns are leaking context.",
            }),
            json!({
                "type": "resource_link",
                "uri": "file:///repo/CONDUCTOR.md",
                "name": "CONDUCTOR.md",
            }),
            json!({
                "type": "resource",
                "resource": {
                    "uri": "zed:///buffer/123",
                    "mimeType": "text/plain",
                    "text": "dispatcher turn payload",
                }
            }),
        ])
        .expect("prompt should parse");

        assert_eq!(
            parsed.user_message,
            "Investigate why dispatcher turns are leaking context."
        );
        assert_eq!(
            parsed.recorded_attachments,
            vec!["file:///repo/CONDUCTOR.md".to_string()]
        );
        assert_eq!(
            parsed.runtime_attachments,
            vec!["file:///repo/CONDUCTOR.md".to_string()]
        );
        let runtime_context = parsed
            .runtime_context
            .expect("embedded resource should be rendered for runtime");
        assert!(runtime_context.contains("ACP embedded context:"));
        assert!(runtime_context.contains("zed:///buffer/123"));
        assert!(runtime_context.contains("dispatcher turn payload"));
    }

    #[test]
    fn dispatcher_message_uses_context_fallback_for_context_only_prompt() {
        let prompt = parse_prompt_blocks(&[json!({
            "type": "resource",
            "resource": {
                "uri": "zed:///buffer/only-context",
                "mimeType": "text/plain",
                "text": "selected code",
            }
        })])
        .expect("prompt should parse");

        assert_eq!(
            dispatcher_message_from_prompt_content(&prompt),
            "Review the provided ACP context and respond according to the current ACP execution mode."
        );
    }

    #[test]
    fn updates_for_entry_emit_plain_user_text_without_context_attachments() {
        let mut metadata = HashMap::new();
        metadata.insert("custom".to_string(), Value::String("kept".to_string()));
        let entry = ConversationEntry {
            id: "msg-1".to_string(),
            kind: "user_message".to_string(),
            source: "acp".to_string(),
            text: "Please inspect this file.".to_string(),
            created_at: "2026-03-27T00:00:00Z".to_string(),
            attachments: Vec::new(),
            metadata,
        };

        let updates = updates_for_entry(&entry, "Please inspect this file.");

        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0]["sessionUpdate"],
            Value::String("user_message_chunk".to_string())
        );
        assert_eq!(
            updates[0]["content"],
            json!({
                "type": "text",
                "text": "Please inspect this file.",
            })
        );
        assert_eq!(
            updates[0]["_meta"]["runtime"]["custom"],
            Value::String("kept".to_string())
        );
    }

    #[test]
    fn tool_call_event_wraps_text_in_content_blocks() {
        let mut metadata = HashMap::new();
        metadata.insert("toolKind".to_string(), Value::String("bash".to_string()));
        metadata.insert(
            "toolStatus".to_string(),
            Value::String("running".to_string()),
        );
        metadata.insert("toolTitle".to_string(), Value::String("Bash".to_string()));
        let entry = ConversationEntry {
            id: "tool-1".to_string(),
            kind: "status_message".to_string(),
            source: "runtime".to_string(),
            text: "ls -la".to_string(),
            created_at: "2026-03-27T00:00:00Z".to_string(),
            attachments: Vec::new(),
            metadata,
        };

        let update = tool_call_event(&entry, "ls", "tool_call_update");

        assert_eq!(
            update["content"],
            json!([{
                "type": "content",
                "content": {
                    "type": "text",
                    "text": "ls",
                },
            }])
        );
    }

    #[tokio::test]
    async fn stream_full_session_history_closes_last_tool_call_for_inactive_sessions() {
        let mut metadata = HashMap::new();
        metadata.insert("toolKind".to_string(), Value::String("bash".to_string()));
        metadata.insert(
            "toolStatus".to_string(),
            Value::String("running".to_string()),
        );
        metadata.insert("toolTitle".to_string(), Value::String("Bash".to_string()));
        let mut session = test_dispatcher_session("codex", None, None);
        session.status = SessionStatus::NeedsInput;
        session.conversation.push(ConversationEntry {
            id: "tool-1".to_string(),
            kind: "status_message".to_string(),
            source: "runtime".to_string(),
            text: "ls -la".to_string(),
            created_at: "2026-03-27T00:00:00Z".to_string(),
            attachments: Vec::new(),
            metadata,
        });

        let (mut client, writer_stream) = duplex(16 * 1024);
        let writer = Arc::new(Mutex::new(writer_stream));

        stream_full_session_history(&writer, JsonRpcWireFormat::ContentLength, &session)
            .await
            .expect("session history replay should succeed");
        {
            let mut guard = writer.lock().await;
            guard.shutdown().await.expect("writer should shut down");
        }

        let mut output = Vec::new();
        client
            .read_to_end(&mut output)
            .await
            .expect("reader should capture session updates");
        let output = String::from_utf8(output).expect("ACP notifications should be utf8");

        assert!(output.contains("\"sessionUpdate\":\"tool_call\""));
        assert!(output.contains("\"toolCallId\":\"tool-1\""));
        assert!(output.contains("\"sessionUpdate\":\"tool_call_update\""));
        assert!(output.contains("\"status\":\"completed\""));
    }

    #[tokio::test]
    async fn stream_full_session_history_keeps_last_tool_call_open_for_active_sessions() {
        let mut metadata = HashMap::new();
        metadata.insert("toolKind".to_string(), Value::String("bash".to_string()));
        metadata.insert(
            "toolStatus".to_string(),
            Value::String("running".to_string()),
        );
        metadata.insert("toolTitle".to_string(), Value::String("Bash".to_string()));
        let mut session = test_dispatcher_session("codex", None, None);
        session.status = SessionStatus::Working;
        session.conversation.push(ConversationEntry {
            id: "tool-1".to_string(),
            kind: "status_message".to_string(),
            source: "runtime".to_string(),
            text: "ls -la".to_string(),
            created_at: "2026-03-27T00:00:00Z".to_string(),
            attachments: Vec::new(),
            metadata,
        });

        let (mut client, writer_stream) = duplex(16 * 1024);
        let writer = Arc::new(Mutex::new(writer_stream));

        stream_full_session_history(&writer, JsonRpcWireFormat::ContentLength, &session)
            .await
            .expect("session history replay should succeed");
        {
            let mut guard = writer.lock().await;
            guard.shutdown().await.expect("writer should shut down");
        }

        let mut output = Vec::new();
        client
            .read_to_end(&mut output)
            .await
            .expect("reader should capture session updates");
        let output = String::from_utf8(output).expect("ACP notifications should be utf8");

        assert!(output.contains("\"sessionUpdate\":\"tool_call\""));
        assert!(!output.contains("\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":\"tool-1\",\"status\":\"completed\""));
        assert!(!output.contains("\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":\"tool-1\",\"status\":\"failed\""));
    }

    #[tokio::test]
    async fn acp_write_jsonrpc_message_supports_newline_delimited_jsonrpc() {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: "session/update".to_string(),
            params: json!({ "sessionId": "demo", "update": { "ok": true } }),
        };
        let (mut client, writer_stream) = duplex(1024);
        let writer = Arc::new(Mutex::new(writer_stream));

        write_jsonrpc_message(&writer, JsonRpcWireFormat::NewlineDelimited, &notification)
            .await
            .expect("newline-delimited write should succeed");
        {
            let mut guard = writer.lock().await;
            guard.shutdown().await.expect("writer should shut down");
        }

        let mut output = String::new();
        client.read_to_string(&mut output).await.unwrap();
        assert!(output.starts_with("{\"jsonrpc\":\"2.0\""));
        assert!(output.ends_with('\n'));
        let value: Value = serde_json::from_str(output.trim()).expect("output should be json");
        assert_eq!(value["method"], "session/update");
    }

    #[tokio::test]
    async fn acp_read_jsonrpc_request_supports_newline_delimited_jsonrpc() {
        let request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{}}\n";
        let mut reader = tokio::io::BufReader::new(std::io::Cursor::new(request.as_bytes()));

        let parsed = read_jsonrpc_request(&mut reader)
            .await
            .expect("newline-delimited read should succeed")
            .expect("request should be present");

        assert_eq!(parsed.1, JsonRpcWireFormat::NewlineDelimited);
        assert_eq!(parsed.0.method, "ping");
        assert_eq!(parsed.0.id, Some(json!(1)));
    }

    #[tokio::test]
    async fn load_session_clears_stale_session_mcp_servers_when_none_are_requested() {
        let (root, state) = build_test_state("acp-load-session-mcp-clear").await;
        let server = AcpServer::new(Arc::clone(&state));
        let mut session = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        session.metadata.insert(
            ACP_SESSION_MCP_SERVERS_METADATA_KEY.to_string(),
            "{\"filesystem\":{\"command\":\"npx\"}}".to_string(),
        );
        state
            .replace_dispatcher_thread(session.clone())
            .await
            .expect("dispatcher thread should persist");

        let (loaded, _) = server
            .load_session(LoadSessionRequest {
                cwd: root.join("repo").to_string_lossy().to_string(),
                mcp_servers: Value::Null,
                session_id: session.id.clone(),
            })
            .await
            .expect("load_session should succeed");

        assert!(!loaded
            .metadata
            .contains_key(ACP_SESSION_MCP_SERVERS_METADATA_KEY));
        let persisted = state
            .get_dispatcher_thread(&session.id)
            .await
            .expect("dispatcher thread should remain available");
        assert!(!persisted
            .metadata
            .contains_key(ACP_SESSION_MCP_SERVERS_METADATA_KEY));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn new_dispatchers_default_to_execution_enabled() {
        let (root, state) = build_test_state("acp-default-execution-state").await;
        let session = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        assert_eq!(approval_state(&session), ACP_APPROVAL_GRANTED);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn prompt_turn_streams_current_user_message_after_runtime_launch() {
        let (root, state) = build_test_state("acp-prompt-streaming").await;
        let server = AcpServer::new(Arc::clone(&state));
        let session = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        let request = super::JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(1)),
            method: "session/prompt".to_string(),
            params: Some(json!({})),
        };
        let params = super::PromptRequest {
            session_id: session.id.clone(),
            message_id: Some("user-turn-1".to_string()),
            prompt: vec![json!({
                "type": "text",
                "text": "Plan the next board change.",
            })],
            meta: None,
        };
        let (mut client, writer_stream) = duplex(16 * 1024);
        let writer = Arc::new(Mutex::new(writer_stream));

        let response = server
            .run_prompt_turn(
                &request,
                &params,
                session,
                Arc::new(AtomicBool::new(false)),
                &writer,
                JsonRpcWireFormat::ContentLength,
            )
            .await
            .expect("prompt turn should succeed");
        {
            let mut guard = writer.lock().await;
            guard.shutdown().await.expect("writer should shut down");
        }

        let mut output = Vec::new();
        client
            .read_to_end(&mut output)
            .await
            .expect("reader should capture session updates");
        let output = String::from_utf8(output).expect("ACP notifications should be utf8");
        let super::JsonRpcPayload::Result(result) = response.payload else {
            panic!("prompt turn should return a result payload");
        };
        assert_eq!(result["stopReason"], Value::String("end_turn".to_string()));
        assert!(output.contains("\"sessionUpdate\":\"user_message_chunk\""));
        assert!(output.contains("Plan the next board change."));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn acp_prompt_file_links_are_recorded_for_board_task_handoffs() {
        let _env_guard = env_lock().lock().await;
        let (root, state) = build_test_state("acp-prompt-attachment-handoff").await;
        let server = AcpServer::new(Arc::clone(&state));
        let session = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        let docs_dir = root.join("repo").join("docs");
        fs::create_dir_all(&docs_dir).expect("docs dir should exist");
        let attachment_path = docs_dir.join("dispatcher-audit.md");
        fs::write(&attachment_path, "# Dispatcher audit\n").expect("attachment should exist");
        let attachment_uri = Url::from_file_path(&attachment_path)
            .expect("attachment should convert to file uri")
            .to_string();

        let request = super::JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(1)),
            method: "session/prompt".to_string(),
            params: Some(json!({})),
        };
        let params = super::PromptRequest {
            session_id: session.id.clone(),
            message_id: Some("user-turn-attachment".to_string()),
            prompt: vec![
                json!({
                    "type": "text",
                    "text": "Review the attached audit and create a launch-ready task.",
                }),
                json!({
                    "type": "resource_link",
                    "uri": attachment_uri,
                    "name": "dispatcher-audit.md",
                }),
            ],
            meta: None,
        };
        let (_client, writer_stream) = duplex(16 * 1024);
        let writer = Arc::new(Mutex::new(writer_stream));
        server
            .run_prompt_turn(
                &request,
                &params,
                session.clone(),
                Arc::new(AtomicBool::new(false)),
                &writer,
                JsonRpcWireFormat::ContentLength,
            )
            .await
            .expect("prompt turn should succeed");

        let persisted = state
            .get_dispatcher_thread(&session.id)
            .await
            .expect("dispatcher thread should persist");
        let recorded = persisted
            .conversation
            .iter()
            .rev()
            .find(|entry| entry.kind == "user_message")
            .expect("prompt turn should record a user message");
        assert_eq!(recorded.attachments, vec![attachment_uri.clone()]);

        let mut active = persisted.clone();
        active.status = SessionStatus::Working;
        state
            .replace_dispatcher_thread(active)
            .await
            .expect("dispatcher thread should persist");

        std::env::set_var("CONDUCTOR_SESSION_ID", &session.id);
        std::env::set_var("CONDUCTOR_PROJECT_ID", "demo");

        let backend = AppStateMcpBackend::new(Arc::clone(&state));
        let payload = backend
            .create_dispatcher_task(CreateBoardTaskArgs {
                project: Some("demo".to_string()),
                title: "Review dispatcher audit".to_string(),
                objective: Some(
                    "Turn the attached dispatcher audit into an actionable worker task."
                        .to_string(),
                ),
                execution_mode: Some("worktree".to_string()),
                surfaces: Some(vec!["docs/dispatcher-audit.md".to_string()]),
                acceptance: Some(vec!["Task packet preserves the attached audit.".to_string()]),
                skills: Some(vec!["rust".to_string(), "dispatcher review".to_string()]),
                deliverables: Some(vec!["launch-ready task brief".to_string()]),
                role: Some("intake".to_string()),
                ..CreateBoardTaskArgs::default()
            })
            .await
            .expect("recorded ACP prompt attachments should satisfy task context");

        assert_eq!(payload["task"]["attachments"], json!([attachment_uri]));

        std::env::remove_var("CONDUCTOR_SESSION_ID");
        std::env::remove_var("CONDUCTOR_PROJECT_ID");
        let _ = fs::remove_dir_all(root);
    }
}
