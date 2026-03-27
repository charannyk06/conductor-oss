use anyhow::Result;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use conductor_executors::executor::ExecutorInput;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{resolve_board_file, AppState, ConversationEntry, SessionRecord, SessionStatus};

const ACP_SESSION_KIND: &str = "project_dispatcher";
const ACP_MEMORY_VERSION: u8 = 1;
const ACP_HEARTBEAT_INTERVAL: ChronoDuration = ChronoDuration::minutes(15);
const ACP_SHORT_TERM_LIMIT: usize = 8;
const ACP_LONG_TERM_LIMIT: usize = 24;
const ACP_RECENT_BOARD_ACTIVITY_LIMIT: usize = 8;
const ACP_MAX_NOTE_CHARS: usize = 320;
const ACP_WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AcpMemoryNote {
    pub timestamp: String,
    pub label: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AcpProjectMemoryState {
    pub version: u8,
    pub project_id: String,
    pub repo_path: String,
    pub board_path: String,
    pub default_branch: String,
    pub implementation_agents: Vec<String>,
    #[serde(default)]
    pub durable_notes: Vec<AcpMemoryNote>,
    #[serde(default)]
    pub recent_task_refs: Vec<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AcpSessionMemoryState {
    pub version: u8,
    pub session_id: String,
    pub project_id: String,
    pub heartbeat_state: String,
    pub last_heartbeat_at: String,
    pub next_heartbeat_at: String,
    #[serde(default)]
    pub active_skills: Vec<String>,
    #[serde(default)]
    pub recent_conversation: Vec<AcpMemoryNote>,
    #[serde(default)]
    pub recent_board_activity: Vec<String>,
    pub long_term_memory_path: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AcpDispatcherArtifacts {
    pub project_memory_display: String,
    pub session_memory_display: String,
    pub board_display: String,
}

fn is_acp_dispatcher_session(session: &SessionRecord) -> bool {
    session.metadata.get("sessionKind").map(String::as_str) == Some(ACP_SESSION_KIND)
}

fn display_path(workspace_root: &Path, path: &Path) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn clip_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let clipped = trimmed.chars().take(max_chars.saturating_sub(3)).collect::<String>();
    format!("{clipped}...")
}

fn parse_timestamp(value: Option<&String>) -> Option<DateTime<Utc>> {
    value
        .map(String::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn heartbeat_times(session: &SessionRecord) -> (DateTime<Utc>, DateTime<Utc>, String) {
    let now = Utc::now();
    let last = parse_timestamp(session.metadata.get("acpLastHeartbeatAt"))
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(&session.last_activity_at)
                .ok()
                .map(|parsed| parsed.with_timezone(&Utc))
        })
        .unwrap_or(now);
    let next = parse_timestamp(session.metadata.get("acpNextHeartbeatAt"))
        .unwrap_or_else(|| last + ACP_HEARTBEAT_INTERVAL);
    let state = session
        .metadata
        .get("acpHeartbeatState")
        .cloned()
        .unwrap_or_else(|| {
            if now >= next {
                "due".to_string()
            } else {
                "active".to_string()
            }
        });
    (last, next, state)
}

fn conversation_note(entry: &ConversationEntry) -> Option<AcpMemoryNote> {
    let label = match entry.kind.as_str() {
        "user_message" => "User",
        "assistant_message" => "Assistant",
        "system_message" if entry.source == "acp_heartbeat" => "Heartbeat",
        _ => return None,
    };
    let text = clip_text(&entry.text, ACP_MAX_NOTE_CHARS);
    if text.is_empty() {
        return None;
    }
    Some(AcpMemoryNote {
        timestamp: entry.created_at.clone(),
        label: label.to_string(),
        text,
        attachments: entry.attachments.clone(),
    })
}

fn extract_task_refs(value: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut current = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            current.push(ch);
            continue;
        }
        if is_task_ref_candidate(&current) {
            refs.push(current.clone());
        }
        current.clear();
    }
    if is_task_ref_candidate(&current) {
        refs.push(current);
    }
    refs
}

fn is_task_ref_candidate(value: &str) -> bool {
    let Some((prefix, suffix)) = value.split_once('-') else {
        return false;
    };
    !prefix.is_empty()
        && prefix.chars().all(|ch| ch.is_ascii_uppercase())
        && !suffix.is_empty()
        && suffix.chars().all(|ch| ch.is_ascii_digit())
}

fn should_promote_to_long_term_memory(message: &str) -> bool {
    let trimmed = message.trim();
    if trimmed.len() < 40 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();

    if lower.starts_with("remember:")
        || lower.starts_with("directive:")
        || lower.starts_with("note:")
        || lower.starts_with("persist:")
        || lower.starts_with("remember that ")
    {
        return true;
    }

    // Require both length and durable-policy vocabulary to avoid noisy promotions.
    if trimmed.chars().count() < 120 {
        return false;
    }

    const NEEDLES: &[&str] = &[
        "always ",
        "never ",
        "must ",
        "should not",
        " do not ",
        "prefer ",
        "default to",
        "architecture",
        "constraint",
        "non-negotiable",
        "phase ",
        "milestone",
        "heartbeat",
    ];
    NEEDLES.iter().any(|n| lower.contains(n))
}

fn render_project_memory_markdown(memory: &AcpProjectMemoryState) -> String {
    let mut lines = vec![
        "# ACP Project Memory".to_string(),
        String::new(),
        "## Project Facts".to_string(),
        format!("- Project: {}", memory.project_id),
        format!("- Repo path: {}", memory.repo_path),
        format!("- Board path: {}", memory.board_path),
        format!("- Default branch: {}", memory.default_branch),
        format!(
            "- Implementation agents: {}",
            memory.implementation_agents.join(", ")
        ),
        String::new(),
        "## Durable Guidance".to_string(),
    ];
    if memory.durable_notes.is_empty() {
        lines.push("- No durable guidance captured yet.".to_string());
    } else {
        for note in &memory.durable_notes {
            lines.push(format!("- [{}] {}: {}", note.timestamp, note.label, note.text));
        }
    }
    lines.push(String::new());
    lines.push("## Recent Task References".to_string());
    if memory.recent_task_refs.is_empty() {
        lines.push("- None captured yet.".to_string());
    } else {
        for task_ref in &memory.recent_task_refs {
            lines.push(format!("- {task_ref}"));
        }
    }
    lines.push(String::new());
    lines.push(format!("Updated: {}", memory.updated_at));
    lines.join("\n")
}

fn render_session_memory_markdown(memory: &AcpSessionMemoryState) -> String {
    let mut lines = vec![
        "# ACP Session State".to_string(),
        String::new(),
        "## Heartbeat".to_string(),
        format!("- State: {}", memory.heartbeat_state),
        format!("- Last heartbeat: {}", memory.last_heartbeat_at),
        format!("- Next heartbeat due: {}", memory.next_heartbeat_at),
        String::new(),
        "## Active Skills".to_string(),
    ];
    if memory.active_skills.is_empty() {
        lines.push("- No active skills registered for this session.".to_string());
    } else {
        for skill in &memory.active_skills {
            lines.push(format!("- {skill}"));
        }
    }
    lines.push(String::new());
    lines.push("## Short-Term Memory".to_string());
    if memory.recent_conversation.is_empty() {
        lines.push("- No recent conversation context captured yet.".to_string());
    } else {
        for note in &memory.recent_conversation {
            lines.push(format!("- [{}] {}: {}", note.timestamp, note.label, note.text));
        }
    }
    lines.push(String::new());
    lines.push("## Recent Board Activity".to_string());
    if memory.recent_board_activity.is_empty() {
        lines.push("- No recent board activity recorded yet.".to_string());
    } else {
        for item in &memory.recent_board_activity {
            lines.push(format!("- {item}"));
        }
    }
    lines.push(String::new());
    lines.push("## Long-Term Memory".to_string());
    lines.push(format!("- {}", memory.long_term_memory_path));
    lines.push(String::new());
    lines.push(format!("Updated: {}", memory.updated_at));
    lines.join("\n")
}

async fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, serde_json::to_string_pretty(value)?).await?;
    Ok(())
}

async fn write_text(path: &Path, content: String) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, content).await?;
    Ok(())
}

async fn read_json<T>(path: &Path) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    let content = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<T>(&content).ok()
}

impl AppState {
    pub(crate) fn acp_root_dir(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("acp")
    }

    fn acp_project_dir(&self, project_id: &str) -> PathBuf {
        self.acp_root_dir().join(project_id)
    }

    fn acp_project_memory_json_path(&self, project_id: &str) -> PathBuf {
        self.acp_project_dir(project_id).join("project-memory.json")
    }

    fn acp_project_memory_markdown_path(&self, project_id: &str) -> PathBuf {
        self.acp_project_dir(project_id).join("project-memory.md")
    }

    fn acp_session_memory_json_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.acp_project_dir(project_id).join(format!("{session_id}-session.json"))
    }

    fn acp_session_memory_markdown_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.acp_project_dir(project_id).join(format!("{session_id}-session.md"))
    }

    pub(crate) async fn ensure_acp_dispatcher_artifacts(
        &self,
        project_id: &str,
        session_id: &str,
        default_branch: &str,
    ) -> Result<AcpDispatcherArtifacts> {
        let config = self.config.read().await.clone();
        let Some(project) = config.projects.get(project_id) else {
            return Err(anyhow::anyhow!("Unknown project: {project_id}"));
        };
        let repo_path = self.resolve_project_path(project);
        let board_dir = project
            .board_dir
            .clone()
            .unwrap_or_else(|| project_id.to_string());
        let board_relative =
            resolve_board_file(&self.workspace_path, &board_dir, Some(&project.path));
        let board_path = self.workspace_path.join(board_relative);
        let repo_display = display_path(&self.workspace_path, &repo_path);
        let board_display = display_path(&self.workspace_path, &board_path);

        let project_json = self.acp_project_memory_json_path(project_id);
        let project_md = self.acp_project_memory_markdown_path(project_id);
        let session_json = self.acp_session_memory_json_path(project_id, session_id);
        let session_md = self.acp_session_memory_markdown_path(project_id, session_id);
        let project_memory_display = display_path(&self.workspace_path, &project_md);
        let session_memory_display = display_path(&self.workspace_path, &session_md);

        let now = Utc::now().to_rfc3339();
        let mut project_memory = read_json::<AcpProjectMemoryState>(&project_json)
            .await
            .unwrap_or(AcpProjectMemoryState {
                version: ACP_MEMORY_VERSION,
                project_id: project_id.to_string(),
                repo_path: repo_display,
                board_path: board_display.clone(),
                default_branch: default_branch.to_string(),
                implementation_agents: vec![
                    "codex".to_string(),
                    "claude-code".to_string(),
                    "gemini".to_string(),
                ],
                durable_notes: Vec::new(),
                recent_task_refs: Vec::new(),
                updated_at: now.clone(),
            });
        project_memory.repo_path = display_path(&self.workspace_path, &repo_path);
        project_memory.board_path = board_display.clone();
        project_memory.default_branch = default_branch.to_string();
        project_memory.updated_at = now.clone();
        write_json(&project_json, &project_memory).await?;
        write_text(&project_md, render_project_memory_markdown(&project_memory)).await?;

        let session_memory = AcpSessionMemoryState {
            version: ACP_MEMORY_VERSION,
            session_id: session_id.to_string(),
            project_id: project_id.to_string(),
            heartbeat_state: "active".to_string(),
            last_heartbeat_at: now.clone(),
            next_heartbeat_at: (Utc::now() + ACP_HEARTBEAT_INTERVAL).to_rfc3339(),
            active_skills: self
                .active_session_skills
                .lock()
                .await
                .get(session_id)
                .cloned()
                .unwrap_or_default(),
            recent_conversation: Vec::new(),
            recent_board_activity: self
                .recent_board_activity(project_id)
                .await
                .into_iter()
                .take(ACP_RECENT_BOARD_ACTIVITY_LIMIT)
                .map(|item| format!("[{}] {} {}: {}", item.timestamp, item.source, item.action, item.detail))
                .collect(),
            long_term_memory_path: project_memory_display.clone(),
            updated_at: now,
        };
        write_json(&session_json, &session_memory).await?;
        write_text(&session_md, render_session_memory_markdown(&session_memory)).await?;

        Ok(AcpDispatcherArtifacts {
            project_memory_display,
            session_memory_display,
            board_display,
        })
    }

    pub(crate) async fn sync_acp_dispatcher_state(&self, session: &SessionRecord) -> Result<()> {
        if !is_acp_dispatcher_session(session) {
            return Ok(());
        }

        let project_json = self.acp_project_memory_json_path(&session.project_id);
        let project_md = self.acp_project_memory_markdown_path(&session.project_id);
        let session_json = self.acp_session_memory_json_path(&session.project_id, &session.id);
        let session_md = self.acp_session_memory_markdown_path(&session.project_id, &session.id);
        let long_term_memory_path = display_path(&self.workspace_path, &project_md);
        let recent_conversation = session
            .conversation
            .iter()
            .rev()
            .filter_map(conversation_note)
            .take(ACP_SHORT_TERM_LIMIT)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        let recent_board_activity = self
            .recent_board_activity(&session.project_id)
            .await
            .into_iter()
            .take(ACP_RECENT_BOARD_ACTIVITY_LIMIT)
            .map(|item| format!("[{}] {} {}: {}", item.timestamp, item.source, item.action, item.detail))
            .collect::<Vec<_>>();
        let (last_heartbeat_at, next_heartbeat_at, heartbeat_state) = heartbeat_times(session);
        let active_skills = self
            .active_session_skills
            .lock()
            .await
            .get(&session.id)
            .cloned()
            .unwrap_or_default();

        let session_memory = AcpSessionMemoryState {
            version: ACP_MEMORY_VERSION,
            session_id: session.id.clone(),
            project_id: session.project_id.clone(),
            heartbeat_state,
            last_heartbeat_at: last_heartbeat_at.to_rfc3339(),
            next_heartbeat_at: next_heartbeat_at.to_rfc3339(),
            active_skills,
            recent_conversation,
            recent_board_activity,
            long_term_memory_path,
            updated_at: Utc::now().to_rfc3339(),
        };
        write_json(&session_json, &session_memory).await?;
        write_text(&session_md, render_session_memory_markdown(&session_memory)).await?;

        if let Some(project_memory) = read_json::<AcpProjectMemoryState>(&project_json).await {
            write_text(&project_md, render_project_memory_markdown(&project_memory)).await?;
        }

        Ok(())
    }

    pub(crate) async fn record_acp_dispatcher_turn(
        &self,
        session: &SessionRecord,
        message: &str,
        attachments: &[String],
    ) -> Result<()> {
        if !is_acp_dispatcher_session(session) {
            return Ok(());
        }

        let project_json = self.acp_project_memory_json_path(&session.project_id);
        let mut project_memory = read_json::<AcpProjectMemoryState>(&project_json)
            .await
            .unwrap_or(AcpProjectMemoryState {
                version: ACP_MEMORY_VERSION,
                project_id: session.project_id.clone(),
                repo_path: session
                    .metadata
                    .get("agentCwd")
                    .cloned()
                    .unwrap_or_else(|| session.project_id.clone()),
                board_path: session
                    .metadata
                    .get("acpBoardPath")
                    .cloned()
                    .unwrap_or_default(),
                default_branch: session.branch.clone().unwrap_or_else(|| "main".to_string()),
                implementation_agents: vec![
                    "codex".to_string(),
                    "claude-code".to_string(),
                    "gemini".to_string(),
                ],
                durable_notes: Vec::new(),
                recent_task_refs: Vec::new(),
                updated_at: Utc::now().to_rfc3339(),
            });

        let trimmed = clip_text(message, ACP_MAX_NOTE_CHARS);
        if !trimmed.is_empty() && should_promote_to_long_term_memory(message) {
            project_memory.durable_notes.push(AcpMemoryNote {
                timestamp: Utc::now().to_rfc3339(),
                label: "Directive".to_string(),
                text: trimmed,
                attachments: attachments.to_vec(),
            });
            if project_memory.durable_notes.len() > ACP_LONG_TERM_LIMIT {
                let drain = project_memory
                    .durable_notes
                    .len()
                    .saturating_sub(ACP_LONG_TERM_LIMIT);
                project_memory.durable_notes.drain(0..drain);
            }
        }

        let mut seen = project_memory
            .recent_task_refs
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        for task_ref in extract_task_refs(message) {
            if seen.insert(task_ref.clone()) {
                project_memory.recent_task_refs.push(task_ref);
            }
        }
        if project_memory.recent_task_refs.len() > ACP_LONG_TERM_LIMIT {
            let drain = project_memory
                .recent_task_refs
                .len()
                .saturating_sub(ACP_LONG_TERM_LIMIT);
            project_memory.recent_task_refs.drain(0..drain);
        }
        project_memory.updated_at = Utc::now().to_rfc3339();

        write_json(&project_json, &project_memory).await?;
        write_text(
            &self.acp_project_memory_markdown_path(&session.project_id),
            render_project_memory_markdown(&project_memory),
        )
        .await?;

        self.sync_acp_dispatcher_state(session).await
    }

    pub(crate) async fn maintain_acp_dispatchers(&self) {
        let now = Utc::now();
        let due_sessions = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| is_acp_dispatcher_session(session))
                .filter(|session| session.status != SessionStatus::Archived)
                .filter_map(|session| {
                    let (_, next, state) = heartbeat_times(session);
                    (state != "due" && now >= next).then_some(session.id.clone())
                })
                .collect::<Vec<_>>()
        };

        for session_id in due_sessions {
            let updated = {
                let mut sessions = self.sessions.write().await;
                let Some(session) = sessions.get_mut(&session_id) else {
                    continue;
                };
                if !is_acp_dispatcher_session(session) || session.status == SessionStatus::Archived {
                    continue;
                }
                session
                    .metadata
                    .insert("acpHeartbeatState".to_string(), "due".to_string());
                session
                    .metadata
                    .insert("acpNextHeartbeatAt".to_string(), now.to_rfc3339());
                session.last_activity_at = now.to_rfc3339();
                session.summary = Some("ACP heartbeat due".to_string());
                session
                    .metadata
                    .insert("summary".to_string(), "ACP heartbeat due".to_string());
                session.conversation.push(ConversationEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    kind: "system_message".to_string(),
                    source: "acp_heartbeat".to_string(),
                    text: "ACP heartbeat due. Review board state, blockers, deferred follow-ups, and which tasks should be shaped or handed off next.".to_string(),
                    created_at: now.to_rfc3339(),
                    attachments: Vec::new(),
                    metadata: std::collections::HashMap::new(),
                });
                session.clone()
            };

            if let Err(err) = self.persist_session(&updated).await {
                tracing::warn!(session_id = %session_id, error = %err, "failed to persist ACP heartbeat");
                continue;
            }
            if let Err(err) = self.sync_acp_dispatcher_state(&updated).await {
                tracing::warn!(session_id = %session_id, error = %err, "failed to sync ACP heartbeat state");
            }
            if self.terminal_runtime_attached(&session_id).await {
                let handle = self.ensure_terminal_host(&session_id).await;
                let input_tx = handle.input_tx.read().await.clone();
                if let Some(input_tx) = input_tx {
                    if let Err(err) = input_tx
                        .send(ExecutorInput::Text(
                            "ACP heartbeat due. Review board state, blockers, deferred follow-ups, and which tasks should be shaped or handed off next.".to_string(),
                        ))
                        .await
                    {
                        tracing::warn!(session_id = %session_id, error = %err, "failed to deliver ACP heartbeat prompt");
                    }
                }
            }
            self.publish_snapshot().await;
        }
    }

    pub fn start_acp_dispatcher_watchdog(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(ACP_WATCHDOG_INTERVAL);
            loop {
                interval.tick().await;
                state.maintain_acp_dispatchers().await;
            }
        });
    }
}
