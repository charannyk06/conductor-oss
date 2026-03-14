use anyhow::{Context, Result};
use chrono::Utc;
use conductor_core::types::AgentKind;
use conductor_executors::agents::build_runtime_env;
use conductor_executors::executor::{ExecutorInput, ExecutorOutput, SpawnOptions};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use super::helpers::{
    append_output, is_runtime_status_line, merge_assistant_fragment, runtime_tool_metadata,
    sanitize_terminal_text,
};
use super::runtime_status::resolve_native_resume_target;
use super::types::{
    ConversationEntry, SessionRecord, SessionStatus, SpawnRequest, TerminalStreamEvent,
    DEFAULT_SESSION_HISTORY_LIMIT,
};
use super::workspace::{is_process_alive, terminate_process};
use super::AppState;

const DETACHED_PID_METADATA_KEY: &str = "detachedPid";
const LAUNCH_PROGRESS_PREFIX: &str = "\u{1b}[90m[Conductor]\u{1b}[0m";

const PARSER_STATE_KEY: &str = "parserState";
const PARSER_STATE_MESSAGE_KEY: &str = "parserStateMessage";
const PARSER_STATE_COMMAND_KEY: &str = "parserStateCommand";

pub(crate) struct OutputConsumerConfig {
    pub terminal_rx: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    pub mirror_terminal_output: bool,
    pub output_is_parsed: bool,
    pub timeout: Option<std::time::Duration>,
}

/// Enforce a hard limit on conversation entries to prevent unbounded memory growth.
/// Trims the oldest entries when the limit is exceeded.
fn enforce_conversation_limit(session: &mut SessionRecord) {
    if session.conversation.len() <= DEFAULT_SESSION_HISTORY_LIMIT {
        return;
    }
    let excess = session.conversation.len() - DEFAULT_SESSION_HISTORY_LIMIT;
    session.conversation.drain(..excess);
}

fn project_defaults_to_skip_permissions(project: &conductor_core::config::ProjectConfig) -> bool {
    !matches!(
        project.agent_config.permissions.as_deref().map(str::trim),
        Some("default")
    )
}

fn resolve_skip_permissions(
    request_permission_mode: Option<&str>,
    project: &conductor_core::config::ProjectConfig,
) -> bool {
    match request_permission_mode.map(str::trim) {
        Some("auto") => true,
        Some("ask") | Some("plan") => false,
        _ => project_defaults_to_skip_permissions(project),
    }
}

fn format_launch_progress(message: &str) -> String {
    format!("{LAUNCH_PROGRESS_PREFIX} {message}\r\n")
}

fn persisted_output_line(event: &ExecutorOutput) -> Option<String> {
    match event {
        ExecutorOutput::Stdout(line) | ExecutorOutput::Stderr(line) => {
            let sanitized = sanitize_terminal_text(line);
            let trimmed = sanitized.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        ExecutorOutput::StructuredStatus { .. } | ExecutorOutput::Composite(_) => None,
        _ => None,
    }
}

fn detached_runtime_pid(session: &SessionRecord) -> Option<u32> {
    session
        .metadata
        .get(DETACHED_PID_METADATA_KEY)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0)
}

fn runtime_pids(session: &SessionRecord) -> Vec<u32> {
    let mut pids = Vec::with_capacity(2);
    if let Some(pid) = session.pid.filter(|pid| *pid > 1) {
        pids.push(pid);
    }
    if let Some(pid) = detached_runtime_pid(session)
        .filter(|pid| *pid > 1)
        .filter(|pid| !pids.contains(pid))
    {
        pids.push(pid);
    }
    pids
}

/// Shared Stdout event handler used by both `append_and_apply` and `apply_runtime_event`.
fn apply_stdout_event(session: &mut SessionRecord, line: &str, is_live: bool) {
    if is_live && !session.status.is_terminal() {
        session.status = SessionStatus::Working;
        session.activity = Some("active".to_string());
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        append_runtime_assistant_break(session);
    } else {
        if detect_parser_state(session, trimmed) || is_runtime_status_line(trimmed) {
            append_runtime_status_entry(session, trimmed);
        } else {
            clear_parser_state(session);
            append_runtime_assistant_entry(session, line.trim_end());
        }
        session.summary = Some(trimmed.to_string());
        session
            .metadata
            .insert("summary".to_string(), trimmed.to_string());
    }
}

fn append_runtime_assistant_entry(session: &mut SessionRecord, text: &str) {
    let sanitized = sanitize_terminal_text(text);
    let normalized = sanitized.trim_end();
    if normalized.trim().is_empty() {
        return;
    }

    if let Some(last) = session.conversation.last_mut() {
        if last.kind == "assistant_message" && last.source == "runtime" {
            merge_assistant_fragment(&mut last.text, normalized);
            last.created_at = Utc::now().to_rfc3339();
            return;
        }
    }

    session.conversation.push(ConversationEntry {
        id: Uuid::new_v4().to_string(),
        kind: "assistant_message".to_string(),
        source: "runtime".to_string(),
        text: normalized.to_string(),
        created_at: Utc::now().to_rfc3339(),
        attachments: Vec::new(),
        metadata: HashMap::new(),
    });
    enforce_conversation_limit(session);
}

fn append_runtime_assistant_break(session: &mut SessionRecord) {
    if let Some(last) = session.conversation.last_mut() {
        if last.kind == "assistant_message" && last.source == "runtime" {
            if !last.text.ends_with("\n\n") {
                if last.text.ends_with('\n') {
                    last.text.push('\n');
                } else {
                    last.text.push_str("\n\n");
                }
            }
            last.created_at = Utc::now().to_rfc3339();
        }
    }
}

fn append_runtime_status_entry(session: &mut SessionRecord, text: &str) {
    append_runtime_status_entry_with_metadata(session, text, None);
}

fn build_session_preferences_update_text(
    previous_model: Option<&str>,
    next_model: Option<&str>,
    previous_reasoning_effort: Option<&str>,
    next_reasoning_effort: Option<&str>,
    model_changed: bool,
    reasoning_changed: bool,
) -> String {
    let mut parts = Vec::new();

    if model_changed {
        let line = match (previous_model, next_model) {
            (Some(previous), Some(next)) => format!("Model switched: {previous} -> {next}"),
            (None, Some(next)) => format!("Model set: {next}"),
            _ => "Model updated.".to_string(),
        };
        parts.push(line);
    }

    if reasoning_changed {
        let line = match (previous_reasoning_effort, next_reasoning_effort) {
            (Some(previous), Some(next)) => format!("Reasoning updated: {previous} -> {next}"),
            (None, Some(next)) => format!("Reasoning set: {next}"),
            _ => "Reasoning updated.".to_string(),
        };
        parts.push(line);
    }

    if parts.is_empty() {
        "Session preferences updated.".to_string()
    } else {
        parts.join("\n")
    }
}

fn append_runtime_status_entry_with_metadata(
    session: &mut SessionRecord,
    text: &str,
    explicit_metadata: Option<HashMap<String, Value>>,
) {
    let sanitized = sanitize_terminal_text(text);
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return;
    }

    if let Some(last) = session.conversation.last() {
        if last.kind == "status_message" && last.source == "runtime" && last.text.trim() == trimmed
        {
            return;
        }
    }

    let mut metadata = HashMap::new();
    if let Some(explicit_metadata) = explicit_metadata {
        metadata = explicit_metadata;
    } else if let Some(tool_metadata) = runtime_tool_metadata(trimmed) {
        if let Some(object) = tool_metadata.as_object() {
            for (key, value) in object {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }

    session.conversation.push(ConversationEntry {
        id: Uuid::new_v4().to_string(),
        kind: "status_message".to_string(),
        source: "runtime".to_string(),
        text: trimmed.to_string(),
        created_at: Utc::now().to_rfc3339(),
        attachments: Vec::new(),
        metadata,
    });
    enforce_conversation_limit(session);
}

fn clear_parser_state(session: &mut SessionRecord) {
    session.metadata.remove(PARSER_STATE_KEY);
    session.metadata.remove(PARSER_STATE_MESSAGE_KEY);
    session.metadata.remove(PARSER_STATE_COMMAND_KEY);
}

fn auth_command_hint(agent: &str, text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for candidate in [
        "gh auth login",
        "copilot login",
        "claude login",
        "cursor-agent login",
        "gemini auth login",
        "codex login",
        "amp login",
        "opencode auth login",
        "qwen auth login",
    ] {
        if lower.contains(candidate) {
            return Some(candidate.to_string());
        }
    }

    match agent.trim().to_lowercase().as_str() {
        "github-copilot" => Some("copilot login".to_string()),
        "claude-code" | "ccr" => Some("claude login".to_string()),
        "cursor-cli" => Some("cursor-agent login".to_string()),
        "gemini" => Some("gemini auth login".to_string()),
        "codex" => Some("codex login".to_string()),
        "amp" => Some("amp login".to_string()),
        "droid" => Some("export FACTORY_API_KEY=...".to_string()),
        "opencode" => Some("opencode auth login".to_string()),
        "qwen-code" => Some("qwen auth login".to_string()),
        _ => None,
    }
}

fn set_parser_state(
    session: &mut SessionRecord,
    kind: &str,
    message: &str,
    command: Option<String>,
) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        clear_parser_state(session);
        return;
    }

    session
        .metadata
        .insert(PARSER_STATE_KEY.to_string(), kind.to_string());
    session
        .metadata
        .insert(PARSER_STATE_MESSAGE_KEY.to_string(), trimmed.to_string());
    if let Some(value) = command.filter(|value| !value.trim().is_empty()) {
        session
            .metadata
            .insert(PARSER_STATE_COMMAND_KEY.to_string(), value);
    } else {
        session.metadata.remove(PARSER_STATE_COMMAND_KEY);
    }
}

fn detect_parser_state(session: &mut SessionRecord, text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lower = trimmed.to_lowercase();
    let is_auth = lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("login required")
        || lower.contains("auth login")
        || lower.contains("device code")
        || lower.contains("oauth")
        || (lower.contains("sign in") && lower.contains("browser"))
        || lower.contains("open this url to authenticate");
    if is_auth {
        set_parser_state(
            session,
            "auth_required",
            trimmed,
            auth_command_hint(&session.agent, trimmed),
        );
        return true;
    }

    let is_interactive = lower.contains("stdin is not a terminal")
        || lower.contains("stdin is not a tty")
        || lower.contains("not a terminal")
        || lower.contains("terminal interaction")
        || lower.contains("interactive mode")
        || lower.contains("select an option")
        || lower.contains("use arrow keys")
        || lower.contains("press enter to continue")
        || (lower.contains("interactive") && lower.contains("terminal"));
    if is_interactive {
        set_parser_state(session, "interactive_required", trimmed, None);
        return true;
    }

    false
}

impl AppState {
    fn apply_requested_termination(session: &mut SessionRecord, action: &str) {
        let (status, summary) = match action {
            "kill" => (SessionStatus::Killed, "Interrupted"),
            "archive" => (SessionStatus::Archived, "Archived"),
            _ => return,
        };
        let finished_at = Utc::now().to_rfc3339();
        clear_parser_state(session);
        session.status = status;
        session.activity = Some("exited".to_string());
        session.last_activity_at = finished_at.clone();
        session.pid = None;
        session.summary = Some(summary.to_string());
        session
            .metadata
            .insert("finishedAt".to_string(), finished_at.clone());
        session.metadata.remove(DETACHED_PID_METADATA_KEY);
        session.metadata.remove("terminationRequested");
        session
            .metadata
            .insert("summary".to_string(), summary.to_string());
        if action == "archive" {
            session
                .metadata
                .insert("archivedAt".to_string(), finished_at);
        }
    }

    async fn mark_termination_requested(&self, session_id: &str, action: &str) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        session
            .metadata
            .insert("terminationRequested".to_string(), action.to_string());
        let updated = session.clone();
        drop(sessions);
        self.persist_session(&updated).await
    }

    async fn terminate_session_runtime(&self, session_id: &str) -> Result<()> {
        self.flush_terminal_capture(session_id).await;
        self.flush_terminal_restore_snapshot(session_id).await;

        let live_handle = self.terminal_hosts.get(session_id).await;
        let signaled_live_runtime = if let Some(handle) = live_handle {
            if let Some(kill_tx) = handle.kill_tx.lock().await.take() {
                kill_tx.send(()).is_ok()
            } else {
                false
            }
        } else {
            false
        };

        if !signaled_live_runtime {
            let _ = self.kill_detached_runtime(session_id).await;
        }

        if signaled_live_runtime {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        let mut termination_error = None;
        if let Some(session) = self.get_session(session_id).await {
            for pid in runtime_pids(&session) {
                if !is_process_alive(pid) {
                    continue;
                }
                if !terminate_process(pid) && is_process_alive(pid) {
                    termination_error = Some(anyhow::anyhow!(
                        "Failed to terminate process for session {session_id} (pid {pid})"
                    ));
                    break;
                }
            }
        }

        self.detach_terminal_runtime(session_id).await;

        if let Some(error) = termination_error {
            return Err(error);
        }

        Ok(())
    }

    async fn update_launch_stage(&self, session_id: &str, summary: &str) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        session.summary = Some(summary.to_string());
        session
            .metadata
            .insert("summary".to_string(), summary.to_string());
        session.last_activity_at = Utc::now().to_rfc3339();
        let updated = session.clone();
        drop(sessions);
        self.persist_session(&updated).await?;
        self.publish_snapshot().await;
        Ok(())
    }

    pub(crate) fn start_output_consumer(
        self: &Arc<Self>,
        session_id: String,
        executor: Arc<dyn conductor_executors::executor::Executor>,
        mut output_rx: tokio::sync::mpsc::Receiver<ExecutorOutput>,
        mut config: OutputConsumerConfig,
    ) {
        if let Some(timeout_duration) = config.timeout {
            let state = Arc::clone(self);
            let session_id = session_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(timeout_duration).await;
                tracing::warn!(session_id = %session_id, "Session timed out after {}s", timeout_duration.as_secs());
                let _ = state.kill_session(&session_id).await;
            });
        }
        let state = Arc::clone(self);
        let has_native_terminal_stream = config.terminal_rx.is_some();
        if let Some(mut terminal_rx) = config.terminal_rx.take() {
            let state = Arc::clone(self);
            let session_id = session_id.clone();
            tokio::spawn(async move {
                while let Some(bytes) = terminal_rx.recv().await {
                    state.emit_terminal_bytes(&session_id, &bytes).await;
                }
            });
        }
        let mirror_terminal_lines = config.mirror_terminal_output && !has_native_terminal_stream;
        tokio::spawn(async move {
            while let Some(event) = output_rx.recv().await {
                match event {
                    ExecutorOutput::Stdout(line) => {
                        if mirror_terminal_lines {
                            let raw_output = if line.ends_with('\n') || line.ends_with('\r') {
                                line.clone().into_bytes()
                            } else {
                                format!("{line}\r\n").into_bytes()
                            };
                            state.emit_terminal_bytes(&session_id, &raw_output).await;
                        }
                        let sanitized = sanitize_terminal_text(&line);
                        let mapped = if config.output_is_parsed {
                            ExecutorOutput::Stdout(sanitized)
                        } else {
                            executor.parse_output(&sanitized)
                        };
                        let _ = state.apply_parsed_output(&session_id, mapped).await;
                    }
                    ExecutorOutput::Stderr(line) => {
                        if mirror_terminal_lines {
                            let raw_output = if line.ends_with('\n') || line.ends_with('\r') {
                                line.clone().into_bytes()
                            } else {
                                format!("{line}\r\n").into_bytes()
                            };
                            state.emit_terminal_bytes(&session_id, &raw_output).await;
                        }
                        let sanitized = sanitize_terminal_text(&line);
                        let prefixed = format!("[stderr] {sanitized}");
                        let _ = state
                            .append_and_apply(
                                &session_id,
                                Some(&prefixed),
                                ExecutorOutput::Stderr(sanitized),
                            )
                            .await;
                    }
                    other => {
                        match &other {
                            ExecutorOutput::Completed { exit_code } => {
                                state
                                    .emit_terminal_stream_event(
                                        &session_id,
                                        TerminalStreamEvent::Exit(*exit_code),
                                    )
                                    .await;
                            }
                            ExecutorOutput::Failed { error, exit_code } => {
                                let message = match exit_code {
                                    Some(code) => format!("{error} (exit {code})"),
                                    None => error.clone(),
                                };
                                state
                                    .emit_terminal_stream_event(
                                        &session_id,
                                        TerminalStreamEvent::Error(message),
                                    )
                                    .await;
                            }
                            _ => {}
                        }
                        let should_kick = matches!(
                            other,
                            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
                        );
                        let _ = state.apply_runtime_event(&session_id, other).await;
                        if should_kick {
                            state.kick_spawn_supervisor().await;
                        }
                    }
                }
            }
        });
    }

    pub(crate) async fn spawn_session_now(
        self: &Arc<Self>,
        request: SpawnRequest,
        session_id_override: Option<String>,
    ) -> Result<SessionRecord> {
        let config = self.config.read().await.clone();
        let project = config
            .projects
            .get(&request.project_id)
            .cloned()
            .with_context(|| format!("Unknown project: {}", request.project_id))?;

        let requested_agent = request
            .agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        let project_agent = requested_agent
            .clone()
            .or_else(|| project.agent.clone())
            .unwrap_or_else(|| config.preferences.coding_agent.clone());

        let agent_kind = AgentKind::parse(&project_agent);
        let executors = self.executors.read().await;
        let executor = executors
            .get(&agent_kind)
            .cloned()
            .with_context(|| format!("Executor '{}' is not available", project_agent))?;
        drop(executors);

        let session_id = session_id_override
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let existing_record = if let Some(session_id) = session_id_override.as_deref() {
            self.get_session(session_id).await
        } else {
            None
        };
        let branch = request.branch.clone().or_else(|| {
            Some(format!(
                "session/{}",
                session_id.get(..8).unwrap_or(&session_id)
            ))
        });
        self.ensure_terminal_host(&session_id).await;
        let _ = self
            .update_launch_stage(&session_id, "Preparing workspace")
            .await;
        self.emit_terminal_text(
            &session_id,
            format_launch_progress("Preparing workspace..."),
        )
        .await;
        let workspace_job = async {
            let workspace_path = self
                .prepare_workspace(
                    &request.project_id,
                    &session_id,
                    &project,
                    request.use_worktree.unwrap_or(true),
                    branch.as_deref(),
                    request.base_branch.as_deref(),
                )
                .await?;
            let _ = self
                .update_launch_stage(&session_id, "Running workspace setup")
                .await;
            self.emit_terminal_text(
                &session_id,
                format_launch_progress("Running workspace setup..."),
            )
            .await;
            if let Err(err) = self.initialize_workspace(&project, &workspace_path).await {
                let _ = self.cleanup_unpersisted_workspace(&workspace_path).await;
                return Err(err);
            }
            Ok::<_, anyhow::Error>(workspace_path)
        };
        let dev_server_job = async {
            self.emit_terminal_text(
                &session_id,
                format_launch_progress("Checking shared dev server..."),
            )
            .await;
            self.ensure_dev_server(&request.project_id, &project).await
        };
        let (workspace_result, dev_server_result) = tokio::join!(workspace_job, dev_server_job);
        let workspace_path = match workspace_result {
            Ok(path) => path,
            Err(err) => {
                self.emit_terminal_text(
                    &session_id,
                    format_launch_progress(&format!("Launch failed: {err}")),
                )
                .await;
                return Err(err);
            }
        };
        let dev_server = match dev_server_result {
            Ok(dev_server) => dev_server,
            Err(err) => {
                self.emit_terminal_text(
                    &session_id,
                    format_launch_progress(&format!("Launch failed: {err}")),
                )
                .await;
                let _ = self.cleanup_unpersisted_workspace(&workspace_path).await;
                return Err(err);
            }
        };

        let prompt = if request.attachments.is_empty() {
            request.prompt.clone()
        } else {
            format!(
                "{}\n\nAttachments:\n{}",
                request.prompt,
                request
                    .attachments
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        let skip_permissions =
            resolve_skip_permissions(request.permission_mode.as_deref(), &project);

        if self
            .get_session(&session_id)
            .await
            .map(|session| session.status.is_terminal())
            .unwrap_or(false)
        {
            self.emit_terminal_text(
                &session_id,
                format_launch_progress("Launch cancelled before runtime attach."),
            )
            .await;
            let _ = self.cleanup_unpersisted_workspace(&workspace_path).await;
            return Err(anyhow::anyhow!(
                "Session {session_id} was cancelled during launch"
            ));
        }

        let mut spawn_env = HashMap::new();
        if executor.kind() == AgentKind::ClaudeCode {
            spawn_env.insert("CLAUDECODE".to_string(), String::new());
            // Mirror the JS Claude launcher behavior so the local Claude login
            // is used instead of any inherited API key billing context.
            spawn_env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
        }
        let spawn_env = build_runtime_env(executor.binary_path(), &spawn_env);

        let runtime_launch = match self
            .spawn_with_runtime(
                &project,
                executor.clone(),
                &session_id,
                SpawnOptions {
                    cwd: workspace_path.working_directory.clone(),
                    prompt: prompt.clone(),
                    model: request.model.clone(),
                    reasoning_effort: request.reasoning_effort.clone(),
                    skip_permissions,
                    extra_args: Vec::new(),
                    env: spawn_env,
                    branch: branch.clone(),
                    timeout: project
                        .agent_config
                        .session_timeout_secs
                        .map(std::time::Duration::from_secs),
                    interactive: false,
                    structured_output: false,
                    resume_target: None,
                },
            )
            .await
        {
            Ok(handle) => handle,
            Err(err) => {
                self.emit_terminal_text(
                    &session_id,
                    format_launch_progress(&format!("Launch failed: {err}")),
                )
                .await;
                let _ = self.cleanup_unpersisted_workspace(&workspace_path).await;
                return Err(err);
            }
        };

        let (pid, _kind, output_rx, input_tx, terminal_rx, resize_tx, kill_tx) =
            runtime_launch.handle.into_parts();
        if self
            .get_session(&session_id)
            .await
            .map(|session| session.status.is_terminal())
            .unwrap_or(false)
        {
            let _ = kill_tx.send(());
            let _ = self.cleanup_unpersisted_workspace(&workspace_path).await;
            return Err(anyhow::anyhow!(
                "Session {session_id} was cancelled during launch"
            ));
        }

        let mut record = SessionRecord::new(
            session_id.clone(),
            request.project_id.clone(),
            branch.clone(),
            request.issue_id.clone(),
            Some(workspace_path.root_path.to_string_lossy().to_string()),
            project_agent.clone(),
            request.model.clone(),
            request.reasoning_effort.clone(),
            request.prompt.clone(),
            Some(pid),
        );
        let started_at = Utc::now().to_rfc3339();
        self.emit_terminal_text(
            &session_id,
            format_launch_progress("Runtime attached. Streaming session..."),
        )
        .await;
        record.metadata.insert(
            "worktree".to_string(),
            workspace_path.root_path.to_string_lossy().to_string(),
        );
        record.metadata.insert(
            "agentCwd".to_string(),
            workspace_path
                .working_directory
                .to_string_lossy()
                .to_string(),
        );
        if let Some(log_path) = dev_server.log_path {
            record.metadata.insert("devServerLog".to_string(), log_path);
        }
        if let Some(url) = dev_server.preview_url {
            record.metadata.insert("devServerUrl".to_string(), url);
        }
        if let Some(port) = dev_server.preview_port {
            record
                .metadata
                .insert("devServerPort".to_string(), port.to_string());
        }
        record.metadata.extend(runtime_launch.metadata.clone());
        record
            .metadata
            .insert("startedAt".to_string(), started_at.clone());
        record
            .metadata
            .insert("launchState".to_string(), "running".to_string());
        record.metadata.insert(
            "taskId".to_string(),
            request
                .task_id
                .clone()
                .unwrap_or_else(|| format!("t-{session_id}")),
        );
        record.metadata.insert(
            "attemptId".to_string(),
            request
                .attempt_id
                .clone()
                .unwrap_or_else(|| format!("a-{session_id}")),
        );
        if let Some(task_ref) = request.task_ref.clone() {
            record.metadata.insert("taskRef".to_string(), task_ref);
        }
        if let Some(parent_task_id) = request.parent_task_id.clone() {
            record
                .metadata
                .insert("parentTaskId".to_string(), parent_task_id);
        }
        if let Some(retry_of_session_id) = request.retry_of_session_id.clone() {
            record
                .metadata
                .insert("retryOfSessionId".to_string(), retry_of_session_id);
        }
        if let Some(profile) = request.profile.clone() {
            record.metadata.insert("profile".to_string(), profile);
        }
        if let Some(brief_path) = request.brief_path.clone() {
            record.metadata.insert("briefPath".to_string(), brief_path);
        }

        if let Some(existing_record) = existing_record {
            record.created_at = existing_record.created_at;
            if !existing_record.conversation.is_empty() {
                record.conversation = existing_record.conversation;
            }
            for key in [
                "queuedAt",
                "queueSource",
                "launchAttempts",
                "lastRecoveredAt",
                "restartRecoveryCount",
                "recoveryState",
                "recoveryAction",
            ] {
                if let Some(value) = existing_record.metadata.get(key) {
                    record.metadata.insert(key.to_string(), value.clone());
                }
            }
            if let Some(queued_at) = existing_record.metadata.get("queuedAt") {
                if let Ok(queued_at) = chrono::DateTime::parse_from_rfc3339(queued_at) {
                    let wait_ms = (Utc::now() - queued_at.with_timezone(&Utc)).num_milliseconds();
                    if wait_ms >= 0 {
                        record
                            .metadata
                            .insert("queueWaitMs".to_string(), wait_ms.to_string());
                    }
                }
            }
        }

        if record.conversation.is_empty()
            && (!request.prompt.trim().is_empty() || !request.attachments.is_empty())
        {
            record.conversation.push(ConversationEntry {
                id: Uuid::new_v4().to_string(),
                kind: "user_message".to_string(),
                source: request.source,
                text: request.prompt.clone(),
                created_at: Utc::now().to_rfc3339(),
                attachments: request.attachments.clone(),
                metadata: HashMap::new(),
            });
        }

        let mut kill_tx = Some(kill_tx);
        if let Err(err) = self.replace_session(record.clone()).await {
            // Kill the already-spawned process before returning the error.
            if let Some(tx) = kill_tx.take() {
                let _ = tx.send(());
            }
            let _ = self.cleanup_unpersisted_workspace(&workspace_path).await;
            return Err(err.context("Failed to persist session after spawn"));
        }
        self.attach_terminal_runtime(
            &session_id,
            input_tx,
            resize_tx,
            kill_tx
                .take()
                .expect("runtime kill channel should exist before terminal attachment"),
        )
        .await;
        self.start_output_consumer(
            session_id.clone(),
            executor,
            output_rx,
            OutputConsumerConfig {
                terminal_rx,
                mirror_terminal_output: true,
                output_is_parsed: true,
                timeout: project
                    .agent_config
                    .session_timeout_secs
                    .map(std::time::Duration::from_secs),
            },
        );

        Ok(record)
    }

    async fn apply_parsed_output(&self, session_id: &str, event: ExecutorOutput) -> Result<()> {
        let mut events = vec![event];
        while let Some(event) = events.pop() {
            match event {
                ExecutorOutput::Composite(mut nested) => {
                    nested.reverse();
                    events.extend(nested);
                }
                ExecutorOutput::Stdout(line) => {
                    let output = ExecutorOutput::Stdout(line);
                    let persisted = persisted_output_line(&output);
                    self.append_and_apply(session_id, persisted.as_deref(), output)
                        .await?;
                }
                ExecutorOutput::StructuredStatus { text, metadata } => {
                    self.append_and_apply(
                        session_id,
                        None,
                        ExecutorOutput::StructuredStatus { text, metadata },
                    )
                    .await?;
                }
                other => {
                    self.apply_runtime_event(session_id, other).await?;
                }
            }
        }

        Ok(())
    }

    /// Combined append + apply to avoid acquiring the sessions write lock twice per line.
    pub(crate) async fn append_and_apply(
        &self,
        session_id: &str,
        line: Option<&str>,
        event: ExecutorOutput,
    ) -> Result<()> {
        let clear_live_handle = matches!(
            event,
            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
        );

        let is_live = self.has_terminal_host(session_id).await;
        let mut sessions = self.sessions.write().await;
        let session = match sessions.get_mut(session_id) {
            Some(value) => value,
            None => {
                drop(sessions);
                if clear_live_handle {
                    self.detach_terminal_runtime(session_id).await;
                }
                return Ok(());
            }
        };

        if session.status.is_terminal() {
            drop(sessions);
            if clear_live_handle {
                self.detach_terminal_runtime(session_id).await;
            }
            return Ok(());
        }

        // Append output (inline)
        if let Some(output_line) = line {
            append_output(session, output_line);
        }
        session.last_activity_at = Utc::now().to_rfc3339();

        // Apply event (inline from apply_runtime_event logic)
        match event {
            ExecutorOutput::Stdout(ref stdout_line) => {
                apply_stdout_event(session, stdout_line, is_live);
            }
            ExecutorOutput::Stderr(ref stderr_line) => {
                if detect_parser_state(session, stderr_line) {
                    append_runtime_status_entry(session, stderr_line);
                    session.summary = Some(stderr_line.trim().to_string());
                    session
                        .metadata
                        .insert("summary".to_string(), stderr_line.trim().to_string());
                }
                session
                    .metadata
                    .insert("lastStderr".to_string(), stderr_line.clone());
            }
            ExecutorOutput::StructuredStatus {
                ref text,
                ref metadata,
            } => {
                if is_live && !session.status.is_terminal() {
                    session.status = SessionStatus::Working;
                    session.activity = Some("active".to_string());
                }
                append_runtime_status_entry_with_metadata(session, text, Some(metadata.clone()));
            }
            _ => {}
        }

        let updated = session.clone();
        drop(sessions);
        if clear_live_handle {
            self.detach_terminal_runtime(session_id).await;
        }
        self.persist_session(&updated).await?;
        if let Some(output_line) = line {
            let _ = self
                .output_updates
                .send((updated.id.clone(), output_line.to_string()));
        }
        self.publish_snapshot().await;
        Ok(())
    }

    pub(crate) async fn apply_runtime_event(
        &self,
        session_id: &str,
        event: ExecutorOutput,
    ) -> Result<()> {
        let clear_live_handle = matches!(
            event,
            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
        );

        let is_live = self.has_terminal_host(session_id).await;
        let mut sessions = self.sessions.write().await;
        let session = match sessions.get_mut(session_id) {
            Some(value) => value,
            None => {
                drop(sessions);
                if clear_live_handle {
                    self.detach_terminal_runtime(session_id).await;
                }
                return Ok(());
            }
        };

        if session.status.is_terminal() {
            drop(sessions);
            if clear_live_handle {
                self.detach_terminal_runtime(session_id).await;
            }
            return Ok(());
        }

        session.last_activity_at = Utc::now().to_rfc3339();
        let termination_requested = session.metadata.get("terminationRequested").cloned();
        let requested_termination = termination_requested
            .as_deref()
            .filter(|action| matches!(*action, "kill" | "archive"));

        match event {
            ExecutorOutput::Stdout(line) => {
                apply_stdout_event(session, &line, is_live);
            }
            ExecutorOutput::Stderr(line) => {
                if detect_parser_state(session, &line) {
                    append_runtime_status_entry(session, &line);
                    session.summary = Some(line.trim().to_string());
                    session
                        .metadata
                        .insert("summary".to_string(), line.trim().to_string());
                }
                session.metadata.insert("lastStderr".to_string(), line);
            }
            ExecutorOutput::StructuredStatus { text, metadata } => {
                if is_live && !session.status.is_terminal() {
                    session.status = SessionStatus::Working;
                    session.activity = Some("active".to_string());
                }
                append_runtime_status_entry_with_metadata(session, &text, Some(metadata));
            }
            ExecutorOutput::NeedsInput(prompt) => {
                if is_live && !session.status.is_terminal() {
                    session.status = SessionStatus::NeedsInput;
                    session.activity = Some("waiting_input".to_string());
                    session.summary = Some(prompt.clone());
                    session
                        .metadata
                        .insert("summary".to_string(), prompt.clone());
                    append_runtime_status_entry(session, &prompt);
                    if !detect_parser_state(session, &prompt) {
                        set_parser_state(session, "needs_input", &prompt, None);
                    }
                }
            }
            ExecutorOutput::Completed { exit_code } => {
                if session.status.is_terminal() {
                    session.metadata.remove("terminationRequested");
                } else if let Some(action) = requested_termination {
                    Self::apply_requested_termination(session, action);
                } else if exit_code == 0 {
                    session.metadata.remove("terminationRequested");
                    clear_parser_state(session);
                    session
                        .metadata
                        .insert("exitCode".to_string(), exit_code.to_string());
                    session.status = SessionStatus::NeedsInput;
                    session.activity = Some("waiting_input".to_string());
                    session
                        .metadata
                        .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                    if session
                        .summary
                        .as_ref()
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        let summary = "Ready for follow-up".to_string();
                        session.summary = Some(summary.clone());
                        session.metadata.insert("summary".to_string(), summary);
                    }
                } else {
                    session
                        .metadata
                        .insert("exitCode".to_string(), exit_code.to_string());
                    session.status = SessionStatus::Errored;
                    session.activity = Some("exited".to_string());
                    session
                        .metadata
                        .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                    let summary = session
                        .summary
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| {
                            session
                                .metadata
                                .get("lastStderr")
                                .cloned()
                                .filter(|value| !value.trim().is_empty())
                        })
                        .unwrap_or_else(|| format!("Process exited with code {exit_code}"));
                    session.summary = Some(summary.clone());
                    session.metadata.insert("summary".to_string(), summary);
                    session.metadata.remove("terminationRequested");
                }
            }
            ExecutorOutput::Failed { error, exit_code } => {
                let parser_state_detected = detect_parser_state(session, &error);
                if session.status.is_terminal() {
                    session.metadata.remove("terminationRequested");
                } else if let Some(action) = requested_termination {
                    Self::apply_requested_termination(session, action);
                } else {
                    let requested_kill = error == "killed";
                    let summary = if requested_kill {
                        "Interrupted".to_string()
                    } else {
                        error.clone()
                    };
                    session.status = if requested_kill {
                        SessionStatus::Killed
                    } else {
                        SessionStatus::Errored
                    };
                    session.activity = Some("exited".to_string());
                    session
                        .metadata
                        .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                    session.summary = Some(summary.clone());
                    session.metadata.insert("summary".to_string(), summary);
                    if let Some(code) = exit_code {
                        session
                            .metadata
                            .insert("exitCode".to_string(), code.to_string());
                    }
                    session.metadata.remove("terminationRequested");
                    if !parser_state_detected && requested_kill {
                        clear_parser_state(session);
                    }
                }
            }
            ExecutorOutput::Composite(_) => {}
        }

        let updated = session.clone();
        drop(sessions);
        if clear_live_handle {
            self.detach_terminal_runtime(session_id).await;
        }
        self.persist_session(&updated).await?;
        self.publish_snapshot().await;
        Ok(())
    }

    pub async fn send_to_session(
        self: &Arc<Self>,
        session_id: &str,
        message: String,
        attachments: Vec<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        source: &str,
    ) -> Result<()> {
        if !self.ensure_session_live(session_id).await? {
            return Err(anyhow::anyhow!("Session {session_id} is not running"));
        }
        let handle = self.ensure_terminal_host(session_id).await;
        let input_tx = handle
            .input_tx
            .read()
            .await
            .clone()
            .with_context(|| format!("Session {session_id} is still launching"))?;

        let effective_message = if attachments.is_empty() {
            message.clone()
        } else {
            format!(
                "{}\n\nAttachments:\n{}",
                message,
                attachments
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Session {session_id} not found"))?;
        clear_parser_state(session);
        session.last_activity_at = Utc::now().to_rfc3339();
        session.status = SessionStatus::Working;
        session.activity = Some("active".to_string());
        let previous_model = session.model.clone();
        let previous_reasoning_effort = session.reasoning_effort.clone();
        let model_changed = model
            .as_ref()
            .map(|value| previous_model.as_deref() != Some(value.as_str()))
            .unwrap_or(false);
        let reasoning_changed = reasoning_effort
            .as_ref()
            .map(|value| previous_reasoning_effort.as_deref() != Some(value.as_str()))
            .unwrap_or(false);
        if let Some(model_value) = model.clone() {
            session.model = Some(model_value.clone());
            session.metadata.insert("model".to_string(), model_value);
        }
        if let Some(reasoning) = reasoning_effort.clone() {
            session.reasoning_effort = Some(reasoning.clone());
            session
                .metadata
                .insert("reasoningEffort".to_string(), reasoning);
        }
        if model_changed || reasoning_changed {
            let mut metadata = HashMap::new();
            metadata.insert(
                "eventType".to_string(),
                Value::String("session_preferences_updated".to_string()),
            );
            metadata.insert("modelChanged".to_string(), Value::Bool(model_changed));
            metadata.insert(
                "reasoningChanged".to_string(),
                Value::Bool(reasoning_changed),
            );
            if let Some(value) = previous_model.clone() {
                metadata.insert("previousModel".to_string(), Value::String(value));
            }
            if let Some(value) = model.clone() {
                metadata.insert("model".to_string(), Value::String(value));
            }
            if let Some(value) = previous_reasoning_effort.clone() {
                metadata.insert("previousReasoningEffort".to_string(), Value::String(value));
            }
            if let Some(value) = reasoning_effort.clone() {
                metadata.insert("reasoningEffort".to_string(), Value::String(value));
            }
            session.conversation.push(ConversationEntry {
                id: Uuid::new_v4().to_string(),
                kind: "system_message".to_string(),
                source: "session_preferences".to_string(),
                text: build_session_preferences_update_text(
                    previous_model.as_deref(),
                    model.as_deref(),
                    previous_reasoning_effort.as_deref(),
                    reasoning_effort.as_deref(),
                    model_changed,
                    reasoning_changed,
                ),
                created_at: Utc::now().to_rfc3339(),
                attachments: Vec::new(),
                metadata,
            });
        }
        session.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "user_message".to_string(),
            source: source.to_string(),
            text: message,
            created_at: Utc::now().to_rfc3339(),
            attachments,
            metadata: HashMap::new(),
        });
        enforce_conversation_limit(session);
        let updated = session.clone();
        drop(sessions);
        self.persist_session(&updated).await?;
        self.publish_snapshot().await;
        input_tx
            .send(ExecutorInput::Text(effective_message))
            .await?;
        Ok(())
    }

    pub async fn resume_session_with_prompt(
        self: &Arc<Self>,
        session_id: &str,
        message: String,
        attachments: Vec<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        source: &str,
    ) -> Result<()> {
        if self.ensure_session_live(session_id).await? {
            return self
                .send_to_session(
                    session_id,
                    message,
                    attachments,
                    model,
                    reasoning_effort,
                    source,
                )
                .await;
        }

        let session_snapshot = self
            .get_session(session_id)
            .await
            .with_context(|| format!("Session {session_id} not found"))?;

        if let Some(pid) =
            detached_runtime_pid(&session_snapshot).filter(|pid| is_process_alive(*pid))
        {
            return Err(anyhow::anyhow!(
                "Session {session_id} still has a detached runtime (pid {pid}). Kill or archive it before resuming."
            ));
        }

        let workspace_path = session_snapshot
            .metadata
            .get("agentCwd")
            .cloned()
            .or_else(|| session_snapshot.workspace_path.clone())
            .with_context(|| format!("Session {session_id} has no workspace path"))?;

        let config = self.config.read().await.clone();
        let project = config
            .projects
            .get(&session_snapshot.project_id)
            .cloned()
            .with_context(|| format!("Unknown project: {}", session_snapshot.project_id))?;

        let agent_kind = AgentKind::parse(&session_snapshot.agent);
        let executors = self.executors.read().await;
        let executor = executors
            .get(&agent_kind)
            .cloned()
            .with_context(|| format!("Executor '{}' is not available", session_snapshot.agent))?;
        drop(executors);

        let effective_message = if attachments.is_empty() {
            message.clone()
        } else {
            format!(
                "{}\n\nAttachments:\n{}",
                message,
                attachments
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };

        let effective_model = model.clone().or_else(|| session_snapshot.model.clone());
        let effective_reasoning_effort = reasoning_effort
            .clone()
            .or_else(|| session_snapshot.reasoning_effort.clone());
        let skip_permissions = project_defaults_to_skip_permissions(&project);
        let native_resume_target =
            resolve_native_resume_target(agent_kind.clone(), workspace_path.clone()).await;
        let send_follow_up_after_spawn = native_resume_target.is_some();

        // Apply the same environment overrides as initial spawn to avoid
        // leaking ANTHROPIC_API_KEY on resumed sessions.
        let mut resume_env = HashMap::new();
        if executor.kind() == AgentKind::ClaudeCode {
            resume_env.insert("CLAUDECODE".to_string(), String::new());
            resume_env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
        }
        let resume_env = build_runtime_env(executor.binary_path(), &resume_env);

        let handle = executor.clone();
        let runtime_launch = self
            .spawn_with_runtime(
                &project,
                handle.clone(),
                session_id,
                SpawnOptions {
                    cwd: std::path::PathBuf::from(&workspace_path),
                    prompt: if send_follow_up_after_spawn {
                        String::new()
                    } else {
                        effective_message.clone()
                    },
                    model: effective_model.clone(),
                    reasoning_effort: effective_reasoning_effort.clone(),
                    skip_permissions,
                    extra_args: Vec::new(),
                    env: resume_env,
                    branch: session_snapshot.branch.clone(),
                    timeout: project
                        .agent_config
                        .session_timeout_secs
                        .map(std::time::Duration::from_secs),
                    interactive: false,
                    structured_output: false,
                    resume_target: native_resume_target.clone(),
                },
            )
            .await?;
        let (pid, _kind, output_rx, input_tx, terminal_rx, resize_tx, kill_tx) =
            runtime_launch.handle.into_parts();

        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Session {session_id} not found"))?;
        if session.status == SessionStatus::Archived {
            return Err(anyhow::anyhow!("Session {session_id} is archived"));
        }

        clear_parser_state(session);
        session.status = SessionStatus::Working;
        session.activity = Some("active".to_string());
        session.last_activity_at = Utc::now().to_rfc3339();
        session.pid = Some(pid);
        session.model = effective_model.clone();
        session.reasoning_effort = effective_reasoning_effort.clone();
        session.summary = Some(message.trim().to_string());
        session.metadata.remove(DETACHED_PID_METADATA_KEY);
        session.metadata.extend(runtime_launch.metadata.clone());
        session
            .metadata
            .insert("summary".to_string(), message.trim().to_string());
        session
            .metadata
            .insert("startedAt".to_string(), Utc::now().to_rfc3339());
        session.metadata.remove("finishedAt");
        if native_resume_target.is_some() {
            session.conversation.push(ConversationEntry {
                id: Uuid::new_v4().to_string(),
                kind: "system_message".to_string(),
                source: "restore".to_string(),
                text: "Session restored and reattached to native CLI state.".to_string(),
                created_at: Utc::now().to_rfc3339(),
                attachments: Vec::new(),
                metadata: HashMap::new(),
            });
        } else if !send_follow_up_after_spawn {
            session.conversation.push(ConversationEntry {
                id: Uuid::new_v4().to_string(),
                kind: "user_message".to_string(),
                source: source.to_string(),
                text: message.clone(),
                created_at: Utc::now().to_rfc3339(),
                attachments: attachments.clone(),
                metadata: HashMap::new(),
            });
        }

        let updated = session.clone();
        drop(sessions);

        self.replace_session(updated).await?;
        self.attach_terminal_runtime(session_id, input_tx, resize_tx, kill_tx)
            .await;
        self.start_output_consumer(
            session_id.to_string(),
            handle,
            output_rx,
            OutputConsumerConfig {
                terminal_rx,
                mirror_terminal_output: true,
                output_is_parsed: true,
                timeout: project
                    .agent_config
                    .session_timeout_secs
                    .map(std::time::Duration::from_secs),
            },
        );

        if send_follow_up_after_spawn {
            return self
                .send_to_session(
                    session_id,
                    message,
                    attachments,
                    model,
                    reasoning_effort,
                    source,
                )
                .await;
        }

        Ok(())
    }

    pub async fn send_raw_to_session(
        self: &Arc<Self>,
        session_id: &str,
        keys: String,
    ) -> Result<()> {
        if !self.ensure_session_live(session_id).await? {
            return Err(anyhow::anyhow!("Session {session_id} is not running"));
        }
        let handle = self.ensure_terminal_host(session_id).await;
        let input_tx = handle
            .input_tx
            .read()
            .await
            .clone()
            .with_context(|| format!("Session {session_id} is still launching"))?;

        input_tx.send(ExecutorInput::Raw(keys)).await?;

        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            clear_parser_state(session);
            session.last_activity_at = Utc::now().to_rfc3339();
            if !session.status.is_terminal() {
                session.status = SessionStatus::Working;
                session.activity = Some("active".to_string());
            }
            let updated = session.clone();
            drop(sessions);
            self.persist_session(&updated).await?;
            self.publish_snapshot().await;
        } else {
            tracing::warn!("send_raw_to_session: session {session_id} not found in sessions map");
        }

        Ok(())
    }

    pub async fn interrupt_session(self: &Arc<Self>, session_id: &str) -> Result<()> {
        self.send_raw_to_session(session_id, "\u{3}".to_string())
            .await
    }

    pub async fn kill_session(&self, session_id: &str) -> Result<()> {
        self.mark_termination_requested(session_id, "kill").await?;
        self.terminate_session_runtime(session_id).await?;

        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            Self::apply_requested_termination(session, "kill");
            let updated = session.clone();
            drop(sessions);
            self.replace_session(updated).await?;
        }
        Ok(())
    }

    pub async fn archive_session(&self, session_id: &str) -> Result<()> {
        self.mark_termination_requested(session_id, "archive")
            .await?;
        self.terminate_session_runtime(session_id).await?;

        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Session {session_id} not found"))?;
        let already_archived = session.status == SessionStatus::Archived;
        if !already_archived {
            Self::apply_requested_termination(session, "archive");
        }

        let updated = session.clone();
        drop(sessions);
        if !already_archived {
            self.replace_session(updated.clone()).await?;
        }
        let config = self.config.read().await.clone();
        if let Some(project) = config.projects.get(&updated.project_id) {
            if let Err(err) = self.archive_workspace(session_id, &updated, project).await {
                tracing::warn!(session_id, error = %err, "Failed to archive workspace");
            }
        }
        Ok(())
    }

    pub async fn restore_session(self: &Arc<Self>, session_id: &str) -> Result<SessionRecord> {
        let session = self
            .get_session(session_id)
            .await
            .with_context(|| format!("Session {session_id} not found"))?;

        // Archive the original session before spawning replacement.
        {
            let mut sessions = self.sessions.write().await;
            if let Some(original) = sessions.get_mut(session_id) {
                if original.status != SessionStatus::Archived {
                    original.status = SessionStatus::Restored;
                    original.activity = Some("exited".to_string());
                    original.last_activity_at = chrono::Utc::now().to_rfc3339();
                    let updated = original.clone();
                    drop(sessions);
                    let _ = self.persist_session(&updated).await;
                    self.publish_snapshot().await;
                }
            }
        }

        self.spawn_session(SpawnRequest {
            project_id: session.project_id.clone(),
            prompt: session.prompt.clone(),
            issue_id: session.issue_id.clone(),
            agent: Some(session.agent.clone()),
            use_worktree: Some(
                session
                    .workspace_path
                    .as_deref()
                    .map(|path| path.contains("/worktrees/") || path.contains("\\worktrees\\"))
                    .unwrap_or(true),
            ),
            permission_mode: None,
            model: session.model.clone(),
            reasoning_effort: session.reasoning_effort.clone(),
            branch: session.branch.clone(),
            base_branch: None,
            task_id: session.metadata.get("taskId").cloned(),
            task_ref: session.metadata.get("taskRef").cloned(),
            attempt_id: None,
            parent_task_id: session.metadata.get("parentTaskId").cloned(),
            retry_of_session_id: None,
            profile: session.metadata.get("profile").cloned(),
            brief_path: session.metadata.get("briefPath").cloned(),
            attachments: Vec::new(),
            source: "restore".to_string(),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use conductor_core::config::{ConductorConfig, ProjectConfig};
    use conductor_db::Database;
    use conductor_executors::executor::{Executor, ExecutorHandle};
    use conductor_executors::process::{spawn_process, PtyDimensions};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command as StdCommand};
    use std::sync::Arc;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::{timeout, Duration};
    use uuid::Uuid;

    struct TestExecutor {
        kind: AgentKind,
    }

    #[async_trait]
    impl Executor for TestExecutor {
        fn kind(&self) -> AgentKind {
            self.kind.clone()
        }

        fn name(&self) -> &str {
            "Test Executor"
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
            drop(output_tx);
            let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(8);
            tokio::spawn(async move { while input_rx.recv().await.is_some() {} });
            let (kill_tx, _kill_rx) = oneshot::channel();
            Ok(ExecutorHandle::new(
                1,
                self.kind.clone(),
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

    struct PrefixingExecutor;

    #[async_trait]
    impl Executor for PrefixingExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Prefixing Executor"
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
            unreachable!("not used in tests")
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            Vec::new()
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(format!("parsed::{line}"))
        }
    }

    struct ResumeExecutor;

    #[async_trait]
    impl Executor for ResumeExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Resume Executor"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/sh")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
            let args = self.build_args(&options);
            let handle =
                spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
            Ok(ExecutorHandle::new(
                handle.pid,
                self.kind(),
                handle.output_rx,
                handle.input_tx,
                handle.kill_tx,
            ))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            vec![
                "-lc".to_string(),
                "printf 'ready\\n'; IFS= read -r line; printf 'echo:%s\\n' \"$line\"; sleep 0.2"
                    .to_string(),
            ]
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\"'\"'"))
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .expect("git command should run");
        assert!(
            status.success(),
            "git command failed: git -C {} {:?}",
            repo.display(),
            args
        );
    }

    fn seed_git_repo(repo: &Path) {
        fs::create_dir_all(repo).unwrap();
        run_git(repo, &["init", "-b", "main"]);
        run_git(repo, &["config", "user.email", "test@example.com"]);
        run_git(repo, &["config", "user.name", "Conductor Tests"]);
        fs::write(repo.join("README.md"), "seed\n").unwrap();
        run_git(repo, &["add", "."]);
        run_git(repo, &["commit", "-m", "seed"]);
    }

    fn spawn_sleep_process() -> Child {
        StdCommand::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep process should launch")
    }

    async fn wait_for_path(path: PathBuf) {
        timeout(Duration::from_secs(3), async move {
            loop {
                if path.exists() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("timed out waiting for path");
    }

    async fn build_state(root: &Path, project: ProjectConfig, project_id: &str) -> Arc<AppState> {
        let mut project = project;
        if project.runtime.is_none() {
            project.runtime = Some(crate::state::detached::DIRECT_RUNTIME_MODE.to_string());
        }
        let config = ConductorConfig {
            workspace: root.to_path_buf(),
            preferences: conductor_core::config::PreferencesConfig {
                coding_agent: "codex".to_string(),
                ..conductor_core::config::PreferencesConfig::default()
            },
            projects: BTreeMap::from([(project_id.to_string(), project)]),
            ..ConductorConfig::default()
        };

        let db = Database::in_memory().await.unwrap();
        let state = AppState::new(root.join("conductor.yaml"), config, db).await;
        state.executors.write().await.insert(
            AgentKind::Codex,
            Arc::new(TestExecutor {
                kind: AgentKind::Codex,
            }),
        );
        state.executors.write().await.insert(
            AgentKind::ClaudeCode,
            Arc::new(TestExecutor {
                kind: AgentKind::ClaudeCode,
            }),
        );
        state
    }

    #[test]
    fn resolve_skip_permissions_defaults_to_unsandboxed_when_project_does_not_override() {
        let project = ProjectConfig::default();

        assert!(project_defaults_to_skip_permissions(&project));
        assert!(resolve_skip_permissions(None, &project));
        assert!(resolve_skip_permissions(Some("default"), &project));
        assert!(!resolve_skip_permissions(Some("ask"), &project));
        assert!(!resolve_skip_permissions(Some("plan"), &project));
        assert!(resolve_skip_permissions(Some("auto"), &project));
    }

    #[test]
    fn resolve_skip_permissions_respects_explicit_sandbox_modes() {
        let mut project = ProjectConfig::default();
        project.agent_config.permissions = Some("default".to_string());

        assert!(!project_defaults_to_skip_permissions(&project));
        assert!(!resolve_skip_permissions(None, &project));
        assert!(!resolve_skip_permissions(Some("default"), &project));
        assert!(!resolve_skip_permissions(Some("ask"), &project));
        assert!(!resolve_skip_permissions(Some("plan"), &project));
        assert!(resolve_skip_permissions(Some("auto"), &project));
    }

    #[tokio::test]
    async fn spawn_session_applies_workspace_hooks_and_keeps_saved_agent_defaults() {
        let root = std::env::temp_dir().join(format!("conductor-session-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);
        fs::create_dir_all(repo.join("config")).unwrap();
        fs::create_dir_all(repo.join("notes")).unwrap();
        fs::write(repo.join("config/.env"), "TOKEN=test\n").unwrap();
        fs::write(repo.join("notes/spec.md"), "# spec\n").unwrap();

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            copy_files: vec!["config/.env".to_string(), "notes/*.md".to_string()],
            setup_script: vec!["printf ready > setup.marker".to_string()],
            dev_server_script: vec!["printf dev-ready > devserver.marker && sleep 5".to_string()],
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let session = state
            .spawn_session_now(
                SpawnRequest {
                    project_id: "demo".to_string(),
                    prompt: "Investigate".to_string(),
                    issue_id: None,
                    agent: Some("claude-code".to_string()),
                    use_worktree: Some(true),
                    permission_mode: None,
                    model: None,
                    reasoning_effort: Some("high".to_string()),
                    branch: None,
                    base_branch: None,
                    task_id: None,
                    task_ref: None,
                    attempt_id: None,
                    parent_task_id: None,
                    retry_of_session_id: None,
                    profile: None,
                    brief_path: None,
                    attachments: Vec::new(),
                    source: "spawn".to_string(),
                },
                None,
            )
            .await
            .unwrap();

        let worktree = PathBuf::from(session.metadata["worktree"].clone());
        assert!(worktree.exists());
        assert_ne!(worktree, repo);
        assert_eq!(session.agent, "claude-code");
        assert_eq!(
            session.metadata.get("agentCwd"),
            Some(&worktree.to_string_lossy().to_string())
        );
        assert!(worktree.join("config/.env").is_file());
        assert!(worktree.join("notes/spec.md").is_file());
        assert!(worktree.join("setup.marker").is_file());

        let dev_marker = repo.join("devserver.marker");
        wait_for_path(dev_marker.clone()).await;
        assert_eq!(fs::read_to_string(dev_marker).unwrap(), "dev-ready");
        assert!(session.metadata.contains_key("devServerLog"));

        let config = state.config.read().await;
        assert_eq!(
            config.projects["demo"].agent.as_deref(),
            Some("codex"),
            "spawn-time agent overrides should not rewrite project defaults"
        );
        assert_eq!(config.preferences.coding_agent, "codex");

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn send_to_session_records_structured_preference_updates() {
        let root =
            std::env::temp_dir().join(format!("conductor-pref-event-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let session = state
            .spawn_session_now(
                SpawnRequest {
                    project_id: "demo".to_string(),
                    prompt: "Investigate".to_string(),
                    issue_id: None,
                    agent: Some("codex".to_string()),
                    use_worktree: Some(true),
                    permission_mode: None,
                    model: Some("gpt-5.2-codex".to_string()),
                    reasoning_effort: Some("medium".to_string()),
                    branch: None,
                    base_branch: None,
                    task_id: None,
                    task_ref: None,
                    attempt_id: None,
                    parent_task_id: None,
                    retry_of_session_id: None,
                    profile: None,
                    brief_path: None,
                    attachments: Vec::new(),
                    source: "spawn".to_string(),
                },
                None,
            )
            .await
            .unwrap();

        state
            .send_to_session(
                &session.id,
                "Continue with the next pass".to_string(),
                Vec::new(),
                Some("gpt-5.4".to_string()),
                Some("high".to_string()),
                "follow_up",
            )
            .await
            .unwrap();

        let updated = state.get_session(&session.id).await.unwrap();
        let event = updated
            .conversation
            .iter()
            .find(|entry| entry.kind == "system_message" && entry.source == "session_preferences")
            .expect("preference update event should be stored");

        assert_eq!(
            event.text,
            "Model switched: gpt-5.2-codex -> gpt-5.4\nReasoning updated: medium -> high"
        );
        assert_eq!(
            event.metadata.get("eventType").and_then(Value::as_str),
            Some("session_preferences_updated")
        );
        assert_eq!(
            event.metadata.get("previousModel").and_then(Value::as_str),
            Some("gpt-5.2-codex")
        );
        assert_eq!(
            event.metadata.get("model").and_then(Value::as_str),
            Some("gpt-5.4")
        );
        assert_eq!(
            event
                .metadata
                .get("previousReasoningEffort")
                .and_then(Value::as_str),
            Some("medium")
        );
        assert_eq!(
            event
                .metadata
                .get("reasoningEffort")
                .and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(
            event.metadata.get("modelChanged").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            event
                .metadata
                .get("reasoningChanged")
                .and_then(Value::as_bool),
            Some(true)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn spawn_session_cleans_up_worktree_when_dev_server_bootstrap_fails() {
        let root =
            std::env::temp_dir().join(format!("conductor-dev-server-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);
        fs::create_dir_all(root.join(".conductor")).unwrap();
        fs::write(root.join(".conductor/rust-backend"), "not-a-directory").unwrap();

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            dev_server_script: vec!["printf dev-ready > devserver.marker && sleep 5".to_string()],
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let error = state
            .spawn_session_now(
                SpawnRequest {
                    project_id: "demo".to_string(),
                    prompt: "Investigate".to_string(),
                    issue_id: None,
                    agent: None,
                    use_worktree: Some(true),
                    permission_mode: None,
                    model: None,
                    reasoning_effort: None,
                    branch: None,
                    base_branch: None,
                    task_id: None,
                    task_ref: None,
                    attempt_id: None,
                    parent_task_id: None,
                    retry_of_session_id: None,
                    profile: None,
                    brief_path: None,
                    attachments: Vec::new(),
                    source: "spawn".to_string(),
                },
                None,
            )
            .await
            .expect_err("dev server bootstrap should fail");

        assert!(error.to_string().contains("Not a directory"));
        let worktree_root = root.join(".conductor").join("worktrees").join("demo");
        assert!(
            !worktree_root.exists()
                || fs::read_dir(&worktree_root)
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(true),
            "failed spawn should not leave an unpersisted worktree behind"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn queued_spawn_requests_are_promoted_by_the_supervisor() {
        let root = std::env::temp_dir().join(format!("conductor-queue-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let session = state
            .spawn_session(SpawnRequest {
                project_id: "demo".to_string(),
                prompt: "Queued run".to_string(),
                issue_id: None,
                agent: None,
                use_worktree: Some(true),
                permission_mode: None,
                model: None,
                reasoning_effort: None,
                branch: None,
                base_branch: None,
                task_id: None,
                task_ref: None,
                attempt_id: None,
                parent_task_id: None,
                retry_of_session_id: None,
                profile: None,
                brief_path: None,
                attachments: Vec::new(),
                source: "spawn".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(session.status, SessionStatus::Queued);

        let launched = timeout(Duration::from_secs(3), async {
            loop {
                let current = state.get_session(&session.id).await.unwrap();
                if current.status != SessionStatus::Queued
                    && current.metadata.contains_key("worktree")
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("queued session should be promoted");

        assert!(matches!(
            launched.status,
            SessionStatus::Spawning | SessionStatus::Working
        ));
        assert!(launched.metadata.contains_key("worktree"));

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn queued_spawn_requests_ignore_paused_sessions_without_live_runtimes() {
        let root =
            std::env::temp_dir().join(format!("conductor-queue-paused-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        for index in 0..5 {
            let mut paused = SessionRecord::new(
                format!("paused-{index}"),
                "demo".to_string(),
                Some(format!("session/paused-{index}")),
                None,
                Some(repo.to_string_lossy().to_string()),
                "codex".to_string(),
                None,
                None,
                "Paused".to_string(),
                None,
            );
            paused.status = SessionStatus::NeedsInput;
            paused.activity = Some("waiting_input".to_string());
            paused.summary = Some("Ready for follow-up".to_string());
            paused
                .metadata
                .insert("summary".to_string(), "Ready for follow-up".to_string());
            state.replace_session(paused).await.unwrap();
        }

        let session = state
            .spawn_session(SpawnRequest {
                project_id: "demo".to_string(),
                prompt: "Queued run".to_string(),
                issue_id: None,
                agent: None,
                use_worktree: Some(true),
                permission_mode: None,
                model: None,
                reasoning_effort: None,
                branch: None,
                base_branch: None,
                task_id: None,
                task_ref: None,
                attempt_id: None,
                parent_task_id: None,
                retry_of_session_id: None,
                profile: None,
                brief_path: None,
                attachments: Vec::new(),
                source: "spawn".to_string(),
            })
            .await
            .unwrap();

        let launched = timeout(Duration::from_secs(3), async {
            loop {
                let current = state.get_session(&session.id).await.unwrap();
                if current.status != SessionStatus::Queued
                    && current.metadata.contains_key("worktree")
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("queued session should not be blocked by paused sessions");

        assert!(matches!(
            launched.status,
            SessionStatus::Spawning | SessionStatus::Working
        ));
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn archive_session_runs_cleanup_and_archive_hooks_and_removes_worktree() {
        let root = std::env::temp_dir().join(format!("conductor-archive-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);
        let cleanup_log = root.join("cleanup.log");
        let archive_log = root.join("archive.log");

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            cleanup_script: vec![format!("printf cleanup >> {}", shell_quote(&cleanup_log))],
            archive_script: vec![format!("printf archive >> {}", shell_quote(&archive_log))],
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let session = state
            .spawn_session_now(
                SpawnRequest {
                    project_id: "demo".to_string(),
                    prompt: "Investigate".to_string(),
                    issue_id: None,
                    agent: None,
                    use_worktree: Some(true),
                    permission_mode: None,
                    model: None,
                    reasoning_effort: None,
                    branch: None,
                    base_branch: None,
                    task_id: None,
                    task_ref: None,
                    attempt_id: None,
                    parent_task_id: None,
                    retry_of_session_id: None,
                    profile: None,
                    brief_path: None,
                    attachments: Vec::new(),
                    source: "spawn".to_string(),
                },
                None,
            )
            .await
            .unwrap();

        let worktree = PathBuf::from(session.metadata["worktree"].clone());

        state.archive_session(&session.id).await.unwrap();

        timeout(Duration::from_secs(3), async {
            loop {
                let cleanup_done =
                    fs::read_to_string(&cleanup_log).ok().as_deref() == Some("cleanup");
                let archive_done =
                    fs::read_to_string(&archive_log).ok().as_deref() == Some("archive");
                if cleanup_done && archive_done && !worktree.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();

        assert_eq!(fs::read_to_string(&cleanup_log).unwrap(), "cleanup");
        assert_eq!(fs::read_to_string(&archive_log).unwrap(), "archive");
        assert!(!worktree.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn resume_session_blocks_when_detached_runtime_is_still_alive() {
        let root = std::env::temp_dir().join(format!("conductor-resume-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;
        let mut child = spawn_sleep_process();
        let pid = child.id();

        let mut session = SessionRecord::new(
            "detached-session".to_string(),
            "demo".to_string(),
            Some("session/demo".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            Some(pid),
        );
        session.status = SessionStatus::Stuck;
        session.activity = Some("blocked".to_string());
        session
            .metadata
            .insert(DETACHED_PID_METADATA_KEY.to_string(), pid.to_string());
        state.replace_session(session).await.unwrap();

        let error = state
            .resume_session_with_prompt(
                "detached-session",
                "Continue".to_string(),
                Vec::new(),
                None,
                None,
                "follow_up",
            )
            .await
            .expect_err("detached runtime should block resume");

        assert!(error.to_string().contains("detached runtime"));

        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn resume_session_with_prompt_ignores_legacy_tmux_project_configuration() {
        let root =
            std::env::temp_dir().join(format!("conductor-resume-tmux-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            runtime: Some("tmux".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(ResumeExecutor));

        let mut session = SessionRecord::new(
            "resume-tmux-session".to_string(),
            "demo".to_string(),
            Some("session/resume-tmux".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::NeedsInput;
        session.activity = Some("waiting_input".to_string());
        session.summary = Some("Ready for follow-up".to_string());
        session
            .metadata
            .insert("summary".to_string(), "Ready for follow-up".to_string());
        session
            .metadata
            .insert("agentCwd".to_string(), repo.to_string_lossy().to_string());
        state.replace_session(session).await.unwrap();

        state
            .resume_session_with_prompt(
                "resume-tmux-session",
                "Continue".to_string(),
                Vec::new(),
                None,
                None,
                "follow_up",
            )
            .await
            .unwrap();

        let updated = timeout(Duration::from_secs(5), async {
            loop {
                let current = state.get_session("resume-tmux-session").await.unwrap();
                if current.metadata.get("runtimeMode").map(String::as_str)
                    == Some(crate::state::detached::DIRECT_RUNTIME_MODE)
                    && current.pid.is_some()
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("resume should relaunch the session on the direct runtime");

        assert_eq!(
            updated.metadata.get("runtimeMode").map(String::as_str),
            Some(crate::state::detached::DIRECT_RUNTIME_MODE)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn kill_session_terminates_detached_runtime() {
        let root = std::env::temp_dir().join(format!("conductor-kill-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;
        let mut child = spawn_sleep_process();
        let pid = child.id();

        let mut session = SessionRecord::new(
            "detached-kill".to_string(),
            "demo".to_string(),
            Some("session/demo".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            Some(pid),
        );
        session.status = SessionStatus::Stuck;
        session.activity = Some("blocked".to_string());
        session
            .metadata
            .insert(DETACHED_PID_METADATA_KEY.to_string(), pid.to_string());
        state.replace_session(session).await.unwrap();

        state.kill_session("detached-kill").await.unwrap();

        let waited = timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(waited.is_ok(), "detached runtime should terminate");

        let updated = state.get_session("detached-kill").await.unwrap();
        assert_eq!(updated.status, SessionStatus::Killed);
        assert!(!updated.metadata.contains_key(DETACHED_PID_METADATA_KEY));

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn archive_session_terminates_detached_runtime() {
        let root =
            std::env::temp_dir().join(format!("conductor-archive-pid-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;
        let mut child = spawn_sleep_process();
        let pid = child.id();

        let mut session = SessionRecord::new(
            "detached-archive".to_string(),
            "demo".to_string(),
            Some("session/demo".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            Some(pid),
        );
        session.status = SessionStatus::Stuck;
        session.activity = Some("blocked".to_string());
        session
            .metadata
            .insert(DETACHED_PID_METADATA_KEY.to_string(), pid.to_string());
        state.replace_session(session).await.unwrap();

        state.archive_session("detached-archive").await.unwrap();

        let waited = timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(waited.is_ok(), "detached runtime should terminate");

        let updated = state.get_session("detached-archive").await.unwrap();
        assert_eq!(updated.status, SessionStatus::Archived);
        assert!(!updated.metadata.contains_key(DETACHED_PID_METADATA_KEY));
        assert!(updated.metadata.contains_key("archivedAt"));

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn completed_event_honors_archive_termination_request() {
        let root = std::env::temp_dir().join(format!(
            "conductor-archive-termination-test-{}",
            Uuid::new_v4()
        ));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let mut session = SessionRecord::new(
            "archive-completed".to_string(),
            "demo".to_string(),
            Some("session/demo".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            Some(42),
        );
        session.status = SessionStatus::Working;
        session.activity = Some("active".to_string());
        session
            .metadata
            .insert("terminationRequested".to_string(), "archive".to_string());
        state.replace_session(session).await.unwrap();

        state
            .apply_runtime_event(
                "archive-completed",
                ExecutorOutput::Completed { exit_code: 0 },
            )
            .await
            .unwrap();

        let updated = state.get_session("archive-completed").await.unwrap();
        assert_eq!(updated.status, SessionStatus::Archived);
        assert_eq!(updated.summary.as_deref(), Some("Archived"));
        assert_eq!(updated.activity.as_deref(), Some("exited"));
        assert!(updated.metadata.contains_key("archivedAt"));
        assert!(!updated.metadata.contains_key("terminationRequested"));

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn start_output_consumer_skips_reparsing_for_direct_runtime_output() {
        let root =
            std::env::temp_dir().join(format!("conductor-direct-output-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let mut session = SessionRecord::new(
            "direct-output".to_string(),
            "demo".to_string(),
            Some("session/direct-output".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        state.replace_session(session).await.unwrap();

        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8);
        state.start_output_consumer(
            "direct-output".to_string(),
            Arc::new(PrefixingExecutor),
            output_rx,
            OutputConsumerConfig {
                terminal_rx: None,
                mirror_terminal_output: true,
                output_is_parsed: true,
                timeout: None,
            },
        );
        output_tx
            .send(ExecutorOutput::Stdout("parsed::hello".to_string()))
            .await
            .unwrap();
        drop(output_tx);

        let updated = timeout(Duration::from_secs(3), async {
            loop {
                let current = state.get_session("direct-output").await.unwrap();
                if current
                    .conversation
                    .iter()
                    .any(|entry| entry.kind == "assistant_message")
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("consumer should append assistant output");

        let assistant = updated
            .conversation
            .iter()
            .find(|entry| entry.kind == "assistant_message")
            .expect("assistant message");
        assert_eq!(assistant.text, "parsed::hello");

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn start_output_consumer_fanouts_terminal_bytes_for_live_sessions() {
        let root =
            std::env::temp_dir().join(format!("conductor-terminal-stream-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let mut session = SessionRecord::new(
            "terminal-stream".to_string(),
            "demo".to_string(),
            Some("session/terminal-stream".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        state.replace_session(session).await.unwrap();

        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(8);
        tokio::spawn(async move { while input_rx.recv().await.is_some() {} });
        let (kill_tx, _kill_rx) = oneshot::channel();
        let handle = state
            .attach_terminal_runtime("terminal-stream", input_tx, None, kill_tx)
            .await;
        let mut terminal_rx = handle.terminal_tx.subscribe();

        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8);
        state.start_output_consumer(
            "terminal-stream".to_string(),
            Arc::new(PrefixingExecutor),
            output_rx,
            OutputConsumerConfig {
                terminal_rx: None,
                mirror_terminal_output: true,
                output_is_parsed: true,
                timeout: None,
            },
        );
        output_tx
            .send(ExecutorOutput::Stdout("hello".to_string()))
            .await
            .unwrap();

        let event = timeout(Duration::from_secs(3), terminal_rx.recv())
            .await
            .expect("terminal event should arrive")
            .expect("broadcast event should be readable");
        match event {
            TerminalStreamEvent::Stream(chunk) => {
                assert_eq!(chunk.sequence, 1);
                assert_eq!(String::from_utf8_lossy(&chunk.bytes), "hello\r\n");
            }
            other => panic!("unexpected terminal event: {other:?}"),
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn start_output_consumer_uses_native_terminal_stream_when_available() {
        let root = std::env::temp_dir().join(format!(
            "conductor-native-terminal-stream-test-{}",
            Uuid::new_v4()
        ));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let mut session = SessionRecord::new(
            "native-terminal-stream".to_string(),
            "demo".to_string(),
            Some("session/native-terminal-stream".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        state.replace_session(session).await.unwrap();

        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(8);
        tokio::spawn(async move { while input_rx.recv().await.is_some() {} });
        let (kill_tx, _kill_rx) = oneshot::channel();
        let handle = state
            .attach_terminal_runtime("native-terminal-stream", input_tx, None, kill_tx)
            .await;
        let mut terminal_rx = handle.terminal_tx.subscribe();

        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8);
        let (terminal_bytes_tx, terminal_bytes_rx) = mpsc::channel::<Vec<u8>>(8);
        state.start_output_consumer(
            "native-terminal-stream".to_string(),
            Arc::new(PrefixingExecutor),
            output_rx,
            OutputConsumerConfig {
                terminal_rx: Some(terminal_bytes_rx),
                mirror_terminal_output: true,
                output_is_parsed: true,
                timeout: None,
            },
        );
        output_tx
            .send(ExecutorOutput::Stdout("parsed::hello".to_string()))
            .await
            .unwrap();
        terminal_bytes_tx
            .send(b"\x1b[31mhello\x1b[0m".to_vec())
            .await
            .unwrap();

        let event = timeout(Duration::from_secs(3), terminal_rx.recv())
            .await
            .expect("native terminal event should arrive")
            .expect("broadcast event should be readable");
        match event {
            TerminalStreamEvent::Stream(chunk) => {
                assert_eq!(chunk.sequence, 1);
                assert_eq!(chunk.bytes, b"\x1b[31mhello\x1b[0m");
            }
            other => panic!("unexpected terminal event: {other:?}"),
        }

        let updated = timeout(Duration::from_secs(3), async {
            loop {
                let current = state.get_session("native-terminal-stream").await.unwrap();
                if current
                    .conversation
                    .iter()
                    .any(|entry| entry.kind == "assistant_message")
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("consumer should append assistant output");

        let assistant = updated
            .conversation
            .iter()
            .find(|entry| entry.kind == "assistant_message")
            .expect("assistant message");
        assert_eq!(assistant.text, "parsed::hello");

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn resize_live_terminal_uses_direct_runtime_resize_channel() {
        let root = std::env::temp_dir().join(format!(
            "conductor-direct-terminal-resize-test-{}",
            Uuid::new_v4()
        ));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let mut session = SessionRecord::new(
            "direct-terminal-resize".to_string(),
            "demo".to_string(),
            Some("session/direct-terminal-resize".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        state.replace_session(session).await.unwrap();

        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(8);
        tokio::spawn(async move { while input_rx.recv().await.is_some() {} });
        let (resize_tx, mut resize_rx) = mpsc::channel::<PtyDimensions>(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        state
            .attach_terminal_runtime("direct-terminal-resize", input_tx, Some(resize_tx), kill_tx)
            .await;

        state
            .resize_live_terminal("direct-terminal-resize", 132, 40)
            .await
            .unwrap();

        let dimensions = timeout(Duration::from_secs(3), resize_rx.recv())
            .await
            .expect("resize should reach direct runtime channel")
            .expect("resize channel should stay open");
        assert_eq!(
            dimensions,
            PtyDimensions {
                cols: 132,
                rows: 40
            }
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn start_output_consumer_sanitizes_unstructured_output_before_parsing() {
        let root = std::env::temp_dir().join(format!(
            "conductor-unstructured-output-test-{}",
            Uuid::new_v4()
        ));
        let repo = root.join("repo");
        seed_git_repo(&repo);

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        let mut session = SessionRecord::new(
            "unstructured-output".to_string(),
            "demo".to_string(),
            Some("session/unstructured-output".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        state.replace_session(session).await.unwrap();

        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8);
        state.start_output_consumer(
            "unstructured-output".to_string(),
            Arc::new(PrefixingExecutor),
            output_rx,
            OutputConsumerConfig {
                terminal_rx: None,
                mirror_terminal_output: false,
                output_is_parsed: false,
                timeout: None,
            },
        );
        output_tx
            .send(ExecutorOutput::Stdout(
                "\u{001b}[90mhello\u{001b}[0m".to_string(),
            ))
            .await
            .unwrap();
        drop(output_tx);

        let updated = timeout(Duration::from_secs(3), async {
            loop {
                let current = state.get_session("unstructured-output").await.unwrap();
                if current
                    .conversation
                    .iter()
                    .any(|entry| entry.kind == "assistant_message")
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("consumer should append assistant output");

        let assistant = updated
            .conversation
            .iter()
            .find(|entry| entry.kind == "assistant_message")
            .expect("assistant message");
        assert_eq!(assistant.text, "parsed::hello");

        let _ = fs::remove_dir_all(&root);
    }
}
