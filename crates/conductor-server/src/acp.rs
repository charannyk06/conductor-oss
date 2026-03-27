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

use crate::acp_prompt::{
    acp_approval_decision, acp_dispatcher_turn_prefix, rewrite_acp_dispatcher_command,
    AcpApprovalDecision,
};
use crate::state::{resolve_board_file, AppState, SessionRecord, SessionStatus, SpawnRequest};

const ACP_SERVER_NAME: &str = "conductor-acp";
const ACP_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const ACP_PROTOCOL_VERSION: u64 = 1;
const ACP_SESSION_KIND: &str = "project_dispatcher";
const ACP_MODE_DISPATCHER: &str = "dispatcher";
const ACP_CONFIG_IMPLEMENTATION_AGENT: &str = "implementation_agent";
const ACP_CONFIG_REASONING_EFFORT: &str = "reasoning_effort";
const ACP_APPROVAL_STATE_METADATA_KEY: &str = "acpPlanApprovalState";
const ACP_APPROVAL_REQUIRED: &str = "approval_required";
const ACP_APPROVAL_GRANTED: &str = "approved_for_next_mutation";
const ACP_PROMPT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const ACP_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_CANCEL_GRACE_PERIOD: Duration = Duration::from_secs(3);

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
    ) -> Result<()>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        match request.method.as_str() {
            "authenticate" => {
                let _ = deserialize_params::<AuthenticateRequest>(&request)?;
                let response = make_success_response(&request, json!({}))?;
                write_jsonrpc_message(writer, &response).await?;
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
                write_jsonrpc_message(writer, &response).await?;
            }
            "ping" => {
                let response = make_success_response(&request, json!({}))?;
                write_jsonrpc_message(writer, &response).await?;
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
                write_jsonrpc_message(writer, &response).await?;
            }
            "session/new" => {
                let params = deserialize_params::<NewSessionRequest>(&request)?;
                let response_payload = self.new_session(params).await?;
                let response = make_success_response(&request, response_payload)?;
                write_jsonrpc_message(writer, &response).await?;
            }
            "session/load" => {
                let params = deserialize_params::<LoadSessionRequest>(&request)?;
                let (session, payload) = self.load_session(params).await?;
                stream_full_session_history(writer, &session).await?;
                let response = make_success_response(&request, payload)?;
                write_jsonrpc_message(writer, &response).await?;
            }
            "session/set_config_option" => {
                let params = deserialize_params::<SetSessionConfigOptionRequest>(&request)?;
                let payload = self.set_config_option(params).await?;
                let response = make_success_response(&request, payload)?;
                write_jsonrpc_message(writer, &response).await?;
            }
            "session/set_mode" => {
                let params = deserialize_params::<SetSessionModeRequest>(&request)?;
                self.set_mode(params).await?;
                let response = make_success_response(&request, json!({}))?;
                write_jsonrpc_message(writer, &response).await?;
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
                    if let Err(err) = server.handle_prompt_request(request, writer.clone()).await {
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
                            let _ = write_jsonrpc_message(&writer, &response).await;
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
                write_jsonrpc_message(writer, &response).await?;
            }
        }

        Ok(())
    }

    async fn list_sessions(&self, params: ListSessionsRequest) -> Result<Vec<Value>> {
        let filter_cwd = params.cwd.as_deref().map(PathBuf::from);
        let mut sessions = self
            .state
            .all_sessions()
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
        ensure_supported_mcp_servers(&params.mcp_servers)?;
        let session_meta = parse_conductor_meta(params.meta.as_ref());
        let (project_id, project) = self.resolve_project_from_cwd(&cwd, session_meta.project_id.as_deref()).await?;
        let session = self
            .state
            .enqueue_session_spawn_deferred(SpawnRequest {
                project_id: project_id.clone(),
                bridge_id: None,
                prompt: build_project_dispatcher_prompt_for_acp(
                    &self.state,
                    &project_id,
                    &project,
                    "",
                ),
                issue_id: None,
                agent: session_meta.dispatcher_agent.clone().or_else(|| project.agent.clone()),
                use_worktree: Some(false),
                permission_mode: Some("plan".to_string()),
                model: session_meta.model.clone(),
                reasoning_effort: session_meta.reasoning_effort.clone(),
                branch: None,
                base_branch: None,
                task_id: None,
                task_ref: None,
                attempt_id: None,
                parent_task_id: None,
                retry_of_session_id: None,
                profile: None,
                session_kind: Some(ACP_SESSION_KIND.to_string()),
                brief_path: None,
                attachments: Vec::new(),
                source: "acp".to_string(),
            })
            .await?;
        let mut updated = session.clone();
        updated.status = SessionStatus::Idle;
        updated.activity = Some("idle".to_string());
        updated.workspace_path = Some(cwd.to_string_lossy().to_string());
        updated
            .metadata
            .insert("agentCwd".to_string(), cwd.to_string_lossy().to_string());
        updated.summary = Some("ACP session created".to_string());
        updated
            .metadata
            .insert("summary".to_string(), "ACP session created".to_string());
        updated
            .metadata
            .insert("launchState".to_string(), "deferred".to_string());
        updated.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_REQUIRED.to_string(),
        );
        updated.conversation.clear();
        if let Some(implementation_agent) = session_meta.implementation_agent {
            updated
                .metadata
                .insert("acpImplementationAgent".to_string(), implementation_agent);
        }
        updated
            .metadata
            .insert("acpMode".to_string(), ACP_MODE_DISPATCHER.to_string());
        self.state.replace_session(updated.clone()).await?;
        if let Err(err) = self.state.sync_acp_dispatcher_state(&updated).await {
            tracing::warn!(session_id = %updated.id, error = %err, "failed to sync ACP dispatcher after session/new");
        }
        Ok(json!({
            "sessionId": updated.id,
            "approvalState": approval_state(&updated),
            "configOptions": session_config_options(&updated),
            "modes": dispatcher_mode_state(),
        }))
    }

    async fn load_session(&self, params: LoadSessionRequest) -> Result<(SessionRecord, Value)> {
        let session = self
            .state
            .get_session(&params.session_id)
            .await
            .with_context(|| format!("Unknown ACP session {}", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!("Session {} is not an ACP dispatcher session", params.session_id);
        }
        let cwd = PathBuf::from(&params.cwd);
        if !cwd.is_absolute() {
            bail!("session/load cwd must be an absolute path");
        }
        ensure_supported_mcp_servers(&params.mcp_servers)?;
        Ok((
            session.clone(),
            json!({
                "approvalState": approval_state(&session),
                "configOptions": session_config_options(&session),
                "modes": dispatcher_mode_state(),
            }),
        ))
    }

    async fn set_config_option(&self, params: SetSessionConfigOptionRequest) -> Result<Value> {
        let mut session = self
            .state
            .get_session(&params.session_id)
            .await
            .with_context(|| format!("Unknown ACP session {}", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!("Session {} is not an ACP dispatcher session", params.session_id);
        }

        match params.config_id.as_str() {
            ACP_CONFIG_IMPLEMENTATION_AGENT => {
                if !matches!(
                    params.value.as_str(),
                    "codex" | "claude-code" | "gemini"
                ) {
                    bail!(
                        "Unsupported implementation agent `{}`. Expected codex, claude-code, or gemini",
                        params.value
                    );
                }
                session
                    .metadata
                    .insert("acpImplementationAgent".to_string(), params.value);
            }
            ACP_CONFIG_REASONING_EFFORT => {
                if !matches!(params.value.as_str(), "low" | "medium" | "high") {
                    bail!(
                        "Unsupported reasoning effort `{}`. Expected low, medium, or high",
                        params.value
                    );
                }
                session.reasoning_effort = Some(params.value.clone());
                session
                    .metadata
                    .insert("reasoningEffort".to_string(), params.value);
            }
            other => bail!("Unsupported ACP config option `{other}`"),
        }

        session.last_activity_at = chrono::Utc::now().to_rfc3339();
        self.state.replace_session(session.clone()).await?;
        if let Err(err) = self.state.sync_acp_dispatcher_state(&session).await {
            tracing::warn!(session_id = %session.id, error = %err, "failed to sync ACP dispatcher after config update");
        }
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
            .get_session(&params.session_id)
            .await
            .with_context(|| format!("Unknown ACP session {}", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!("Session {} is not an ACP dispatcher session", params.session_id);
        }
        session
            .metadata
            .insert("acpMode".to_string(), ACP_MODE_DISPATCHER.to_string());
        session.last_activity_at = chrono::Utc::now().to_rfc3339();
        self.state.replace_session(session).await?;
        Ok(())
    }

    async fn cancel_session(&self, session_id: &str) -> Result<()> {
        if let Some(flag) = self
            .in_flight_prompts
            .lock()
            .await
            .get(session_id)
            .cloned()
        {
            flag.store(true, Ordering::SeqCst);
        }
        if let Err(err) = self.state.interrupt_session(session_id).await {
            tracing::debug!(session_id, error = %err, "ACP cancel could not interrupt live session");
        }
        Ok(())
    }

    async fn handle_prompt_request<W>(
        self: Arc<Self>,
        request: JsonRpcRequest,
        writer: Arc<Mutex<W>>,
    ) -> Result<()>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let params = deserialize_params::<PromptRequest>(&request)?;
        let session = self
            .wait_for_session_record(&params.session_id, ACP_SESSION_READY_TIMEOUT)
            .await
            .with_context(|| format!("ACP session {} is not ready", params.session_id))?;
        if !is_acp_dispatcher_session(&session) {
            bail!("Session {} is not an ACP dispatcher session", params.session_id);
        }

        let cancel_flag = {
            let mut in_flight = self.in_flight_prompts.lock().await;
            if in_flight.contains_key(&params.session_id) {
                bail!("ACP session {} already has a prompt in flight", params.session_id);
            }
            let flag = Arc::new(AtomicBool::new(false));
            in_flight.insert(params.session_id.clone(), flag.clone());
            flag
        };

        let response = self
            .run_prompt_turn(&request, &params, session, cancel_flag.clone(), &writer)
            .await;
        self.in_flight_prompts
            .lock()
            .await
            .remove(&params.session_id);
        let response = response?;
        write_jsonrpc_message(&writer, &response).await?;
        Ok(())
    }

    async fn run_prompt_turn<W>(
        &self,
        request: &JsonRpcRequest,
        params: &PromptRequest,
        session: SessionRecord,
        cancel_flag: Arc<AtomicBool>,
        writer: &Arc<Mutex<W>>,
    ) -> Result<JsonRpcResponse>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let prompt_meta = parse_conductor_meta(params.meta.as_ref());
        let (raw_prompt_message, attachments) = prompt_from_blocks(&params.prompt)?;
        let prompt_message = rewrite_acp_dispatcher_command(&raw_prompt_message);
        let approval_decision = acp_approval_decision(&raw_prompt_message);
        let mut approval_state = approval_state(&session).to_string();
        match approval_decision {
            AcpApprovalDecision::Approve => {
                self.update_approval_state(&params.session_id, ACP_APPROVAL_GRANTED)
                    .await?;
                approval_state = ACP_APPROVAL_GRANTED.to_string();
            }
            AcpApprovalDecision::Reject => {
                self.update_approval_state(&params.session_id, ACP_APPROVAL_REQUIRED)
                    .await?;
                approval_state = ACP_APPROVAL_REQUIRED.to_string();
            }
            AcpApprovalDecision::None => {}
        }
        let turn_is_approved = approval_state == ACP_APPROVAL_GRANTED;
        let preferred_implementation_agent = session
            .metadata
            .get("acpImplementationAgent")
            .cloned()
            .unwrap_or_else(|| "codex".to_string());
        let user_message = if prompt_message.trim().is_empty() {
            "Review the current dispatcher state, summarize the plan status, and respond according to the ACP approval gate.".to_string()
        } else {
            prompt_message
        };
        let effective_message = format!(
            "{}\n\nACP dispatcher preference: prefer `{preferred_implementation_agent}` for newly created implementation tasks unless the user explicitly wants another agent.\n\n{}",
            acp_dispatcher_turn_prefix(turn_is_approved),
            user_message
        );
        let effective_model = prompt_meta.model.or_else(|| session.model.clone());
        let effective_reasoning = prompt_meta
            .reasoning_effort
            .or_else(|| session.reasoning_effort.clone());
        let mut cursor = PromptStreamCursor::from_session(&session);
        stream_static_session_updates(writer, &params.session_id, &approval_state, &mut cursor)
            .await?;
        let initial_plan_stage = if turn_is_approved {
            "approved_execution"
        } else {
            "planning"
        };
        stream_plan_update(
            writer,
            &params.session_id,
            plan_entries(initial_plan_stage),
        )
        .await?;
        let launched_session = self
            .ensure_prompt_runtime(
                &session,
                &effective_message,
                attachments.clone(),
                effective_model.clone(),
                effective_reasoning.clone(),
            )
            .await?;
        if let Some(launched_session) = launched_session {
            cursor = PromptStreamCursor::from_session(&launched_session);
            cursor.commands_sent = true;
            cursor.mode_sent = true;
        } else {
            self.state
                .send_to_session(
                    &params.session_id,
                    effective_message,
                    attachments,
                    effective_model,
                    effective_reasoning,
                    "acp",
                )
                .await?;
        }

        let started_at = Instant::now();
        let mut stop_reason;
        loop {
            let current = self
                .state
                .get_session(&params.session_id)
                .await
                .with_context(|| format!("ACP session {} disappeared during prompt", params.session_id))?;
            stream_prompt_delta(writer, &current, &mut cursor).await?;

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
        stream_plan_update(writer, &params.session_id, plan_entries(plan_state)).await?;
        if turn_is_approved {
            self.update_approval_state(&params.session_id, ACP_APPROVAL_REQUIRED)
                .await?;
            stream_static_session_updates(
                writer,
                &params.session_id,
                ACP_APPROVAL_REQUIRED,
                &mut cursor,
            )
            .await?;
        }

        make_success_response(
            request,
            json!({
                "stopReason": stop_reason
            }),
        )
    }

    async fn resolve_project_from_cwd(
        &self,
        cwd: &Path,
        requested_project_id: Option<&str>,
    ) -> Result<(String, ProjectConfig)> {
        let config = self.state.config.read().await.clone();
        if let Some(project_id) = requested_project_id.map(str::trim).filter(|value| !value.is_empty()) {
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

    async fn wait_for_session_record(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Option<SessionRecord> {
        let started_at = Instant::now();
        loop {
            if let Some(session) = self.state.get_session(session_id).await {
                if session.status != SessionStatus::Queued && session.status != SessionStatus::Spawning {
                    return Some(session);
                }
            }
            if started_at.elapsed() >= timeout {
                return self.state.get_session(session_id).await;
            }
            sleep(ACP_PROMPT_POLL_INTERVAL).await;
        }
    }

    async fn ensure_prompt_runtime(
        &self,
        session: &SessionRecord,
        effective_message: &str,
        attachments: Vec<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<Option<SessionRecord>> {
        if self.state.ensure_session_live(&session.id).await? {
            return Ok(None);
        }

        let spawn_request = session
            .metadata
            .get("spawnRequest")
            .cloned()
            .with_context(|| format!("ACP session {} is missing spawn request metadata", session.id))?;
        let mut request: SpawnRequest = serde_json::from_str(&spawn_request)
            .with_context(|| format!("ACP session {} has invalid spawn request metadata", session.id))?;
        request.prompt = merge_dispatcher_prompt_with_user(&request.prompt, effective_message);
        request.attachments = attachments;
        request.model = model;
        request.reasoning_effort = reasoning_effort;
        let mut spawned = self.state
            .spawn_session_now(request, Some(session.id.clone()))
            .await?;
        if let Some(entry) = spawned.conversation.first_mut() {
            if entry.kind == "user_message" && entry.source == "acp" {
                entry.metadata.insert(
                    "acpInternalBootstrap".to_string(),
                    Value::Bool(true),
                );
            }
        }
        self.state.replace_session(spawned.clone()).await?;
        Ok(Some(spawned))
    }

    async fn update_approval_state(
        &self,
        session_id: &str,
        approval_state: &str,
    ) -> Result<()> {
        let mut session = self
            .state
            .get_session(session_id)
            .await
            .with_context(|| format!("Unknown ACP session {session_id}"))?;
        session.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            approval_state.to_string(),
        );
        session.last_activity_at = chrono::Utc::now().to_rfc3339();
        self.state.replace_session(session).await
    }
}

fn ensure_supported_mcp_servers(value: &Value) -> Result<()> {
    let unsupported = match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        _ => true,
    };
    if unsupported {
        bail!(
            "ACP external MCP server requests are not supported by this Conductor build yet"
        );
    }
    Ok(())
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

    while let Some(request) = read_jsonrpc_request(&mut reader).await? {
        server.handle_request(request, &writer).await?;
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

fn build_project_dispatcher_prompt_for_acp(
    state: &Arc<AppState>,
    project_id: &str,
    project: &ProjectConfig,
    user_prompt: &str,
) -> String {
    let repo_path = state.resolve_project_path(project);
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| project_id.to_string());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    let board_path = state.workspace_path.join(board_relative);
    let repo_display = display_path(&state.workspace_path, &repo_path);
    let board_display = display_path(&state.workspace_path, &board_path);

    let mut prompt = format!(
        concat!(
            "You are the Conductor ACP dispatcher for project `{}`.\n\n",
            "This is a long-lived orchestration chat, not a coding run. You are the master puppeteer for the project.\n\n",
            "Core responsibilities:\n",
            "- Maintain and refine the board at `{}`\n",
            "- Turn rough requests into a few high-signal tasks\n",
            "- Prefer meaningful parent tasks plus internal checklists over noisy child-task spam\n",
            "- Maintain ACP long-term memory for stable directives, architecture constraints, and repeated preferences\n",
            "- Maintain ACP short-term session memory for the latest decisions, blockers, live context, and next actions\n",
            "- Keep track of heartbeat-style follow-ups so deferred work surfaces again instead of getting lost in chat\n",
            "- Create or update board tasks so dedicated coding sessions can be launched separately\n",
            "- Use native Conductor MCP tools when available to inspect the board, create tasks, update task state, and inspect task attempt lifecycles\n",
            "- Do not do the main implementation work in this dispatcher unless the user explicitly asks for that\n",
            "- Prefer handing implementation to dedicated `codex`, `claude-code`, or `gemini` sessions\n\n",
            "Project context:\n",
            "- Repo path: `{}`\n",
            "- Board path: `{}`\n",
            "- Default branch: `{}`\n\n",
            "Operating rules:\n",
            "- Operate against the main project workspace and board context; do not create isolated implementation branches or worktrees from this ACP session\n",
            "- Default to planning mode: inspect the repo and board, then produce the finalized plan before making board changes\n",
            "- When the user asks for product shaping, convert it into board structure and clear tasks\n",
            "- When implementation should happen, create or update launchable tasks instead of jumping straight into code\n",
            "- Keep the conversation stateful and use the board as the shared execution surface\n",
            "- Every task you create should carry the minimum viable implementation packet: problem statement, exact files or surfaces to inspect, relevant skills or constraints, and the recommended agent (`codex`, `claude-code`, or `gemini`)\n",
            "- Before any board mutation, first present: the proposed plan, the exact board/task mutations, the intended tool calls, and the recommended implementation agent per task\n",
            "- Do not create or update board tasks until the user explicitly approves the proposal\n",
            "- If the user asks for revisions, revise the proposal and ask for approval again\n",
            "- After explicit approval, execute only the approved board/task mutations and then report the exact task refs or titles you created or updated\n",
            "- When proposing tasks, use a compact task packet for each item: title, target board role, recommended agent, objective, exact files or surfaces to inspect, required skills or constraints, dependencies, and acceptance shape\n",
            "- When creating tasks after approval, keep the board task title concise and put the implementation packet into the task description or notes so a dedicated coding session can execute without reopening planning\n",
            "- If you defer work, create an explicit follow-up task instead of burying it in chat, such as a Phase 2 heartbeat or memory integration item\n",
            "- If you create tasks, assign the best-fit implementation agent (`codex`, `claude-code`, or `gemini`) and reference the exact task refs or titles you created so the user can launch coding sessions from them\n"
        ),
        project_id,
        board_display,
        repo_display,
        board_display,
        project.default_branch,
    );

    let trimmed = user_prompt.trim();
    if !trimmed.is_empty() {
        prompt.push_str("\n## User request\n");
        prompt.push_str(trimmed);
        prompt.push('\n');
    }

    prompt
}

fn merge_dispatcher_prompt_with_user(dispatcher_prompt: &str, user_prompt: &str) -> String {
    let trimmed = user_prompt.trim();
    if trimmed.is_empty() {
        return dispatcher_prompt.to_string();
    }
    if dispatcher_prompt.contains("\n## User request\n") {
        return dispatcher_prompt.to_string();
    }
    format!("{dispatcher_prompt}\n\n## User request\n{trimmed}\n")
}

fn display_path(workspace_root: &Path, path: &Path) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn dispatcher_mode_state() -> Value {
    json!({
        "availableModes": [
            {
                "id": ACP_MODE_DISPATCHER,
                "name": "Dispatcher",
                "description": "Long-lived ACP orchestration mode for shaping board tasks, managing memory, and dispatching codex, claude-code, and gemini implementation sessions."
            }
        ],
        "currentModeId": ACP_MODE_DISPATCHER
    })
}

fn session_config_options(session: &SessionRecord) -> Value {
    let implementation_agent = session
        .metadata
        .get("acpImplementationAgent")
        .cloned()
        .unwrap_or_else(|| "codex".to_string());
    let reasoning_effort = session
        .reasoning_effort
        .clone()
        .unwrap_or_else(|| "medium".to_string());

    json!({
        ACP_CONFIG_IMPLEMENTATION_AGENT: {
            "type": "select",
            "category": "other",
            "name": "Implementation Agent",
            "description": "Preferred coding agent for board tasks created by the ACP dispatcher.",
            "currentValue": implementation_agent,
            "options": [
                {
                    "value": "codex",
                    "name": "Codex",
                    "description": "Route implementation work to Codex sessions."
                },
                {
                    "value": "claude-code",
                    "name": "Claude Code",
                    "description": "Route implementation work to Claude Code sessions."
                },
                {
                    "value": "gemini",
                    "name": "Gemini",
                    "description": "Route implementation work to Gemini sessions."
                }
            ]
        },
        ACP_CONFIG_REASONING_EFFORT: {
            "type": "select",
            "category": "thought_level",
            "name": "Reasoning Effort",
            "description": "Reasoning level for future ACP dispatcher turns.",
            "currentValue": reasoning_effort,
            "options": [
                {
                    "value": "low",
                    "name": "Low",
                    "description": "Faster, lighter reasoning."
                },
                {
                    "value": "medium",
                    "name": "Medium",
                    "description": "Balanced reasoning for normal dispatcher work."
                },
                {
                    "value": "high",
                    "name": "High",
                    "description": "Deeper reasoning for complex planning and task shaping."
                }
            ]
        }
    })
}

fn session_info_value(state: &Arc<AppState>, session: &SessionRecord) -> Value {
    json!({
        "sessionId": session.id.clone(),
        "cwd": session_cwd(state, session).unwrap_or_default(),
        "title": session_title(session),
        "updatedAt": session.last_activity_at.clone(),
        "approvalState": approval_state(session),
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
    let conductor = meta
        .and_then(|value| value.get("conductor"))
        .or(meta);
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
        .map(ToOwned::to_owned)
}

fn prompt_from_blocks(blocks: &[Value]) -> Result<(String, Vec<String>)> {
    let mut parts = Vec::new();
    let mut attachments = Vec::new();

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
                    parts.push(text.to_string());
                }
            }
            "resource_link" => {
                if let Some(uri) = block
                    .get("uri")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|uri| !uri.is_empty())
                {
                    attachments.push(uri.to_string());
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
                        attachments.push(uri.to_string());
                    }
                    if let Some(text) = resource
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                    {
                        parts.push(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    Ok((parts.join("\n\n"), attachments))
}

async fn stream_full_session_history<W>(
    writer: &Arc<Mutex<W>>,
    session: &SessionRecord,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut cursor = PromptStreamCursor::default();
    stream_static_session_updates(writer, &session.id, approval_state(session), &mut cursor)
        .await?;
    stream_prompt_delta(writer, session, &mut cursor).await
}

async fn stream_prompt_delta<W>(
    writer: &Arc<Mutex<W>>,
    session: &SessionRecord,
    cursor: &mut PromptStreamCursor,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    stream_static_session_updates(writer, &session.id, approval_state(session), cursor).await?;
    let current_title = session_title(session);
    if cursor.last_title.as_ref() != Some(&current_title)
        || cursor.last_updated_at.as_ref() != Some(&session.last_activity_at)
    {
        send_session_update(
            writer,
            &session.id,
            json!({
                "sessionUpdate": "session_info_update",
                "title": current_title,
                "updatedAt": session.last_activity_at.clone(),
                "_meta": {
                    "approvalState": approval_state(session),
                    "requiresApproval": approval_state(session) != ACP_APPROVAL_GRANTED,
                }
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
                    finalize_open_tool_call(writer, &session.id, cursor, "completed").await?;
                }
                let tool_call_id = entry.id.clone();
                let update = if cursor.announced_tool_calls.insert(tool_call_id.clone()) {
                    cursor.open_tool_call_id = Some(tool_call_id.clone());
                    tool_call_event(entry, &delta, "tool_call")
                } else {
                    tool_call_event(entry, &delta, "tool_call_update")
                };
                send_session_update(writer, &session.id, update).await?;
            } else {
                for update in updates_for_entry(entry, &delta) {
                    send_session_update(writer, &session.id, update).await?;
                }
            }
        } else {
            finalize_open_tool_call(writer, &session.id, cursor, "completed").await?;
            for update in updates_for_entry(entry, &delta) {
                send_session_update(writer, &session.id, update).await?;
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
            if entry
                .metadata
                .get("toolKind")
                .and_then(Value::as_str)
                == Some("thinking")
            {
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

fn tool_call_event(entry: &conductor_core::types::ConversationEntry, delta: &str, event_type: &str) -> Value {
    let text_content = json!([{
        "type": "text",
        "text": delta,
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
    session_id: &str,
    approval_state: &str,
    cursor: &mut PromptStreamCursor,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    if !cursor.commands_sent {
        send_session_update(
            writer,
            session_id,
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
    if !cursor.mode_sent || cursor.approval_state.as_deref() != Some(approval_state) {
        send_session_update(
            writer,
            session_id,
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
    session_id: &str,
    entries: Value,
) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    send_session_update(
        writer,
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
    write_jsonrpc_message(writer, &notification).await
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
            "name": "approve",
            "description": "Approve the current dispatcher proposal so ACP can create or update the agreed board tasks."
        },
        {
            "name": "reject",
            "description": "Reject or revise the current dispatcher proposal without mutating the board."
        }
    ])
}

fn plan_entries(stage: &str) -> Value {
    let (review, inspect, proposal, approval, memory) = match stage {
        "completed" => ("completed", "completed", "completed", "completed", "completed"),
        "awaiting_approval" => ("completed", "completed", "completed", "in_progress", "completed"),
        "approved_execution" => ("completed", "completed", "completed", "completed", "in_progress"),
        "cancelled" => ("completed", "completed", "in_progress", "pending", "pending"),
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
            "content": "Wait for explicit approval before creating or updating board tasks",
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
        .context("Failed to decode ACP JSON-RPC request")
        .map(Some)
}

async fn write_jsonrpc_message<W, T>(writer: &Arc<Mutex<W>>, message: &T) -> Result<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
    T: Serialize,
{
    let body = serde_json::to_vec(message)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut writer = writer.lock().await;
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(&body).await?;
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
    serde_json::from_value(params)
        .with_context(|| format!("Invalid params for {}", request.method))
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
        payload: JsonRpcPayload::Error(JsonRpcError { code, message, data }),
    })
}

#[derive(Debug, Clone, Default)]
struct PromptStreamCursor {
    sent_lengths: HashMap<String, usize>,
    last_title: Option<String>,
    last_updated_at: Option<String>,
    approval_state: Option<String>,
    announced_tool_calls: HashSet<String>,
    open_tool_call_id: Option<String>,
    commands_sent: bool,
    mode_sent: bool,
}

impl PromptStreamCursor {
    fn from_session(session: &SessionRecord) -> Self {
        Self {
            sent_lengths: session
                .conversation
                .iter()
                .map(|entry| (entry.id.clone(), entry.text.chars().count()))
                .collect(),
            last_title: Some(session_title(session)),
            last_updated_at: Some(session.last_activity_at.clone()),
            approval_state: Some(approval_state(session).to_string()),
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
