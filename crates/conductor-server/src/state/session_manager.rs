use anyhow::{Context, Result};
use chrono::Utc;
use conductor_core::types::AgentKind;
use conductor_executors::executor::{ExecutorInput, ExecutorOutput, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::AppState;
use super::helpers::{append_output, is_runtime_status_line, is_terminal_status, merge_assistant_fragment, runtime_tool_metadata};
use super::types::{ConversationEntry, LiveSessionHandle, SessionRecord, SpawnRequest};

const PARSER_STATE_KEY: &str = "parserState";
const PARSER_STATE_MESSAGE_KEY: &str = "parserStateMessage";
const PARSER_STATE_COMMAND_KEY: &str = "parserStateCommand";

fn append_runtime_assistant_entry(session: &mut SessionRecord, text: &str) {
    let normalized = text.trim_end();
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
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }

    if let Some(last) = session.conversation.last() {
        if last.kind == "status_message" && last.source == "runtime" && last.text.trim() == trimmed {
            return;
        }
    }

    let mut metadata = HashMap::new();
    if let Some(tool_metadata) = runtime_tool_metadata(trimmed) {
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
        "claude login",
        "gemini auth login",
        "codex login",
        "opencode auth login",
        "qwen auth login",
    ] {
        if lower.contains(candidate) {
            return Some(candidate.to_string());
        }
    }

    match agent.trim().to_lowercase().as_str() {
        "github-copilot" => Some("gh auth login".to_string()),
        "claude-code" => Some("claude login".to_string()),
        "gemini" => Some("gemini auth login".to_string()),
        "codex" => Some("codex login".to_string()),
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
    pub async fn spawn_session(self: &Arc<Self>, request: SpawnRequest) -> Result<SessionRecord> {
        let config = self.config.read().await.clone();
        let project = config
            .projects
            .get(&request.project_id)
            .cloned()
            .with_context(|| format!("Unknown project: {}", request.project_id))?;

        let project_agent = request
            .agent
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

        let session_id = Uuid::new_v4().to_string();
        let branch = request
            .branch
            .clone()
            .or_else(|| Some(format!("session/{}", session_id.get(..8).unwrap_or(&session_id))));
        let workspace_path = self
            .prepare_workspace(
                &request.project_id,
                &project,
                request.use_worktree.unwrap_or(true),
                branch.as_deref(),
                request.base_branch.as_deref(),
            )
            .await?;

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

        let skip_permissions = match request.permission_mode.as_deref().map(str::trim) {
            Some("auto") => true,
            Some("ask") | Some("plan") => false,
            _ => matches!(project.agent_config.permissions.as_deref(), Some("skip")),
        };

        let handle = executor
            .spawn(SpawnOptions {
                cwd: workspace_path.clone(),
                prompt: prompt.clone(),
                model: request.model.clone(),
                skip_permissions,
                extra_args: Vec::new(),
                env: HashMap::new(),
                branch: branch.clone(),
            })
            .await?;

        let (pid, _kind, mut output_rx, input_tx, kill_tx) = handle.into_parts();

        let mut record = SessionRecord::new(
            session_id.clone(),
            request.project_id.clone(),
            branch.clone(),
            request.issue_id.clone(),
            Some(workspace_path.to_string_lossy().to_string()),
            project_agent.clone(),
            request.model.clone(),
            request.reasoning_effort.clone(),
            request.prompt.clone(),
            Some(pid),
        );

        record.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "user_message".to_string(),
            source: request.source,
            text: request.prompt.clone(),
            created_at: Utc::now().to_rfc3339(),
            attachments: request.attachments.clone(),
            metadata: HashMap::new(),
        });

        let mut kill_tx = Some(kill_tx);
        if let Err(err) = self.replace_session(record.clone()).await {
            // Kill the already-spawned process before returning the error.
            if let Some(tx) = kill_tx.take() {
                let _ = tx.send(());
            }
            return Err(err.context("Failed to persist session after spawn"));
        }
        self.live_sessions.write().await.insert(
            session_id.clone(),
            Arc::new(LiveSessionHandle {
                input_tx,
                kill_tx: Mutex::new(kill_tx.take()),
            }),
        );

        let state = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = output_rx.recv().await {
                match event {
                    ExecutorOutput::Stdout(line) => {
                        let mapped = executor.parse_output(&line);
                        let _ = state.append_and_apply(&session_id, &line, mapped).await;
                    }
                    ExecutorOutput::Stderr(line) => {
                        let prefixed = format!("[stderr] {line}");
                        let _ = state.append_and_apply(&session_id, &prefixed, ExecutorOutput::Stderr(line)).await;
                    }
                    other => {
                        let _ = state.apply_runtime_event(&session_id, other).await;
                    }
                }
            }
        });

        Ok(record)
    }

    /// Combined append + apply to avoid acquiring the sessions write lock twice per line.
    pub(crate) async fn append_and_apply(&self, session_id: &str, line: &str, event: ExecutorOutput) -> Result<()> {
        let clear_live_handle = matches!(
            event,
            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
        );

        let mut sessions = self.sessions.write().await;
        let is_live = self.live_sessions.read().await.contains_key(session_id);
        let session = match sessions.get_mut(session_id) {
            Some(value) => value,
            None => return Ok(()),
        };

        if session.status == "archived" {
            drop(sessions);
            if clear_live_handle {
                self.live_sessions.write().await.remove(session_id);
            }
            return Ok(());
        }

        // Append output (inline)
        append_output(session, line);
        session.last_activity_at = Utc::now().to_rfc3339();

        // Apply event (inline from apply_runtime_event logic)
        match event {
            ExecutorOutput::Stdout(ref stdout_line) => {
                if is_live && !is_terminal_status(&session.status) {
                    session.status = "working".to_string();
                    session.activity = Some("active".to_string());
                }
                let trimmed = stdout_line.trim();
                if trimmed.is_empty() {
                    append_runtime_assistant_break(session);
                } else {
                    if detect_parser_state(session, trimmed) || is_runtime_status_line(trimmed) {
                        append_runtime_status_entry(session, trimmed);
                    } else {
                        clear_parser_state(session);
                        append_runtime_assistant_entry(session, stdout_line.trim_end());
                    }
                    session.summary = Some(trimmed.to_string());
                    session.metadata.insert("summary".to_string(), trimmed.to_string());
                }
            }
            ExecutorOutput::Stderr(ref stderr_line) => {
                if detect_parser_state(session, stderr_line) {
                    append_runtime_status_entry(session, stderr_line);
                    session.summary = Some(stderr_line.trim().to_string());
                    session.metadata.insert("summary".to_string(), stderr_line.trim().to_string());
                }
                session.metadata.insert("lastStderr".to_string(), stderr_line.clone());
            }
            _ => {}
        }

        let updated = session.clone();
        drop(sessions);
        if clear_live_handle {
            self.live_sessions.write().await.remove(session_id);
        }
        self.persist_session(&updated).await?;
        let _ = self
            .output_updates
            .send((updated.id.clone(), line.to_string()));
        self.publish_snapshot().await;
        Ok(())
    }

    pub(crate) async fn apply_runtime_event(&self, session_id: &str, event: ExecutorOutput) -> Result<()> {
        let clear_live_handle = matches!(
            event,
            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
        );

        let mut sessions = self.sessions.write().await;
        let is_live = self.live_sessions.read().await.contains_key(session_id);
        let session = match sessions.get_mut(session_id) {
            Some(value) => value,
            None => return Ok(()),
        };

        if session.status == "archived" {
            drop(sessions);
            if clear_live_handle {
                self.live_sessions.write().await.remove(session_id);
            }
            return Ok(());
        }

        session.last_activity_at = Utc::now().to_rfc3339();

        match event {
            ExecutorOutput::Stdout(line) => {
                if is_live && !is_terminal_status(&session.status) {
                    session.status = "working".to_string();
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
                    session.metadata.insert("summary".to_string(), trimmed.to_string());
                }
            }
            ExecutorOutput::Stderr(line) => {
                if detect_parser_state(session, &line) {
                    append_runtime_status_entry(session, &line);
                    session.summary = Some(line.trim().to_string());
                    session.metadata.insert("summary".to_string(), line.trim().to_string());
                }
                session.metadata.insert("lastStderr".to_string(), line);
            }
            ExecutorOutput::NeedsInput(prompt) => {
                if is_live && !is_terminal_status(&session.status) {
                    session.status = "needs_input".to_string();
                    session.activity = Some("waiting_input".to_string());
                    session.summary = Some(prompt.clone());
                    session.metadata.insert("summary".to_string(), prompt.clone());
                    append_runtime_status_entry(session, &prompt);
                    if !detect_parser_state(session, &prompt) {
                        set_parser_state(session, "needs_input", &prompt, None);
                    }
                }
            }
            ExecutorOutput::Completed { exit_code } => {
                if exit_code == 0 {
                    clear_parser_state(session);
                }
                session.metadata.insert("exitCode".to_string(), exit_code.to_string());
                if exit_code == 0 {
                    session.status = "needs_input".to_string();
                    session.activity = Some("waiting_input".to_string());
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
                    session.status = "errored".to_string();
                    session.activity = Some("exited".to_string());
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
                }
            }
            ExecutorOutput::Failed { error, exit_code } => {
                let parser_state_detected = detect_parser_state(session, &error);
                let summary = if error == "killed" {
                    "Interrupted".to_string()
                } else {
                    error.clone()
                };
                session.status = if error == "killed" {
                    "killed".to_string()
                } else {
                    "errored".to_string()
                };
                session.activity = Some("exited".to_string());
                session.summary = Some(summary.clone());
                session.metadata.insert("summary".to_string(), summary);
                if let Some(code) = exit_code {
                    session.metadata.insert("exitCode".to_string(), code.to_string());
                }
                if !parser_state_detected && error == "killed" {
                    clear_parser_state(session);
                }
            }
        }

        let updated = session.clone();
        drop(sessions);
        if clear_live_handle {
            self.live_sessions.write().await.remove(session_id);
        }
        self.persist_session(&updated).await?;
        self.publish_snapshot().await;
        Ok(())
    }

    pub async fn send_to_session(
        &self,
        session_id: &str,
        message: String,
        attachments: Vec<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        source: &str,
    ) -> Result<()> {
        let handle = self
            .live_sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .with_context(|| format!("Session {session_id} is not running"))?;

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
        session.status = "working".to_string();
        session.activity = Some("active".to_string());
        if let Some(model_value) = model {
            session.model = Some(model_value.clone());
            session.metadata.insert("model".to_string(), model_value);
        }
        if let Some(reasoning) = reasoning_effort {
            session.reasoning_effort = Some(reasoning.clone());
            session.metadata.insert("reasoningEffort".to_string(), reasoning);
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
        let updated = session.clone();
        drop(sessions);
        self.persist_session(&updated).await?;
        self.publish_snapshot().await;
        handle.input_tx.send(ExecutorInput::Text(effective_message)).await?;
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
        let session_snapshot = self
            .get_session(session_id)
            .await
            .with_context(|| format!("Session {session_id} not found"))?;

        let workspace_path = session_snapshot
            .workspace_path
            .clone()
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

        let effective_model = model.or_else(|| session_snapshot.model.clone());
        let effective_reasoning_effort = reasoning_effort.or_else(|| session_snapshot.reasoning_effort.clone());
        let skip_permissions = matches!(project.agent_config.permissions.as_deref(), Some("skip"));

        let handle = executor
            .spawn(SpawnOptions {
                cwd: std::path::PathBuf::from(&workspace_path),
                prompt: effective_message.clone(),
                model: effective_model.clone(),
                skip_permissions,
                extra_args: Vec::new(),
                env: HashMap::new(),
                branch: session_snapshot.branch.clone(),
            })
            .await?;

        let (pid, _kind, mut output_rx, input_tx, kill_tx) = handle.into_parts();

        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Session {session_id} not found"))?;
        if session.status == "archived" {
            return Err(anyhow::anyhow!("Session {session_id} is archived"));
        }

        clear_parser_state(session);
        session.status = "working".to_string();
        session.activity = Some("active".to_string());
        session.last_activity_at = Utc::now().to_rfc3339();
        session.pid = Some(pid);
        session.model = effective_model.clone();
        session.reasoning_effort = effective_reasoning_effort.clone();
        session.summary = Some(message.trim().to_string());
        session.metadata.insert("summary".to_string(), message.trim().to_string());
        session.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "user_message".to_string(),
            source: source.to_string(),
            text: message,
            created_at: Utc::now().to_rfc3339(),
            attachments: attachments.clone(),
            metadata: HashMap::new(),
        });

        let updated = session.clone();
        drop(sessions);

        self.replace_session(updated).await?;
        self.live_sessions.write().await.insert(
            session_id.to_string(),
            Arc::new(LiveSessionHandle {
                input_tx,
                kill_tx: Mutex::new(Some(kill_tx)),
            }),
        );

        let state = Arc::clone(self);
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            while let Some(event) = output_rx.recv().await {
                match event {
                    ExecutorOutput::Stdout(line) => {
                        let mapped = executor.parse_output(&line);
                        let _ = state.append_and_apply(&session_id, &line, mapped).await;
                    }
                    ExecutorOutput::Stderr(line) => {
                        let prefixed = format!("[stderr] {line}");
                        let _ = state.append_and_apply(&session_id, &prefixed, ExecutorOutput::Stderr(line)).await;
                    }
                    other => {
                        let _ = state.apply_runtime_event(&session_id, other).await;
                    }
                }
            }
        });

        Ok(())
    }

    pub async fn send_raw_to_session(&self, session_id: &str, keys: String) -> Result<()> {
        let handle = self
            .live_sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .with_context(|| format!("Session {session_id} is not running"))?;

        handle.input_tx.send(ExecutorInput::Raw(keys)).await?;

        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            clear_parser_state(session);
            session.last_activity_at = Utc::now().to_rfc3339();
            if !is_terminal_status(&session.status) {
                session.status = "working".to_string();
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

    pub async fn kill_session(&self, session_id: &str) -> Result<()> {
        if let Some(handle) = self.live_sessions.write().await.remove(session_id) {
            if let Some(kill_tx) = handle.kill_tx.lock().await.take() {
                let _ = kill_tx.send(());
            }
        }
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.status = "killed".to_string();
            session.activity = Some("exited".to_string());
            session.last_activity_at = Utc::now().to_rfc3339();
            session.summary = Some("Interrupted".to_string());
            session.metadata.insert("summary".to_string(), "Interrupted".to_string());
            let updated = session.clone();
            drop(sessions);
            self.replace_session(updated).await?;
        }
        Ok(())
    }

    pub async fn archive_session(&self, session_id: &str) -> Result<()> {
        if let Some(handle) = self.live_sessions.write().await.remove(session_id) {
            if let Some(kill_tx) = handle.kill_tx.lock().await.take() {
                let _ = kill_tx.send(());
            }
        }

        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Session {session_id} not found"))?;
        if session.status == "archived" {
            return Ok(());
        }

        session.status = "archived".to_string();
        session.activity = Some("exited".to_string());
        session.last_activity_at = Utc::now().to_rfc3339();
        session.summary = Some("Archived".to_string());
        session.metadata.insert("summary".to_string(), "Archived".to_string());
        session
            .metadata
            .insert("archivedAt".to_string(), session.last_activity_at.clone());

        let updated = session.clone();
        drop(sessions);
        self.replace_session(updated).await?;
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
                if original.status != "archived" {
                    original.status = "restored".to_string();
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
            attachments: Vec::new(),
            source: "restore".to_string(),
        })
        .await
    }
}
