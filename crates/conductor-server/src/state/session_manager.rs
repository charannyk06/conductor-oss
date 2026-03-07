use anyhow::{Context, Result};
use chrono::Utc;
use conductor_core::types::AgentKind;
use conductor_executors::executor::{ExecutorOutput, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::AppState;
use super::helpers::{append_output, is_terminal_status};
use super::types::{ConversationEntry, LiveSessionHandle, SessionRecord, SpawnRequest};

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
            .or_else(|| Some(format!("session/{}", &session_id[..8])));
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

        self.replace_session(record.clone()).await?;
        self.live_sessions.write().await.insert(
            session_id.clone(),
            Arc::new(LiveSessionHandle {
                input_tx,
                kill_tx: Mutex::new(Some(kill_tx)),
            }),
        );

        let state = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = output_rx.recv().await {
                let mapped = match event {
                    ExecutorOutput::Stdout(line) => executor.parse_output(&line),
                    ExecutorOutput::Stderr(line) => ExecutorOutput::Stderr(line),
                    other => other,
                };
                let _ = state.apply_runtime_event(&session_id, mapped).await;
            }
        });

        Ok(record)
    }

    pub(crate) async fn apply_runtime_event(&self, session_id: &str, event: ExecutorOutput) -> Result<()> {
        let is_live = self.live_sessions.read().await.contains_key(session_id);
        let clear_live_handle = matches!(
            event,
            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
        );

        let mut sessions = self.sessions.write().await;
        let session = match sessions.get_mut(session_id) {
            Some(value) => value,
            None => return Ok(()),
        };

        session.last_activity_at = Utc::now().to_rfc3339();

        match event {
            ExecutorOutput::Stdout(line) => {
                append_output(session, &line);
                if is_live && !is_terminal_status(&session.status) {
                    session.status = "working".to_string();
                    session.activity = Some("active".to_string());
                }
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    session.summary = Some(trimmed.to_string());
                    session.metadata.insert("summary".to_string(), trimmed.to_string());
                }
            }
            ExecutorOutput::Stderr(line) => {
                append_output(session, &format!("[stderr] {line}"));
                session.metadata.insert("lastStderr".to_string(), line);
            }
            ExecutorOutput::NeedsInput(prompt) => {
                if is_live && !is_terminal_status(&session.status) {
                    session.status = "needs_input".to_string();
                    session.activity = Some("waiting_input".to_string());
                    session.summary = Some(prompt.clone());
                    session.metadata.insert("summary".to_string(), prompt.clone());
                    session.conversation.push(ConversationEntry {
                        id: Uuid::new_v4().to_string(),
                        kind: "system_message".to_string(),
                        source: "runtime".to_string(),
                        text: prompt,
                        created_at: Utc::now().to_rfc3339(),
                        attachments: Vec::new(),
                        metadata: HashMap::new(),
                    });
                }
            }
            ExecutorOutput::Completed { exit_code } => {
                session.status = if exit_code == 0 {
                    "done".to_string()
                } else {
                    "errored".to_string()
                };
                session.activity = Some("exited".to_string());
                session.metadata.insert("exitCode".to_string(), exit_code.to_string());
                if exit_code != 0 && session.summary.as_ref().map(|value| value.trim().is_empty()).unwrap_or(true) {
                    let summary = session
                        .metadata
                        .get("lastStderr")
                        .cloned()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| format!("Process exited with code {exit_code}"));
                    session.summary = Some(summary.clone());
                    session.metadata.insert("summary".to_string(), summary);
                }
            }
            ExecutorOutput::Failed { error, exit_code } => {
                session.status = if error == "killed" {
                    "killed".to_string()
                } else {
                    "errored".to_string()
                };
                session.activity = Some("exited".to_string());
                session.summary = Some(error.clone());
                session.metadata.insert("summary".to_string(), error.clone());
                if let Some(code) = exit_code {
                    session.metadata.insert("exitCode".to_string(), code.to_string());
                }
            }
        }

        let updated = session.clone();
        drop(sessions);
        if clear_live_handle {
            self.live_sessions.write().await.remove(session_id);
        }
        self.persist_session(&updated).await?;
        let _ = self
            .output_updates
            .send((updated.id.clone(), updated.output.clone()));
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
        handle.input_tx.send(effective_message).await?;

        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Session {session_id} not found"))?;
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
        self.replace_session(updated).await?;
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

    pub async fn restore_session(self: &Arc<Self>, session_id: &str) -> Result<SessionRecord> {
        let session = self
            .get_session(session_id)
            .await
            .with_context(|| format!("Session {session_id} not found"))?;
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
