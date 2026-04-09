use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use conductor_core::config::ProjectConfig;
use conductor_core::types::AgentKind;
use conductor_executors::agents::build_runtime_env;
use conductor_executors::executor::{ExecutorInput, ExecutorOutput, SpawnOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

use super::helpers::{
    apply_openclaw_runtime_env, is_runtime_status_line, merge_assistant_fragment,
    resolve_board_file, runtime_tool_metadata, sanitize_terminal_text,
};
use super::workspace::{is_process_alive, terminate_process};
use super::{
    deserialize_mcp_servers, AppState, ConversationEntry, SessionRecord, SessionStatus,
    ACP_SESSION_MCP_SERVERS_METADATA_KEY,
};
use crate::acp_prompt::{
    acp_dispatcher_preference_note, acp_dispatcher_turn_allows_board_mutations,
    acp_dispatcher_turn_prefix, rewrite_acp_dispatcher_command,
};
use crate::dispatcher_task_lifecycle::DispatcherTaskOperation;
use crate::routes::boards::{default_heading_for_role, split_task_text, BoardTaskRecord};
use crate::task_context::{attachment_allowed_roots, attachment_context_sections};
use conductor_core::types::DEFAULT_SESSION_HISTORY_LIMIT;

const ACP_SESSION_KIND: &str = "project_dispatcher";
const ACP_MODE_DISPATCHER: &str = "dispatcher";
const ACP_MEMORY_VERSION: u8 = 1;
const ACP_HEARTBEAT_INTERVAL: ChronoDuration = ChronoDuration::minutes(15);
const ACP_SESSION_MEMORY_SYNC_INTERVAL: ChronoDuration = ChronoDuration::seconds(5);
const ACP_SHORT_TERM_LIMIT: usize = 8;
const ACP_LONG_TERM_LIMIT: usize = 24;
const ACP_RECENT_BOARD_ACTIVITY_LIMIT: usize = 8;
const ACP_MAX_NOTE_CHARS: usize = 320;
const ACP_WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
const ACP_APPROVAL_STATE_METADATA_KEY: &str = "acpPlanApprovalState";
const ACP_APPROVAL_REQUIRED: &str = "approval_required";
const ACP_APPROVAL_GRANTED: &str = "approved_for_next_mutation";
pub(crate) const ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY: &str = "acpSessionMemorySyncedAt";
pub(crate) const ACP_ACTIVE_SKILLS_METADATA_KEY: &str = "acpActiveSkills";
pub(crate) const ACP_IMPLEMENTATION_AGENT_METADATA_KEY: &str = "acpImplementationAgent";
pub(crate) const ACP_IMPLEMENTATION_MODEL_METADATA_KEY: &str = "acpImplementationModel";
pub(crate) const ACP_IMPLEMENTATION_REASONING_METADATA_KEY: &str =
    "acpImplementationReasoningEffort";
const ACP_RESUME_TARGET_METADATA_KEY: &str = "acpResumeTarget";
const PARSER_STATE_KEY: &str = "parserState";
const PARSER_STATE_MESSAGE_KEY: &str = "parserStateMessage";
const PARSER_STATE_COMMAND_KEY: &str = "parserStateCommand";
const OPENCLAW_GATEWAY_URL_METADATA_KEY: &str = "openclawGatewayUrl";
const OPENCLAW_GATEWAY_TOKEN_METADATA_KEY: &str = "openclawGatewayToken";
const OPENCLAW_GATEWAY_TOKEN_CONFIGURED_METADATA_KEY: &str = "openclawGatewayTokenConfigured";
const OPENCLAW_GATEWAY_SCOPES_METADATA_KEY: &str = "openclawGatewayScopes";
const OPENCLAW_SESSION_KEY_METADATA_KEY: &str = "openclawSessionKey";

fn apply_openclaw_binding_field(
    thread: &mut SessionRecord,
    key: &str,
    value: Option<Option<String>>,
) {
    match value {
        None => {}
        Some(None) => {
            thread.metadata.remove(key);
        }
        Some(Some(s)) => {
            if s.trim().is_empty() {
                thread.metadata.remove(key);
            } else {
                thread
                    .metadata
                    .insert(key.to_string(), s.trim().to_string());
            }
        }
    }
}

fn apply_openclaw_text_field(thread: &mut SessionRecord, key: &str, value: Option<String>) -> bool {
    let next_value = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let current_value = thread
        .metadata
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if current_value == next_value {
        return false;
    }

    match next_value {
        Some(value) => {
            thread.metadata.insert(key.to_string(), value);
        }
        None => {
            thread.metadata.remove(key);
        }
    }
    true
}

fn apply_openclaw_secret_field(
    thread: &mut SessionRecord,
    value_key: &str,
    configured_key: &str,
    value: Option<String>,
) -> bool {
    let Some(next_raw) = value else {
        return false;
    };
    let next_value = next_raw
        .trim()
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let trimmed = next_raw.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
    let current_value = thread
        .metadata
        .get(value_key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    if current_value == next_value {
        return false;
    }

    match next_value {
        Some(value) => {
            thread.metadata.insert(value_key.to_string(), value);
            thread
                .metadata
                .insert(configured_key.to_string(), "true".to_string());
        }
        None => {
            thread.metadata.remove(value_key);
            thread.metadata.remove(configured_key);
        }
    }
    true
}

#[derive(Clone, Debug, Default)]
pub(crate) struct OpenClawDispatcherConfigPatch {
    pub gateway_url: Option<String>,
    pub gateway_token: Option<String>,
    pub gateway_scopes: Option<String>,
    pub session_key: Option<String>,
}

fn apply_openclaw_dispatcher_config(
    thread: &mut SessionRecord,
    patch: &OpenClawDispatcherConfigPatch,
) -> bool {
    let mut changed = false;
    changed |= apply_openclaw_text_field(
        thread,
        OPENCLAW_GATEWAY_URL_METADATA_KEY,
        patch.gateway_url.clone(),
    );
    changed |= apply_openclaw_secret_field(
        thread,
        OPENCLAW_GATEWAY_TOKEN_METADATA_KEY,
        OPENCLAW_GATEWAY_TOKEN_CONFIGURED_METADATA_KEY,
        patch.gateway_token.clone(),
    );
    changed |= apply_openclaw_text_field(
        thread,
        OPENCLAW_GATEWAY_SCOPES_METADATA_KEY,
        patch.gateway_scopes.clone(),
    );
    changed |= apply_openclaw_text_field(
        thread,
        OPENCLAW_SESSION_KEY_METADATA_KEY,
        patch.session_key.clone(),
    );
    changed
}

fn has_openclaw_dispatcher_config_patch(patch: &OpenClawDispatcherConfigPatch) -> bool {
    patch.gateway_url.is_some()
        || patch.gateway_token.is_some()
        || patch.gateway_scopes.is_some()
        || patch.session_key.is_some()
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DispatcherSelectOption {
    pub value: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DispatcherPreferencesPatch {
    pub dispatcher_agent: Option<String>,
    pub dispatcher_model: Option<String>,
    pub dispatcher_reasoning_effort: Option<String>,
    pub implementation_agent: Option<String>,
    pub implementation_model: Option<String>,
    pub implementation_reasoning_effort: Option<String>,
    pub openclaw_config: OpenClawDispatcherConfigPatch,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CreateDispatcherThreadOptions {
    pub bridge_id: Option<String>,
    pub dispatcher_agent: Option<String>,
    pub implementation_agent: Option<String>,
    pub openclaw_config: OpenClawDispatcherConfigPatch,
    pub dispatcher_model: Option<String>,
    pub dispatcher_reasoning_effort: Option<String>,
    pub implementation_model: Option<String>,
    pub implementation_reasoning_effort: Option<String>,
    pub force_new: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct DispatcherTurnRequest {
    pub message: String,
    pub runtime_message: Option<String>,
    pub source: String,
    pub entry_id: Option<String>,
    pub recorded_attachments: Vec<String>,
    pub runtime_attachments: Vec<String>,
    pub runtime_context: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub metadata: HashMap<String, Value>,
}

impl DispatcherTurnRequest {
    pub(crate) fn plain(
        message: String,
        attachments: Vec<String>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        source: impl Into<String>,
    ) -> Self {
        Self {
            message,
            runtime_message: None,
            source: source.into(),
            entry_id: None,
            recorded_attachments: attachments.clone(),
            runtime_attachments: attachments,
            runtime_context: None,
            model,
            reasoning_effort,
            metadata: HashMap::new(),
        }
    }
}

const DISPATCHER_IMPLEMENTATION_AGENT_OPTIONS: [DispatcherSelectOption; 4] = [
    DispatcherSelectOption {
        value: "codex",
        name: "Codex",
        description: "Route implementation work to Codex sessions.",
    },
    DispatcherSelectOption {
        value: "claude-code",
        name: "Claude Code",
        description: "Route implementation work to Claude Code sessions.",
    },
    DispatcherSelectOption {
        value: "gemini",
        name: "Gemini",
        description: "Route implementation work to Gemini sessions.",
    },
    DispatcherSelectOption {
        value: "openclaw",
        name: "OpenClaw",
        description: "Route work through an OpenClaw gateway-backed runtime.",
    },
];

const DISPATCHER_OPENCLAW_MODEL_OPTIONS: [DispatcherSelectOption; 0] = [];
const DISPATCHER_OPENCLAW_REASONING_OPTIONS: [DispatcherSelectOption; 0] = [];
const DISPATCHER_CURSOR_MODEL_OPTIONS: [DispatcherSelectOption; 0] = [];

const DISPATCHER_CODEX_MODEL_OPTIONS: [DispatcherSelectOption; 8] = [
    DispatcherSelectOption {
        value: "gpt-5.4",
        name: "GPT-5.4",
        description: "Latest frontier coding model exposed by Codex.",
    },
    DispatcherSelectOption {
        value: "gpt-5.4-mini",
        name: "GPT-5.4-Mini",
        description: "Smaller GPT-5.4 variant for faster or lower-cost tasks.",
    },
    DispatcherSelectOption {
        value: "gpt-5.3-codex",
        name: "GPT-5.3-Codex",
        description: "Balanced Codex coding model.",
    },
    DispatcherSelectOption {
        value: "gpt-5.3-codex-spark",
        name: "GPT-5.3-Codex-Spark",
        description: "Fast Codex model optimized for rapid iteration.",
    },
    DispatcherSelectOption {
        value: "gpt-5.2-codex",
        name: "GPT-5.2-Codex",
        description: "Previous generation Codex coding model.",
    },
    DispatcherSelectOption {
        value: "gpt-5.2",
        name: "GPT-5.2",
        description: "Previous frontier model for professional work.",
    },
    DispatcherSelectOption {
        value: "gpt-5.1-codex-max",
        name: "GPT-5.1-Codex-Max",
        description: "High-capability legacy Codex model.",
    },
    DispatcherSelectOption {
        value: "gpt-5.1-codex-mini",
        name: "GPT-5.1-Codex-Mini",
        description: "Smaller Codex model for quick tasks.",
    },
];

const DISPATCHER_CLAUDE_MODEL_OPTIONS: [DispatcherSelectOption; 3] = [
    DispatcherSelectOption {
        value: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Balanced Claude Code model for day-to-day coding tasks.",
    },
    DispatcherSelectOption {
        value: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Highest-capability Claude Code model for deeper reasoning.",
    },
    DispatcherSelectOption {
        value: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        description: "Fast Claude model for lightweight tasks.",
    },
];

const DISPATCHER_GEMINI_MODEL_OPTIONS: [DispatcherSelectOption; 2] = [
    DispatcherSelectOption {
        value: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        description: "High-capability Gemini model discovered in local Gemini sessions.",
    },
    DispatcherSelectOption {
        value: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        description: "Fast Gemini model discovered in local Gemini sessions.",
    },
];

const DISPATCHER_DEFAULT_REASONING_OPTIONS: [DispatcherSelectOption; 3] = [
    DispatcherSelectOption {
        value: "low",
        name: "Low",
        description: "Fast responses with lighter reasoning.",
    },
    DispatcherSelectOption {
        value: "medium",
        name: "Medium",
        description: "Balanced speed and reasoning depth for everyday tasks.",
    },
    DispatcherSelectOption {
        value: "high",
        name: "High",
        description: "Deeper reasoning for more complex tasks.",
    },
];

const DISPATCHER_CODEX_REASONING_OPTIONS: [DispatcherSelectOption; 4] = [
    DispatcherSelectOption {
        value: "low",
        name: "Low",
        description: "Fast responses with lighter reasoning.",
    },
    DispatcherSelectOption {
        value: "medium",
        name: "Medium",
        description: "Balanced speed and reasoning depth for everyday tasks.",
    },
    DispatcherSelectOption {
        value: "high",
        name: "High",
        description: "Deeper reasoning for more complex tasks.",
    },
    DispatcherSelectOption {
        value: "xhigh",
        name: "Extra High",
        description: "Maximum reasoning depth for the hardest tasks.",
    },
];

#[derive(Clone)]
pub(crate) struct DispatcherRuntimeHandle {
    runtime_id: String,
    pub input_tx: mpsc::Sender<ExecutorInput>,
    accepts_input: bool,
    kill_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

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

pub(crate) fn is_acp_dispatcher_thread(session: &SessionRecord) -> bool {
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
    let clipped = trimmed
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
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

fn touch_acp_dispatcher_heartbeat(session: &mut SessionRecord) {
    if !is_acp_dispatcher_thread(session) {
        return;
    }
    let now = Utc::now();
    session
        .metadata
        .insert("acpHeartbeatState".to_string(), "active".to_string());
    session
        .metadata
        .insert("acpLastHeartbeatAt".to_string(), now.to_rfc3339());
    session.metadata.insert(
        "acpNextHeartbeatAt".to_string(),
        (now + ACP_HEARTBEAT_INTERVAL).to_rfc3339(),
    );
}

fn should_sync_dispatcher_session_memory(session: &mut SessionRecord, force: bool) -> bool {
    if !is_acp_dispatcher_thread(session) {
        return false;
    }

    let now = Utc::now();
    let should_sync = force
        || parse_timestamp(
            session
                .metadata
                .get(ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY),
        )
        .map(|last| now.signed_duration_since(last) >= ACP_SESSION_MEMORY_SYNC_INTERVAL)
        .unwrap_or(true);

    if should_sync {
        session.metadata.insert(
            ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY.to_string(),
            now.to_rfc3339(),
        );
    }

    should_sync
}

fn heartbeat_due_eligible(session: &SessionRecord) -> bool {
    matches!(
        session.status,
        SessionStatus::Idle | SessionStatus::NeedsInput
    )
}

fn heartbeat_can_prompt_live_runtime(session: &SessionRecord) -> bool {
    matches!(
        session.status,
        SessionStatus::Idle | SessionStatus::NeedsInput
    )
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
    NEEDLES.iter().any(|needle| lower.contains(needle))
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
            lines.push(format!(
                "- [{}] {}: {}",
                note.timestamp, note.label, note.text
            ));
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
            lines.push(format!(
                "- [{}] {}: {}",
                note.timestamp, note.label, note.text
            ));
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

async fn remove_optional_file(path: PathBuf) -> Result<()> {
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

async fn read_json<T>(path: &Path) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    let content = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str::<T>(&content).ok()
}

fn enforce_conversation_limit(session: &mut SessionRecord) {
    if session.conversation.len() <= DEFAULT_SESSION_HISTORY_LIMIT {
        return;
    }
    let excess = session.conversation.len() - DEFAULT_SESSION_HISTORY_LIMIT;
    session.conversation.drain(..excess);
}

fn clear_parser_state(session: &mut SessionRecord) -> bool {
    let mut dirty = false;
    dirty |= session.metadata.remove(PARSER_STATE_KEY).is_some();
    dirty |= session.metadata.remove(PARSER_STATE_MESSAGE_KEY).is_some();
    dirty |= session.metadata.remove(PARSER_STATE_COMMAND_KEY).is_some();
    dirty
}

fn update_dispatcher_active_skills_metadata(session: &mut SessionRecord, active_skills: &[String]) {
    let mut seen = HashSet::new();
    let sanitized = active_skills
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert((*value).to_string()))
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if sanitized.is_empty() {
        session.metadata.remove(ACP_ACTIVE_SKILLS_METADATA_KEY);
        return;
    }

    if let Ok(serialized) = serde_json::to_string(&sanitized) {
        session
            .metadata
            .insert(ACP_ACTIVE_SKILLS_METADATA_KEY.to_string(), serialized);
    } else {
        session.metadata.remove(ACP_ACTIVE_SKILLS_METADATA_KEY);
    }
}

fn set_parser_state(
    session: &mut SessionRecord,
    kind: &str,
    message: &str,
    command: Option<String>,
) -> bool {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return clear_parser_state(session);
    }

    let mut changed = false;
    changed |= session
        .metadata
        .insert(PARSER_STATE_KEY.to_string(), kind.to_string())
        .is_some_and(|value| value != kind);
    changed |= session
        .metadata
        .insert(PARSER_STATE_MESSAGE_KEY.to_string(), trimmed.to_string())
        .is_some_and(|value| value != trimmed);

    if let Some(value) = command.filter(|value| !value.trim().is_empty()) {
        changed |= session
            .metadata
            .insert(PARSER_STATE_COMMAND_KEY.to_string(), value.to_string())
            .is_some_and(|current| current != value);
    } else {
        changed |= session.metadata.remove(PARSER_STATE_COMMAND_KEY).is_some();
    }

    changed
}

fn parser_state_signature(
    session: &SessionRecord,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        session.metadata.get(PARSER_STATE_KEY).cloned(),
        session.metadata.get(PARSER_STATE_MESSAGE_KEY).cloned(),
        session.metadata.get(PARSER_STATE_COMMAND_KEY).cloned(),
    )
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

fn prepare_dispatcher_runtime_env(env: &mut HashMap<String, String>) {
    env.entry("TERM".to_string())
        .or_insert_with(|| "xterm-256color".to_string());
    env.entry("COLORTERM".to_string())
        .or_insert_with(|| "truecolor".to_string());

    for key in ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE"] {
        env.remove(key);
    }
}

fn append_runtime_status_entry_with_metadata(
    session: &mut SessionRecord,
    text: &str,
    explicit_metadata: Option<HashMap<String, Value>>,
) -> bool {
    let sanitized = sanitize_terminal_text(text);
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return false;
    }

    if let Some(last) = session.conversation.last() {
        if last.kind == "status_message" && last.source == "runtime" && last.text.trim() == trimmed
        {
            return false;
        }
    }

    let mut metadata = explicit_metadata.unwrap_or_default();
    if metadata.is_empty() {
        if let Some(tool_metadata) = runtime_tool_metadata(trimmed) {
            if let Some(object) = tool_metadata.as_object() {
                for (key, value) in object {
                    metadata.insert(key.clone(), value.clone());
                }
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
    true
}

fn append_runtime_status_entry(session: &mut SessionRecord, text: &str) -> bool {
    append_runtime_status_entry_with_metadata(session, text, None)
}

fn append_runtime_assistant_entry(session: &mut SessionRecord, text: &str) -> bool {
    let sanitized = sanitize_terminal_text(text);
    let normalized = sanitized.trim_end();
    if normalized.trim().is_empty() {
        return false;
    }

    if let Some(last) = session.conversation.last_mut() {
        if last.kind == "assistant_message" && last.source == "runtime" {
            merge_assistant_fragment(&mut last.text, normalized);
            last.created_at = Utc::now().to_rfc3339();
            return true;
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
    true
}

fn append_runtime_assistant_break(session: &mut SessionRecord) -> bool {
    let mut changed = false;
    if let Some(last) = session.conversation.last_mut() {
        if last.kind == "assistant_message" && last.source == "runtime" {
            let old = last.text.clone();
            if !last.text.ends_with("\n\n") {
                if last.text.ends_with('\n') {
                    last.text.push('\n');
                } else {
                    last.text.push_str("\n\n");
                }
                changed = true;
            }
            last.created_at = Utc::now().to_rfc3339();
            if last.text != old {
                changed = true;
            }
            return changed;
        }
    }

    false
}

fn apply_dispatcher_stdout_event(session: &mut SessionRecord, line: &str) -> bool {
    let mut feed_dirty = false;
    let previous_status = session.status.clone();
    let previous_output_empty = session.output.is_empty();

    touch_acp_dispatcher_heartbeat(session);
    if !session.status.is_terminal() {
        if session.status != SessionStatus::Working {
            session.status = SessionStatus::Working;
            feed_dirty = true;
        }
        session.activity = Some("active".to_string());
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        if append_runtime_assistant_break(session) {
            feed_dirty = true;
        }
        if previous_status != session.status {
            feed_dirty = true;
        }
        if previous_output_empty != session.output.is_empty() {
            feed_dirty = true;
        }
        return feed_dirty;
    }
    let parser_state_before = parser_state_signature(session);

    if detect_parser_state(session, trimmed) || is_runtime_status_line(trimmed) {
        if append_runtime_status_entry(session, trimmed) {
            feed_dirty = true;
        }
    } else {
        let parser_state_cleared = clear_parser_state(session);
        if parser_state_cleared {
            feed_dirty = true;
        }
        if append_runtime_assistant_entry(session, line.trim_end()) {
            feed_dirty = true;
        }
    }
    if parser_state_signature(session) != parser_state_before {
        feed_dirty = true;
    }
    session.summary = Some(trimmed.to_string());
    session
        .metadata
        .insert("summary".to_string(), trimmed.to_string());
    if previous_status != session.status {
        feed_dirty = true;
    }
    if previous_output_empty != session.output.is_empty() {
        feed_dirty = true;
    }
    feed_dirty
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

fn append_output(output: &mut String, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(line);
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

fn dispatcher_context_attachment_paths(thread: &SessionRecord) -> Vec<String> {
    let mut attachments = Vec::new();
    for key in [
        "acpProjectMemoryPath",
        "acpSessionMemoryPath",
        "acpBoardPath",
    ] {
        if let Some(path) = thread
            .metadata
            .get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !attachments.iter().any(|item| item == path) {
                attachments.push(path.to_string());
            }
        }
    }
    attachments
}

fn merge_dispatcher_context_attachments(
    thread: &SessionRecord,
    attachments: &[String],
) -> Vec<String> {
    let mut effective = attachments.to_vec();
    for path in dispatcher_context_attachment_paths(thread) {
        if !effective.iter().any(|item| item == &path) {
            effective.push(path);
        }
    }
    effective
}

fn dispatcher_internal_attachment_prefix(thread: &SessionRecord) -> String {
    format!(".conductor/rust-backend/acp/{}/", thread.project_id)
}

fn is_dispatcher_internal_attachment(
    attachment: &str,
    hidden_paths: &[String],
    hidden_prefix: &str,
) -> bool {
    let trimmed = attachment.trim();
    !trimmed.is_empty()
        && (hidden_paths.iter().any(|path| path == trimmed) || trimmed.starts_with(hidden_prefix))
}

fn strip_dispatcher_context_attachments(thread: &mut SessionRecord) -> bool {
    if !is_acp_dispatcher_thread(thread) {
        return false;
    }

    let hidden_paths = dispatcher_context_attachment_paths(thread);
    let hidden_prefix = dispatcher_internal_attachment_prefix(thread);
    let mut changed = false;

    for entry in &mut thread.conversation {
        let original_len = entry.attachments.len();
        entry.attachments.retain(|attachment| {
            !is_dispatcher_internal_attachment(attachment, &hidden_paths, &hidden_prefix)
        });
        if entry.attachments.len() != original_len {
            changed = true;
        }
    }

    changed
}

fn append_dispatcher_context_sections(prompt: &str, sections: &[String]) -> String {
    if sections.is_empty() {
        return prompt.to_string();
    }

    let mut combined = String::with_capacity(prompt.len() + 256);
    combined.push_str(prompt);
    combined.push_str(
        "\n\nRelevant project context for this turn. Treat this as supplied ACP context, not as a user-visible attachment list.\n",
    );
    for section in sections {
        combined.push_str(section);
        if !section.ends_with('\n') {
            combined.push('\n');
        }
    }
    combined
}

fn normalize_loaded_dispatcher_thread(thread: &mut SessionRecord) -> bool {
    let mut changed = false;
    if thread.metadata.get("sessionKind").map(String::as_str) != Some(ACP_SESSION_KIND) {
        thread
            .metadata
            .insert("sessionKind".to_string(), ACP_SESSION_KIND.to_string());
        changed = true;
    }
    if thread.metadata.get("role").map(String::as_str) != Some("orchestrator") {
        thread
            .metadata
            .insert("role".to_string(), "orchestrator".to_string());
        changed = true;
    }
    let should_grant_approval = thread
        .metadata
        .get(ACP_APPROVAL_STATE_METADATA_KEY)
        .map(String::as_str)
        .is_none()
        || (thread
            .metadata
            .get(ACP_APPROVAL_STATE_METADATA_KEY)
            .map(String::as_str)
            == Some(ACP_APPROVAL_REQUIRED)
            && thread.status == SessionStatus::Idle
            && thread.activity.as_deref() == Some("idle")
            && thread.summary.as_deref() == Some("Dispatcher ready"));
    if should_grant_approval {
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_GRANTED.to_string(),
        );
        changed = true;
    }

    if let Some(pid) = thread.pid.filter(|pid| *pid > 1) {
        if is_process_alive(pid) {
            let _ = terminate_process(pid);
        }
        thread.pid = None;
        changed = true;
    }

    if matches!(
        thread.status,
        SessionStatus::Working | SessionStatus::Queued | SessionStatus::Spawning
    ) {
        thread.status = SessionStatus::Idle;
        thread.activity = Some("idle".to_string());
        thread.summary = Some("Dispatcher ready for the next turn".to_string());
        thread.metadata.insert(
            "summary".to_string(),
            "Dispatcher ready for the next turn".to_string(),
        );
        changed = true;
    }

    if strip_dispatcher_context_attachments(thread) {
        changed = true;
    }

    for key in [
        "finishedAt",
        "lastStderr",
        PARSER_STATE_KEY,
        PARSER_STATE_MESSAGE_KEY,
        PARSER_STATE_COMMAND_KEY,
    ] {
        if thread.metadata.remove(key).is_some() {
            changed = true;
        }
    }

    if apply_dispatcher_implementation_preferences(thread, None, None, None) {
        changed = true;
    }

    changed
}

fn default_implementation_agent(
    requested_agent: Option<&str>,
    project: &ProjectConfig,
    default_agent: &str,
) -> String {
    let candidate = requested_agent
        .or(project.agent.as_deref())
        .unwrap_or(default_agent);
    match candidate.trim() {
        "codex" | "claude-code" | "gemini" | "openclaw" | "cursor-cli" => {
            candidate.trim().to_string()
        }
        _ => "codex".to_string(),
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn dispatcher_implementation_agent_options() -> &'static [DispatcherSelectOption] {
    &DISPATCHER_IMPLEMENTATION_AGENT_OPTIONS
}

pub(crate) fn dispatcher_implementation_model_options(
    agent: &str,
) -> &'static [DispatcherSelectOption] {
    match agent.trim() {
        "claude-code" => &DISPATCHER_CLAUDE_MODEL_OPTIONS,
        "gemini" => &DISPATCHER_GEMINI_MODEL_OPTIONS,
        "openclaw" => &DISPATCHER_OPENCLAW_MODEL_OPTIONS,
        "cursor-cli" => &DISPATCHER_CURSOR_MODEL_OPTIONS,
        _ => &DISPATCHER_CODEX_MODEL_OPTIONS,
    }
}

pub(crate) fn dispatcher_implementation_reasoning_options(
    agent: &str,
) -> &'static [DispatcherSelectOption] {
    match agent.trim() {
        "gemini" => &[],
        "openclaw" => &DISPATCHER_OPENCLAW_REASONING_OPTIONS,
        "claude-code" => &DISPATCHER_DEFAULT_REASONING_OPTIONS,
        _ => &DISPATCHER_CODEX_REASONING_OPTIONS,
    }
}

pub(crate) fn dispatcher_default_implementation_model(agent: &str) -> Option<&'static str> {
    dispatcher_implementation_model_options(agent)
        .first()
        .map(|option| option.value)
}

pub(crate) fn dispatcher_default_implementation_reasoning_effort(
    agent: &str,
) -> Option<&'static str> {
    match agent.trim() {
        "claude-code" => Some("medium"),
        "codex" => Some("high"),
        "cursor-cli" => Some("medium"),
        "openclaw" => None,
        _ => None,
    }
}

pub(crate) fn dispatcher_preferred_implementation_agent(session: &SessionRecord) -> String {
    session
        .metadata
        .get(ACP_IMPLEMENTATION_AGENT_METADATA_KEY)
        .cloned()
        .unwrap_or_else(|| "codex".to_string())
}

pub(crate) fn dispatcher_preferred_implementation_model(session: &SessionRecord) -> Option<String> {
    session
        .metadata
        .get(ACP_IMPLEMENTATION_MODEL_METADATA_KEY)
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            session
                .model
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
}

pub(crate) fn dispatcher_preferred_implementation_reasoning_effort(
    session: &SessionRecord,
) -> Option<String> {
    session
        .metadata
        .get(ACP_IMPLEMENTATION_REASONING_METADATA_KEY)
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            session
                .reasoning_effort
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn dispatcher_uses_headless_turns(agent_kind: &AgentKind) -> bool {
    matches!(
        agent_kind,
        AgentKind::Codex | AgentKind::QwenCode | AgentKind::OpenClaw
    )
}

fn dispatcher_resume_target(thread: &SessionRecord, agent_kind: &AgentKind) -> Option<String> {
    if dispatcher_uses_headless_turns(agent_kind) {
        return None;
    }

    thread.metadata.get(ACP_RESUME_TARGET_METADATA_KEY).cloned()
}

fn dispatcher_supports_interactive_structured_output(agent_kind: &AgentKind) -> bool {
    matches!(
        agent_kind,
        AgentKind::ClaudeCode
            | AgentKind::Amp
            | AgentKind::Ccr
            | AgentKind::Gemini
            | AgentKind::CursorCli
            | AgentKind::Droid
            | AgentKind::GithubCopilot
    )
}

fn read_json_file(path: &Path) -> Option<Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn codex_runtime_model_entry<'a>(cache: &'a Value, model: &str) -> Option<&'a Value> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return None;
    }

    cache
        .get("models")
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| {
            entry.get("visibility").and_then(Value::as_str) == Some("list")
                && entry
                    .get("slug")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .is_some_and(|slug| slug.eq_ignore_ascii_case(trimmed))
        })
}

fn codex_runtime_model_supported(model: &str) -> bool {
    let Some(home) = home_dir() else {
        return false;
    };
    let cache_path = home.join(".codex").join("models_cache.json");
    let Some(cache) = read_json_file(&cache_path) else {
        return false;
    };
    codex_runtime_model_entry(&cache, model).is_some()
}

fn codex_runtime_reasoning_supported_in_cache(
    cache: &Value,
    model: &str,
    reasoning_effort: &str,
) -> Option<bool> {
    let entry = codex_runtime_model_entry(cache, model)?;
    let levels = entry
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)?;
    let normalized = reasoning_effort.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Some(false);
    }

    Some(levels.iter().any(|level| {
        level
            .get("effort")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| value.eq_ignore_ascii_case(&normalized))
    }))
}

fn codex_runtime_reasoning_supported(model: &str, reasoning_effort: &str) -> Option<bool> {
    let home = home_dir()?;
    let cache_path = home.join(".codex").join("models_cache.json");
    let cache = read_json_file(&cache_path)?;
    codex_runtime_reasoning_supported_in_cache(&cache, model, reasoning_effort)
}

fn dispatcher_model_supported_for_agent(agent: &str, model: &str) -> bool {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return false;
    }
    if dispatcher_implementation_model_options(agent)
        .iter()
        .any(|option| option.value.eq_ignore_ascii_case(trimmed))
    {
        return true;
    }

    let normalized = trimmed.to_ascii_lowercase();
    match agent.trim() {
        "claude-code" => {
            matches!(normalized.as_str(), "opus" | "sonnet" | "haiku")
                || normalized.starts_with("claude-")
        }
        "gemini" => normalized.starts_with("gemini"),
        "cursor-cli" => {
            // Cursor model IDs are runtime-discovered (e.g. auto, gpt-5.4-medium,
            // claude-4.6-opus-max-thinking) and not statically enumerated here.
            true
        }
        _ => {
            codex_runtime_model_supported(trimmed)
                || normalized.starts_with("gpt-")
                || normalized.starts_with("openai/")
                || normalized.starts_with("openai:")
                || normalized.contains("codex")
        }
    }
}

fn dispatcher_reasoning_supported_for_agent(
    agent: &str,
    model: Option<&str>,
    reasoning_effort: &str,
) -> bool {
    if agent.trim() == "codex" {
        if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
            if let Some(supported) = codex_runtime_reasoning_supported(model, reasoning_effort) {
                return supported;
            }
        }
    }

    dispatcher_implementation_reasoning_options(agent)
        .iter()
        .any(|option| option.value == reasoning_effort.trim().to_ascii_lowercase())
}

fn dispatcher_runtime_model_supported_for_agent(agent: &str, model: &str) -> bool {
    let options = dispatcher_implementation_model_options(agent);
    options.is_empty() || dispatcher_model_supported_for_agent(agent, model)
}

fn dispatcher_runtime_reasoning_supported_for_agent(
    agent: &str,
    model: Option<&str>,
    reasoning_effort: &str,
) -> bool {
    let options = dispatcher_implementation_reasoning_options(agent);
    options.is_empty() || dispatcher_reasoning_supported_for_agent(agent, model, reasoning_effort)
}

fn resolve_dispatcher_implementation_model(
    thread: &SessionRecord,
    agent: &str,
    implementation_model: Option<&str>,
) -> Option<String> {
    let current_model = dispatcher_preferred_implementation_model(thread);
    implementation_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            current_model.as_ref().and_then(|value| {
                dispatcher_model_supported_for_agent(agent, value).then(|| value.clone())
            })
        })
        .or_else(|| dispatcher_default_implementation_model(agent).map(str::to_string))
}

fn resolve_dispatcher_implementation_reasoning_effort(
    thread: &SessionRecord,
    agent: &str,
    model: Option<&str>,
    implementation_reasoning_effort: Option<&str>,
) -> Option<String> {
    let current_reasoning = dispatcher_preferred_implementation_reasoning_effort(thread);
    implementation_reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| {
            current_reasoning.as_ref().and_then(|value| {
                dispatcher_reasoning_supported_for_agent(agent, model, value).then(|| value.clone())
            })
        })
        .or_else(|| dispatcher_default_implementation_reasoning_effort(agent).map(str::to_string))
}

fn apply_dispatcher_implementation_preferences(
    thread: &mut SessionRecord,
    implementation_agent: Option<String>,
    implementation_model: Option<String>,
    implementation_reasoning_effort: Option<String>,
) -> bool {
    let mut changed = false;
    let previous_agent = dispatcher_preferred_implementation_agent(thread);
    let next_agent = implementation_agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| match value {
            "codex" | "claude-code" | "gemini" | "openclaw" | "cursor-cli" => value.to_string(),
            _ => "codex".to_string(),
        })
        .unwrap_or_else(|| previous_agent.clone());
    let agent_changed = next_agent != previous_agent
        || thread
            .metadata
            .get(ACP_IMPLEMENTATION_AGENT_METADATA_KEY)
            .map(String::as_str)
            != Some(next_agent.as_str());
    if agent_changed {
        thread.metadata.insert(
            ACP_IMPLEMENTATION_AGENT_METADATA_KEY.to_string(),
            next_agent.clone(),
        );
        changed = true;
    }

    let resolved_model = resolve_dispatcher_implementation_model(
        thread,
        &next_agent,
        implementation_model.as_deref(),
    );
    match resolved_model.as_ref() {
        Some(model) => {
            if thread
                .metadata
                .get(ACP_IMPLEMENTATION_MODEL_METADATA_KEY)
                .map(String::as_str)
                != Some(model.as_str())
            {
                thread.metadata.insert(
                    ACP_IMPLEMENTATION_MODEL_METADATA_KEY.to_string(),
                    model.clone(),
                );
                changed = true;
            }
        }
        None => {
            if thread
                .metadata
                .remove(ACP_IMPLEMENTATION_MODEL_METADATA_KEY)
                .is_some()
            {
                changed = true;
            }
        }
    }

    let resolved_reasoning = resolve_dispatcher_implementation_reasoning_effort(
        thread,
        &next_agent,
        resolved_model.as_deref(),
        implementation_reasoning_effort.as_deref(),
    );
    match resolved_reasoning {
        Some(reasoning_effort) => {
            if thread
                .metadata
                .get(ACP_IMPLEMENTATION_REASONING_METADATA_KEY)
                .map(String::as_str)
                != Some(reasoning_effort.as_str())
            {
                thread.metadata.insert(
                    ACP_IMPLEMENTATION_REASONING_METADATA_KEY.to_string(),
                    reasoning_effort,
                );
                changed = true;
            }
        }
        None => {
            if thread
                .metadata
                .remove(ACP_IMPLEMENTATION_REASONING_METADATA_KEY)
                .is_some()
            {
                changed = true;
            }
        }
    }

    changed
}

pub(crate) fn build_acp_dispatcher_prompt(
    state: &Arc<AppState>,
    project_id: &str,
    project: &ProjectConfig,
    user_prompt: &str,
) -> String {
    let repo_path = state.resolve_project_path(project);
    let repo_board = repo_path.join("CONDUCTOR.md");
    let board_path = if repo_board.exists() && !repo_board.starts_with(&state.workspace_path) {
        repo_board
    } else {
        let board_dir = project
            .board_dir
            .clone()
            .unwrap_or_else(|| project_id.to_string());
        let board_relative =
            resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
        state.workspace_path.join(board_relative)
    };
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
            "- Use native Conductor MCP tools when available to inspect the board, create dispatcher tasks, update them, hand them off explicitly, and inspect task attempt lifecycles\n",
            "- Do not do the main implementation work in this dispatcher unless the user explicitly asks for that\n",
            "- Prefer handing implementation to dedicated coding-agent sessions instead of doing it inside the dispatcher\n\n",
            "Project context:\n",
            "- Repo path: `{}`\n",
            "- Board path: `{}`\n",
            "- Default branch: `{}`\n\n",
            "Work classification:\n",
            "- Product shaping: convert rough requests into board structure, sequencing, and launchable tasks\n",
            "- Implementation handoff: create ready-to-run tasks with exact execution packets for coding agents\n",
            "- Repo or PR review: create review tasks that gather repo state, inspect PR details, and return findings instead of implementation\n",
            "- Research or audit: create scoped investigation tasks with explicit deliverables and no hidden implementation work\n\n",
            "Operating rules:\n",
            "- Operate against the main project workspace, current checked-out branch, and board context; do not create isolated implementation branches or worktrees from this ACP session\n",
            "- Default to execution mode: inspect the repo and board first, then create or update the right board tasks in the same turn when the request is actionable\n",
            "- Start actionable turns by inspecting the current board with `conductor_get_board`, then inspect the relevant repo files, diffs, PRs, or docs before deciding whether to create, update, or hand off tasks\n",
            "- When the request clearly requires board changes, do not stop at prose: use `conductor_dispatcher_create_task`, `conductor_dispatcher_update_task`, or `conductor_dispatcher_handoff_task` in the same turn unless the user explicitly asked for plan-only review\n",
            "- Never edit `CONDUCTOR.md`, `.conductor/tasks/*.md`, or other board projection artifacts directly from this dispatcher with shell commands, patch tools, or file writes; those files must only change via the native Conductor MCP task tools\n",
            "- If you think a task, board column, or packet needs to change, that is a signal to call the dispatcher MCP tools, not to patch markdown by hand\n",
            "- A dispatcher task-mutation turn is only complete after the relevant MCP task tool succeeds and the board lifecycle mutation has been recorded through Conductor, not after manual file edits\n",
            "- When the user asks for product shaping, convert it into board structure and clear tasks\n",
            "- When implementation should happen, create or update launchable tasks instead of jumping straight into code\n",
            "- Keep the conversation stateful and use the board as the shared execution surface\n",
            "- Every task you create should carry a real execution packet, not vague notes\n",
            "- Use enough tool calls to inspect relevant files, diffs, branches, board history, and live attempts before shaping or updating tasks\n",
            "- Use the board task packet fields explicitly when creating or updating tasks: `objective`, `execution_mode`, `surfaces`, `constraints`, `dependencies`, `acceptance`, `skills`, `review_refs`, and `deliverables`\n",
            "- ACP task creation now rejects thin handoffs: every created task needs a real agent assignment, objective, execution mode, surfaces, acceptance, skills, deliverables, and concrete context through notes, dependencies, constraints, review refs, or attachments\n",
            "- Treat `surfaces` as the task's reference files and inspection targets: list exact file paths, folders, tests, routes, APIs, docs, or product surfaces instead of generic labels\n",
            "- Treat `skills` as required worker guidance: list the concrete domains, tools, and active skills the worker should use, not vague adjectives\n",
            "- When an implementation preference is present, persist it onto the task using `agent:<name>`, `model:<id>`, and `reasoningEffort:<level>` metadata unless the user explicitly overrides it\n",
            "- If the current dispatcher turn includes user-provided attachments or linked files, those attachments should travel with the tasks you create unless you are intentionally narrowing to a smaller task-specific subset\n",
            "- For implementation tasks, default `execution_mode` to `worktree` unless main-workspace or temp-clone execution is genuinely better\n",
            "- For repo review, PR review, and dispatcher shaping work, prefer `task_type=review` and `execution_mode=main_workspace` so the worker inspects the current branch directly without creating an extra repo copy\n",
            "- Use `execution_mode=temp_clone` only when the user explicitly asks for isolation or the task genuinely needs a separate full repo copy for destructive repro, cross-branch comparison, or external branch inspection\n",
            "- For review tasks, capture the exact PR URLs, branches, commits, issues, and files to inspect in `review_refs` and `surfaces`\n",
            "- For implementation tasks, capture the exact files or surfaces to inspect, the rules that must not be violated, the dependencies, and the concrete acceptance criteria before handing off\n",
            "- For research or audit tasks, set clear deliverables such as review memo, comparison, risk list, migration plan, or reproduction notes\n",
            "- If the user explicitly asks for a plan-only review, stop after presenting: the proposed plan, the exact board/task mutations, the intended tool calls, and the recommended implementation agent per task\n",
            "- If the request is ambiguous or a mutation would be risky, you may pause for a plan-only review before mutating the board\n",
            "- When proposing tasks in plan-only mode, use a compact task packet for each item: title, target board role, task type, recommended agent, execution mode, objective, exact files or surfaces to inspect, constraints, dependencies, acceptance shape, and deliverables\n",
            "- Plan-only proposal format should be concise and explicit: summary, board mutations, intended MCP tool calls, then task packets\n",
            "- When creating tasks, keep the board task title concise and use the task packet fields to populate the generated task brief so a dedicated coding or review session can execute without reopening planning\n",
            "- If the user asks for revisions after a plan-only review, revise the proposal and wait before mutating the board again\n",
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

impl AppState {
    pub(crate) fn dispatcher_store_dir(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("dispatchers")
    }

    pub(crate) fn ensure_dispatcher_store(&self) {
        let _ = create_dir_all(self.dispatcher_store_dir());
    }

    pub(crate) fn dispatcher_snapshot_path(&self, session_id: &str) -> PathBuf {
        self.dispatcher_store_dir()
            .join(format!("{session_id}.json"))
    }

    pub(crate) async fn load_dispatchers_from_disk(&self) {
        let root = self.dispatcher_store_dir();
        let entries = match tokio::fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut entries = entries;
        let mut loaded = HashMap::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = tokio::fs::read_to_string(&path).await {
                if let Ok(mut session) = serde_json::from_str::<SessionRecord>(&content) {
                    let changed = normalize_loaded_dispatcher_thread(&mut session);
                    if changed {
                        if let Ok(updated) = serde_json::to_string_pretty(&session) {
                            let _ = tokio::fs::write(&path, updated).await;
                        }
                        let _ = self.sync_acp_dispatcher_state(&session).await;
                    }
                    loaded.insert(session.id.clone(), session);
                }
            }
        }
        if !loaded.is_empty() {
            let mut guard = self.dispatcher_threads.write().await;
            guard.extend(loaded);
        }
        self.dispatcher_feed_payload_cache.lock().await.clear();
    }

    pub(crate) async fn persist_dispatcher_thread(&self, thread: &SessionRecord) -> Result<()> {
        let path = self.dispatcher_snapshot_path(&thread.id);
        let content = serde_json::to_string_pretty(thread)?;
        tokio::fs::write(path, content).await?;
        self.invalidate_dispatcher_caches(&thread.id).await;
        Ok(())
    }

    pub(crate) async fn replace_dispatcher_thread(&self, thread: SessionRecord) -> Result<()> {
        self.persist_dispatcher_thread(&thread).await?;
        {
            let mut guard = self.dispatcher_threads.write().await;
            guard.insert(thread.id.clone(), thread.clone());
        }
        self.publish_dispatcher_update(&thread.id).await;
        Ok(())
    }

    pub(crate) async fn delete_dispatcher_thread(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        let thread = self
            .get_dispatcher_thread(thread_id)
            .await
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        // Interrupt with timeout - dont block delete if runtime is stuck
        let interrupt_self = self.clone();
        let interrupt_thread_id = thread_id.to_string();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                interrupt_self.interrupt_dispatcher(&interrupt_thread_id),
            )
            .await;
        });
        self.clear_dispatcher_runtime(thread_id).await;

        // Kill the process directly if it's still running
        if let Some(pid) = thread.pid.filter(|p| *p > 1) {
            if is_process_alive(pid) {
                terminate_process(pid);
            }
        }

        self.active_session_skills.lock().await.remove(thread_id);
        {
            let mut guard = self.dispatcher_threads.write().await;
            guard.remove(thread_id);
        }
        self.invalidate_dispatcher_caches(thread_id).await;
        self.publish_dispatcher_update(thread_id).await;

        let cleanup_state = Arc::clone(self);
        let cleanup_thread_id = thread_id.to_string();
        let cleanup_project_id = thread.project_id.clone();
        tokio::spawn(async move {
            let snapshot_path = cleanup_state.dispatcher_snapshot_path(&cleanup_thread_id);
            let session_json_path =
                cleanup_state.acp_session_memory_json_path(&cleanup_project_id, &cleanup_thread_id);
            let session_md_path = cleanup_state
                .acp_session_memory_markdown_path(&cleanup_project_id, &cleanup_thread_id);

            if let Err(err) = tokio::try_join!(
                remove_optional_file(snapshot_path),
                remove_optional_file(session_json_path),
                remove_optional_file(session_md_path),
            ) {
                tracing::warn!(
                    thread_id = %cleanup_thread_id,
                    error = %err,
                    "failed to remove dispatcher artifacts after delete"
                );
            }

            if let Err(err) = cleanup_state
                .clear_dispatcher_binding_thread(&cleanup_thread_id)
                .await
            {
                tracing::warn!(
                    thread_id = %cleanup_thread_id,
                    error = %err,
                    "failed to clear dispatcher binding after delete"
                );
            }
        });

        Ok(())
    }

    pub(crate) async fn publish_dispatcher_update(&self, thread_id: &str) {
        self.invalidate_dispatcher_caches(thread_id).await;
        let pending_updates: Arc<tokio::sync::Mutex<HashMap<String, u64>>> =
            Arc::clone(&self.pending_dispatcher_updates);
        let dispatcher_updates = self.dispatcher_updates.clone();
        let notify_seq = {
            let mut pending = self.pending_dispatcher_updates.lock().await;
            let next_seq = pending
                .get(thread_id)
                .copied()
                .unwrap_or_default()
                .saturating_add(1);
            pending.insert(thread_id.to_string(), next_seq);
            next_seq
        };

        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let should_send = {
                let mut pending = pending_updates.lock().await;
                match pending.get(&thread_id).copied() {
                    Some(current) if current == notify_seq => {
                        pending.remove(&thread_id);
                        true
                    }
                    _ => false,
                }
            };

            if should_send {
                let _ = dispatcher_updates.send(thread_id.clone());
            }
        });
    }

    pub(crate) async fn record_dispatcher_task_lifecycle_event(
        self: &Arc<Self>,
        thread_id: &str,
        operation: DispatcherTaskOperation,
        task: &BoardTaskRecord,
        role: &str,
    ) -> Result<()> {
        let mut threads = self.dispatcher_threads.write().await;
        let thread = threads
            .get_mut(thread_id)
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        let (title, description) = split_task_text(&task.text);
        let task_ref = task
            .task_ref
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(task.id.as_str())
            .to_string();
        let role_label = default_heading_for_role(role).to_string();
        let event_type = match operation {
            DispatcherTaskOperation::Create => "dispatcher_task_created",
            DispatcherTaskOperation::Update => "dispatcher_task_updated",
            DispatcherTaskOperation::Handoff => "dispatcher_task_handed_off",
        };
        let summary_line = match operation {
            DispatcherTaskOperation::Create => {
                format!("Created `{task_ref}` in `{role_label}`.")
            }
            DispatcherTaskOperation::Update => {
                format!("Updated `{task_ref}` in `{role_label}`.")
            }
            DispatcherTaskOperation::Handoff => {
                format!("Handed off `{task_ref}` to `{role_label}`.")
            }
        };

        let mut details = vec![format!("- Task: {title}")];
        if let Some(description) = description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            details.push(format!("- Description: {description}"));
        }
        if let Some(agent) = task
            .agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            details.push(format!("- Agent: {agent}"));
        }
        if let Some(task_type) = task
            .task_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            details.push(format!("- Type: {task_type}"));
        }

        let mut metadata = HashMap::new();
        metadata.insert(
            "eventType".to_string(),
            Value::String(event_type.to_string()),
        );
        metadata.insert(
            "operation".to_string(),
            Value::String(operation.as_str().to_string()),
        );
        metadata.insert(
            "projectId".to_string(),
            Value::String(
                task.project
                    .clone()
                    .unwrap_or_else(|| thread.project_id.clone()),
            ),
        );
        metadata.insert("taskId".to_string(), Value::String(task.id.clone()));
        metadata.insert("taskRef".to_string(), Value::String(task_ref.clone()));
        metadata.insert("taskTitle".to_string(), Value::String(title.clone()));
        metadata.insert("taskRole".to_string(), Value::String(role.to_string()));
        metadata.insert(
            "taskRoleLabel".to_string(),
            Value::String(role_label.clone()),
        );
        if let Some(agent) = task.agent.clone() {
            metadata.insert("taskAgent".to_string(), Value::String(agent));
        }
        if let Some(task_type) = task.task_type.clone() {
            metadata.insert("taskType".to_string(), Value::String(task_type));
        }

        thread.last_activity_at = Utc::now().to_rfc3339();
        thread.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "system_message".to_string(),
            source: "dispatcher_task_lifecycle".to_string(),
            text: format!("{summary_line}\n\n{}", details.join("\n")),
            created_at: Utc::now().to_rfc3339(),
            attachments: Vec::new(),
            metadata,
        });
        enforce_conversation_limit(thread);
        let updated = thread.clone();
        drop(threads);

        self.persist_dispatcher_thread(&updated).await?;
        self.publish_dispatcher_update(thread_id).await;

        let state = Arc::clone(self);
        let thread_for_sync = updated;
        tokio::spawn(async move {
            if let Err(err) = state.sync_acp_dispatcher_state(&thread_for_sync).await {
                tracing::warn!(
                    thread_id = %thread_for_sync.id,
                    error = %err,
                    "async sync_acp_dispatcher_state after task lifecycle event failed"
                );
            }
        });
        Ok(())
    }

    pub(crate) async fn link_session_to_dispatcher(
        &self,
        session_id: &str,
        thread_id: &str,
    ) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Unknown session {session_id}"))?;
        if session
            .metadata
            .get("dispatcherThreadId")
            .map(String::as_str)
            == Some(thread_id)
        {
            return Ok(());
        }
        session
            .metadata
            .insert("dispatcherThreadId".to_string(), thread_id.to_string());
        let updated = session.clone();
        drop(sessions);

        self.persist_session(&updated).await?;
        self.publish_feed_update(session_id);
        self.publish_snapshot().await;
        Ok(())
    }

    fn dispatcher_task_ref_for_session(session: &SessionRecord) -> String {
        session
            .metadata
            .get("taskRef")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                session
                    .metadata
                    .get("taskId")
                    .map(String::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or(session.id.as_str())
            .to_string()
    }

    fn short_dispatcher_session_id(session_id: &str) -> String {
        session_id.chars().take(8).collect()
    }

    async fn record_dispatcher_session_event(
        &self,
        thread_id: &str,
        event_type: &str,
        source: &str,
        text: String,
        session: &SessionRecord,
        mut metadata: HashMap<String, Value>,
    ) -> Result<()> {
        let mut threads = self.dispatcher_threads.write().await;
        let thread = threads
            .get_mut(thread_id)
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        metadata.insert(
            "eventType".to_string(),
            Value::String(event_type.to_string()),
        );
        metadata.insert(
            "projectId".to_string(),
            Value::String(thread.project_id.clone()),
        );
        metadata.insert("sessionId".to_string(), Value::String(session.id.clone()));
        metadata.insert(
            "sessionAgent".to_string(),
            Value::String(session.agent.clone()),
        );
        metadata.insert(
            "sessionStatus".to_string(),
            serde_json::to_value(&session.status).unwrap_or(Value::Null),
        );
        if let Some(branch) = session.branch.clone() {
            metadata.insert("sessionBranch".to_string(), Value::String(branch));
        }
        if let Some(task_id) = session.metadata.get("taskId").cloned() {
            metadata.insert("taskId".to_string(), Value::String(task_id));
        }
        let task_ref = Self::dispatcher_task_ref_for_session(session);
        metadata.insert("taskRef".to_string(), Value::String(task_ref));
        if let Some(summary) = session
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            metadata.insert("summary".to_string(), Value::String(summary.to_string()));
        }

        thread.last_activity_at = Utc::now().to_rfc3339();
        thread.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "system_message".to_string(),
            source: source.to_string(),
            text,
            created_at: Utc::now().to_rfc3339(),
            attachments: Vec::new(),
            metadata,
        });
        enforce_conversation_limit(thread);
        let updated = thread.clone();
        drop(threads);

        self.persist_dispatcher_thread(&updated).await?;
        self.sync_acp_dispatcher_state(&updated).await?;
        self.publish_dispatcher_update(thread_id).await;
        Ok(())
    }

    pub(crate) async fn record_dispatcher_session_launch_event(
        &self,
        thread_id: &str,
        task: &BoardTaskRecord,
        session: &SessionRecord,
    ) -> Result<()> {
        let task_ref = task
            .task_ref
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(task.id.as_str());
        let title = split_task_text(&task.text).0;
        let mut details = vec![format!("- Task: {title}")];
        details.push(format!("- Session: {}", session.id));
        details.push(format!("- Agent: {}", session.agent));
        if let Some(branch) = session
            .branch
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            details.push(format!("- Branch: {branch}"));
        }

        let mut metadata = HashMap::new();
        metadata.insert("taskTitle".to_string(), Value::String(title));
        metadata.insert("taskId".to_string(), Value::String(task.id.clone()));
        metadata.insert("taskRef".to_string(), Value::String(task_ref.to_string()));
        self.record_dispatcher_session_event(
            thread_id,
            "dispatcher_session_launched",
            "dispatcher_session_lifecycle",
            format!(
                "Opened coding session `{}` for `{task_ref}`.\n\n{}",
                Self::short_dispatcher_session_id(&session.id),
                details.join("\n")
            ),
            session,
            metadata,
        )
        .await
    }

    pub(crate) async fn record_dispatcher_blocker_event(
        &self,
        thread_id: &str,
        session: &SessionRecord,
        prompt: &str,
    ) -> Result<()> {
        let prompt = prompt.trim();
        let prompt = if prompt.is_empty() {
            "Session is waiting for user input."
        } else {
            prompt
        };
        let task_ref = Self::dispatcher_task_ref_for_session(session);
        let mut metadata = HashMap::new();
        metadata.insert("blocker".to_string(), Value::String(prompt.to_string()));
        self.record_dispatcher_session_event(
            thread_id,
            "dispatcher_blocker_detected",
            "dispatcher_session_lifecycle",
            format!(
                "Coding session `{}` for `{task_ref}` needs input.\n\n- Agent: {}\n- Prompt: {prompt}",
                Self::short_dispatcher_session_id(&session.id),
                session.agent,
            ),
            session,
            metadata,
        )
        .await
    }

    pub(crate) async fn record_dispatcher_session_completion_event(
        &self,
        thread_id: &str,
        session: &SessionRecord,
    ) -> Result<()> {
        let task_ref = Self::dispatcher_task_ref_for_session(session);
        let summary = session
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Ready for follow-up");
        let mut metadata = HashMap::new();
        metadata.insert(
            "completionSummary".to_string(),
            Value::String(summary.to_string()),
        );
        self.record_dispatcher_session_event(
            thread_id,
            "dispatcher_session_completed",
            "dispatcher_session_lifecycle",
            format!(
                "Coding session `{}` for `{task_ref}` completed.\n\n- Agent: {}\n- Summary: {summary}",
                Self::short_dispatcher_session_id(&session.id),
                session.agent,
            ),
            session,
            metadata,
        )
        .await
    }

    pub(crate) async fn record_dispatcher_session_failure_event(
        &self,
        thread_id: &str,
        session: &SessionRecord,
        error: &str,
        exit_code: Option<i32>,
    ) -> Result<()> {
        let task_ref = Self::dispatcher_task_ref_for_session(session);
        let message = error.trim();
        let detail = if message.is_empty() {
            "Session failed".to_string()
        } else {
            message.to_string()
        };
        let mut metadata = HashMap::new();
        metadata.insert("error".to_string(), Value::String(detail.clone()));
        if let Some(exit_code) = exit_code {
            metadata.insert("exitCode".to_string(), Value::Number(exit_code.into()));
        }
        self.record_dispatcher_session_event(
            thread_id,
            "dispatcher_session_failed",
            "dispatcher_session_lifecycle",
            format!(
                "Coding session `{}` for `{task_ref}` failed.\n\n- Agent: {}\n- Error: {}",
                Self::short_dispatcher_session_id(&session.id),
                session.agent,
                detail
            ),
            session,
            metadata,
        )
        .await
    }

    pub(crate) async fn invalidate_dispatcher_caches(&self, thread_id: &str) {
        self.dispatcher_feed_payload_cache
            .lock()
            .await
            .remove(thread_id);
    }

    pub(crate) async fn cached_dispatcher_feed_payload(
        &self,
        thread_id: &str,
        window_limit: usize,
    ) -> Option<Value> {
        self.dispatcher_feed_payload_cache
            .lock()
            .await
            .get(thread_id)
            .filter(|entry| entry.window_limit == window_limit)
            .map(|entry| entry.payload.clone())
    }

    pub(crate) async fn store_dispatcher_feed_payload(
        &self,
        thread_id: &str,
        window_limit: usize,
        payload: Value,
    ) {
        self.dispatcher_feed_payload_cache.lock().await.insert(
            thread_id.to_string(),
            super::FeedPayloadCacheEntry {
                payload,
                window_limit,
            },
        );
    }

    pub(crate) async fn all_dispatcher_threads(&self) -> Vec<SessionRecord> {
        let threads = self.dispatcher_threads.read().await;
        let mut list = threads.values().cloned().collect::<Vec<_>>();
        list.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        list
    }

    pub(crate) async fn get_dispatcher_thread(&self, thread_id: &str) -> Option<SessionRecord> {
        self.dispatcher_threads.read().await.get(thread_id).cloned()
    }

    pub(crate) async fn latest_project_dispatcher_thread(
        &self,
        project_id: &str,
        bridge_id: Option<&str>,
        dispatcher_agent: Option<&str>,
    ) -> Option<SessionRecord> {
        self.all_dispatcher_threads()
            .await
            .into_iter()
            .filter(|session| session.project_id == project_id)
            .filter(is_acp_dispatcher_thread)
            .filter(|session| !session.status.is_terminal())
            .filter(|session| match bridge_id {
                Some(expected) => session.bridge_id.as_deref() == Some(expected),
                None => session.bridge_id.is_none(),
            })
            .filter(|session| match dispatcher_agent {
                Some(expected) => session.agent == expected,
                None => true,
            })
            .max_by(|left, right| {
                left.last_activity_at
                    .cmp(&right.last_activity_at)
                    .then(left.created_at.cmp(&right.created_at))
            })
    }

    pub(crate) async fn project_dispatcher_threads(
        &self,
        project_id: &str,
        bridge_id: Option<&str>,
    ) -> Vec<SessionRecord> {
        let mut threads = self
            .all_dispatcher_threads()
            .await
            .into_iter()
            .filter(|session| session.project_id == project_id)
            .filter(is_acp_dispatcher_thread)
            .filter(|session| session.status != SessionStatus::Archived)
            .filter(|session| match bridge_id {
                Some(expected) => session.bridge_id.as_deref() == Some(expected),
                None => session.bridge_id.is_none(),
            })
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| {
            right
                .last_activity_at
                .cmp(&left.last_activity_at)
                .then(right.created_at.cmp(&left.created_at))
        });
        threads
    }

    pub(crate) async fn create_project_dispatcher_thread(
        self: &Arc<Self>,
        project_id: &str,
        options: CreateDispatcherThreadOptions,
    ) -> Result<SessionRecord> {
        let CreateDispatcherThreadOptions {
            bridge_id,
            dispatcher_agent,
            implementation_agent,
            openclaw_config,
            dispatcher_model,
            dispatcher_reasoning_effort,
            implementation_model,
            implementation_reasoning_effort,
            force_new,
        } = options;
        let config = self.config.read().await.clone();
        let project = config
            .projects
            .get(project_id)
            .cloned()
            .with_context(|| format!("Unknown project: {project_id}"))?;
        let default_agent =
            normalize_optional_string(Some(config.preferences.coding_agent.clone()))
                .unwrap_or_else(|| "codex".to_string());
        let agent = normalize_optional_string(dispatcher_agent)
            .or_else(|| normalize_optional_string(project.agent.clone()))
            .unwrap_or_else(|| default_agent.clone());
        if !force_new {
            if let Some(existing) = self
                .latest_project_dispatcher_thread(
                    project_id,
                    bridge_id.as_deref(),
                    Some(agent.as_str()),
                )
                .await
            {
                // Don't reuse errored or killed threads
                if existing.status.is_terminal() {
                    // Fall through to create a new thread
                } else {
                    let mut updated = existing;
                    if dispatcher_model.is_some() || dispatcher_reasoning_effort.is_some() {
                        updated = self
                            .update_dispatcher_runtime_preferences(
                                &updated.id,
                                dispatcher_model,
                                dispatcher_reasoning_effort,
                            )
                            .await?;
                    }
                    if implementation_agent.is_some()
                        || implementation_model.is_some()
                        || implementation_reasoning_effort.is_some()
                        || has_openclaw_dispatcher_config_patch(&openclaw_config)
                    {
                        updated = self
                            .update_dispatcher_preferences(
                                &updated.id,
                                DispatcherPreferencesPatch {
                                    implementation_agent,
                                    implementation_model,
                                    implementation_reasoning_effort,
                                    openclaw_config: openclaw_config.clone(),
                                    ..DispatcherPreferencesPatch::default()
                                },
                            )
                            .await?;
                    }
                    return Ok(updated);
                }
            }
        }

        let repo_path = self.resolve_project_path(&project);
        let prompt = build_acp_dispatcher_prompt(self, project_id, &project, "");
        let thread_id = Uuid::new_v4().to_string();
        let mut thread = SessionRecord::new(
            thread_id.clone(),
            project_id.to_string(),
            None,
            None,
            Some(repo_path.to_string_lossy().to_string()),
            agent.clone(),
            dispatcher_model.clone(),
            dispatcher_reasoning_effort.clone(),
            prompt,
            None,
        );
        thread.bridge_id = bridge_id;
        thread.status = SessionStatus::Idle;
        thread.activity = Some("idle".to_string());
        thread.summary = Some("Dispatcher ready".to_string());
        thread
            .metadata
            .insert("summary".to_string(), "Dispatcher ready".to_string());
        thread
            .metadata
            .insert("sessionKind".to_string(), ACP_SESSION_KIND.to_string());
        thread
            .metadata
            .insert("role".to_string(), "orchestrator".to_string());
        thread
            .metadata
            .insert("acpMode".to_string(), ACP_MODE_DISPATCHER.to_string());
        thread.metadata.insert(
            "agentCwd".to_string(),
            repo_path.to_string_lossy().to_string(),
        );
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_GRANTED.to_string(),
        );
        let selected_implementation_agent = normalize_optional_string(implementation_agent)
            .unwrap_or_else(|| {
                default_implementation_agent(Some(agent.as_str()), &project, &default_agent)
            });
        thread.metadata.insert(
            ACP_IMPLEMENTATION_AGENT_METADATA_KEY.to_string(),
            selected_implementation_agent,
        );
        let _ = apply_dispatcher_implementation_preferences(
            &mut thread,
            None,
            implementation_model,
            implementation_reasoning_effort,
        );
        let _ = apply_openclaw_dispatcher_config(&mut thread, &openclaw_config);
        touch_acp_dispatcher_heartbeat(&mut thread);

        let artifacts = self
            .ensure_acp_dispatcher_artifacts(project_id, &thread_id, &project.default_branch)
            .await?;
        thread.metadata.insert(
            "acpProjectMemoryPath".to_string(),
            artifacts.project_memory_display,
        );
        thread.metadata.insert(
            "acpSessionMemoryPath".to_string(),
            artifacts.session_memory_display,
        );
        thread
            .metadata
            .insert("acpBoardPath".to_string(), artifacts.board_display);
        update_dispatcher_active_skills_metadata(&mut thread, &[]);

        self.replace_dispatcher_thread(thread.clone()).await?;
        // The initial artifact write already materializes the ACP memory files for this thread.
        // Avoid immediately rewriting the same files again on the creation path.
        Ok(thread)
    }

    pub(crate) async fn update_dispatcher_integration_binding(
        self: &Arc<Self>,
        thread_id: &str,
        openclaw_thread_id: Option<Option<String>>,
        openclaw_session_id: Option<Option<String>>,
    ) -> Result<SessionRecord> {
        let mut thread = self
            .get_dispatcher_thread(thread_id)
            .await
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        apply_openclaw_binding_field(&mut thread, "openclawThreadId", openclaw_thread_id);
        apply_openclaw_binding_field(&mut thread, "openclawSessionId", openclaw_session_id);

        thread.last_activity_at = Utc::now().to_rfc3339();
        self.replace_dispatcher_thread(thread.clone()).await?;
        self.sync_acp_dispatcher_state(&thread).await?;
        Ok(thread)
    }

    pub(crate) async fn update_dispatcher_preferences(
        self: &Arc<Self>,
        thread_id: &str,
        patch: DispatcherPreferencesPatch,
    ) -> Result<SessionRecord> {
        let mut thread = self
            .get_dispatcher_thread(thread_id)
            .await
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        let DispatcherPreferencesPatch {
            dispatcher_agent,
            dispatcher_model,
            dispatcher_reasoning_effort,
            implementation_agent,
            implementation_model,
            implementation_reasoning_effort,
            openclaw_config,
        } = patch;

        let current_dispatcher_agent = thread.agent.trim().to_ascii_lowercase();
        let target_dispatcher_agent = dispatcher_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(|| current_dispatcher_agent.clone());
        if !matches!(
            target_dispatcher_agent.as_str(),
            "codex" | "claude-code" | "gemini" | "openclaw"
        ) {
            return Err(anyhow!(
                "Unsupported dispatcher agent `{target_dispatcher_agent}`. Expected codex, claude-code, gemini, or openclaw"
            ));
        }

        let requested_dispatcher_model = dispatcher_model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(model) = requested_dispatcher_model.as_deref() {
            if !dispatcher_runtime_model_supported_for_agent(&target_dispatcher_agent, model) {
                return Err(anyhow!(
                    "Unsupported dispatcher model `{model}` for agent `{target_dispatcher_agent}`"
                ));
            }
        }
        let next_dispatcher_model = requested_dispatcher_model.or_else(|| {
            thread.model.as_ref().and_then(|value| {
                dispatcher_runtime_model_supported_for_agent(&target_dispatcher_agent, value)
                    .then(|| value.clone())
            })
        });

        let requested_dispatcher_reasoning = dispatcher_reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
        if let Some(reasoning_effort) = requested_dispatcher_reasoning.as_deref() {
            if !dispatcher_runtime_reasoning_supported_for_agent(
                &target_dispatcher_agent,
                next_dispatcher_model.as_deref(),
                reasoning_effort,
            ) {
                return Err(anyhow!(
                    "Unsupported dispatcher reasoning effort `{reasoning_effort}` for agent `{target_dispatcher_agent}`"
                ));
            }
        }
        let next_dispatcher_reasoning = requested_dispatcher_reasoning.or_else(|| {
            thread.reasoning_effort.as_ref().and_then(|value| {
                dispatcher_runtime_reasoning_supported_for_agent(
                    &target_dispatcher_agent,
                    next_dispatcher_model.as_deref(),
                    value,
                )
                .then(|| value.clone())
            })
        });

        let target_implementation_agent = implementation_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| dispatcher_preferred_implementation_agent(&thread));
        if !matches!(
            target_implementation_agent.as_str(),
            "codex" | "claude-code" | "gemini" | "openclaw" | "cursor-cli"
        ) {
            return Err(anyhow!(
                "Unsupported implementation agent `{target_implementation_agent}`. Expected codex, claude-code, gemini, openclaw, or cursor-cli"
            ));
        }
        let target_implementation_model = resolve_dispatcher_implementation_model(
            &thread,
            &target_implementation_agent,
            implementation_model.as_deref(),
        );
        if let Some(model) = implementation_model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !dispatcher_model_supported_for_agent(&target_implementation_agent, model) {
                return Err(anyhow!(
                    "Unsupported implementation model `{model}` for agent `{target_implementation_agent}`"
                ));
            }
        }
        if let Some(reasoning_effort) = implementation_reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !dispatcher_reasoning_supported_for_agent(
                &target_implementation_agent,
                target_implementation_model.as_deref(),
                reasoning_effort,
            ) {
                return Err(anyhow!(
                    "Unsupported implementation reasoning effort `{reasoning_effort}` for agent `{target_implementation_agent}`"
                ));
            }
        }

        let runtime_changed = thread.agent != target_dispatcher_agent
            || thread.model != next_dispatcher_model
            || thread.reasoning_effort != next_dispatcher_reasoning;
        if runtime_changed {
            thread.agent = target_dispatcher_agent.clone();
            thread.model = next_dispatcher_model.clone();
            thread.reasoning_effort = next_dispatcher_reasoning.clone();
            thread
                .metadata
                .insert("agent".to_string(), target_dispatcher_agent.clone());
            match next_dispatcher_model.as_ref() {
                Some(value) => {
                    thread.metadata.insert("model".to_string(), value.clone());
                }
                None => {
                    thread.metadata.remove("model");
                }
            }
            match next_dispatcher_reasoning.as_ref() {
                Some(value) => {
                    thread
                        .metadata
                        .insert("reasoningEffort".to_string(), value.clone());
                }
                None => {
                    thread.metadata.remove("reasoningEffort");
                }
            }
        }

        let implementation_changed = apply_dispatcher_implementation_preferences(
            &mut thread,
            implementation_agent,
            implementation_model,
            implementation_reasoning_effort,
        );
        let openclaw_changed = apply_openclaw_dispatcher_config(&mut thread, &openclaw_config);
        if !runtime_changed && !implementation_changed && !openclaw_changed {
            return Ok(thread);
        }

        thread.last_activity_at = Utc::now().to_rfc3339();
        self.replace_dispatcher_thread(thread.clone()).await?;
        self.sync_acp_dispatcher_state(&thread).await?;
        if runtime_changed && self.dispatcher_runtime_attached(thread_id).await {
            let _ = self.interrupt_dispatcher(thread_id).await;
            self.clear_dispatcher_runtime(thread_id).await;
        }
        Ok(thread)
    }

    pub(crate) async fn update_dispatcher_runtime_preferences(
        self: &Arc<Self>,
        thread_id: &str,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<SessionRecord> {
        let mut thread = self
            .get_dispatcher_thread(thread_id)
            .await
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        let dispatcher_agent = thread.agent.trim().to_ascii_lowercase();
        let target_model = model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| thread.model.clone());
        if let Some(model_value) = model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !dispatcher_runtime_model_supported_for_agent(&dispatcher_agent, model_value) {
                return Err(anyhow!(
                    "Unsupported dispatcher model `{model_value}` for agent `{dispatcher_agent}`"
                ));
            }
        }
        if let Some(reasoning_value) = reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !dispatcher_runtime_reasoning_supported_for_agent(
                &dispatcher_agent,
                target_model.as_deref(),
                reasoning_value,
            ) {
                return Err(anyhow!(
                    "Unsupported dispatcher reasoning effort `{reasoning_value}` for agent `{dispatcher_agent}`"
                ));
            }
        }

        let next_model = model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let next_reasoning = reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
        let next_model = next_model.or_else(|| thread.model.clone());
        let next_reasoning = next_reasoning.or_else(|| thread.reasoning_effort.clone());
        if thread.model == next_model && thread.reasoning_effort == next_reasoning {
            return Ok(thread);
        }

        let implementation_agent = dispatcher_preferred_implementation_agent(&thread);
        thread.model = next_model.clone();
        thread.reasoning_effort = next_reasoning.clone();
        match next_model {
            Some(value) => {
                thread.metadata.insert("model".to_string(), value);
            }
            None => {
                thread.metadata.remove("model");
            }
        }
        match next_reasoning {
            Some(value) => {
                thread.metadata.insert("reasoningEffort".to_string(), value);
            }
            None => {
                thread.metadata.remove("reasoningEffort");
            }
        }
        if implementation_agent == dispatcher_agent {
            if let Some(value) = thread.model.clone() {
                thread
                    .metadata
                    .insert(ACP_IMPLEMENTATION_MODEL_METADATA_KEY.to_string(), value);
            } else {
                thread
                    .metadata
                    .remove(ACP_IMPLEMENTATION_MODEL_METADATA_KEY);
            }
            if let Some(value) = thread.reasoning_effort.clone() {
                thread
                    .metadata
                    .insert(ACP_IMPLEMENTATION_REASONING_METADATA_KEY.to_string(), value);
            } else {
                thread
                    .metadata
                    .remove(ACP_IMPLEMENTATION_REASONING_METADATA_KEY);
            }
        }
        thread.last_activity_at = Utc::now().to_rfc3339();
        self.replace_dispatcher_thread(thread.clone()).await?;
        self.sync_acp_dispatcher_state(&thread).await?;
        Ok(thread)
    }

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
        self.acp_project_dir(project_id)
            .join(format!("{session_id}-session.json"))
    }

    fn acp_session_memory_markdown_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.acp_project_dir(project_id)
            .join(format!("{session_id}-session.md"))
    }

    pub(crate) async fn ensure_acp_dispatcher_artifacts(
        &self,
        project_id: &str,
        session_id: &str,
        default_branch: &str,
    ) -> Result<AcpDispatcherArtifacts> {
        let config = self.config.read().await.clone();
        let Some(project) = config.projects.get(project_id) else {
            return Err(anyhow!("Unknown project: {project_id}"));
        };
        let repo_path = self.resolve_project_path(project);
        let repo_board = repo_path.join("CONDUCTOR.md");
        let board_path = if repo_board.exists() && !repo_board.starts_with(&self.workspace_path) {
            repo_board
        } else {
            let board_dir = project
                .board_dir
                .clone()
                .unwrap_or_else(|| project_id.to_string());
            let board_relative =
                resolve_board_file(&self.workspace_path, &board_dir, Some(&project.path));
            self.workspace_path.join(board_relative)
        };
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
                .map(|item| {
                    format!(
                        "[{}] {} {}: {}",
                        item.timestamp, item.source, item.action, item.detail
                    )
                })
                .collect(),
            long_term_memory_path: project_memory_display.clone(),
            updated_at: now,
        };
        let project_memory_markdown = render_project_memory_markdown(&project_memory);
        let session_memory_markdown = render_session_memory_markdown(&session_memory);
        tokio::try_join!(
            write_json(&project_json, &project_memory),
            write_text(&project_md, project_memory_markdown),
            write_json(&session_json, &session_memory),
            write_text(&session_md, session_memory_markdown),
        )?;

        Ok(AcpDispatcherArtifacts {
            project_memory_display,
            session_memory_display,
            board_display,
        })
    }

    pub(crate) async fn sync_acp_dispatcher_state(&self, session: &SessionRecord) -> Result<()> {
        if !is_acp_dispatcher_thread(session) {
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
            .map(|item| {
                format!(
                    "[{}] {} {}: {}",
                    item.timestamp, item.source, item.action, item.detail
                )
            })
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
        let session_memory_markdown = render_session_memory_markdown(&session_memory);
        let project_memory_markdown = read_json::<AcpProjectMemoryState>(&project_json)
            .await
            .map(|project_memory| render_project_memory_markdown(&project_memory));
        match project_memory_markdown {
            Some(project_memory_markdown) => {
                tokio::try_join!(
                    write_json(&session_json, &session_memory),
                    write_text(&session_md, session_memory_markdown),
                    write_text(&project_md, project_memory_markdown),
                )?;
            }
            None => {
                tokio::try_join!(
                    write_json(&session_json, &session_memory),
                    write_text(&session_md, session_memory_markdown),
                )?;
            }
        }

        Ok(())
    }

    pub(crate) async fn record_acp_dispatcher_turn(
        &self,
        session: &SessionRecord,
        message: &str,
        attachments: &[String],
    ) -> Result<()> {
        if !is_acp_dispatcher_thread(session) {
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

    pub(crate) async fn dispatcher_runtime_attached(&self, thread_id: &str) -> bool {
        let mut runtimes = self.dispatcher_runtimes.lock().await;
        match runtimes.get(thread_id) {
            Some(handle) if handle.accepts_input && handle.input_tx.is_closed() => {
                runtimes.remove(thread_id);
                false
            }
            Some(_) => true,
            None => false,
        }
    }

    async fn dispatcher_runtime_handle(&self, thread_id: &str) -> Option<DispatcherRuntimeHandle> {
        self.dispatcher_runtimes
            .lock()
            .await
            .get(thread_id)
            .cloned()
    }

    async fn dispatcher_runtime_input(&self, thread_id: &str) -> Option<DispatcherRuntimeHandle> {
        let mut runtimes = self.dispatcher_runtimes.lock().await;
        match runtimes.get(thread_id) {
            Some(handle) if !handle.accepts_input => None,
            Some(handle) if handle.input_tx.is_closed() => {
                runtimes.remove(thread_id);
                None
            }
            Some(handle) => Some(handle.clone()),
            None => None,
        }
    }

    async fn dispatcher_prompt_with_context(
        &self,
        thread: &SessionRecord,
        prompt: &str,
        attachments: &[String],
    ) -> String {
        if attachments.is_empty() {
            return prompt.to_string();
        }

        let config = self.config.read().await.clone();
        let Some(project) = config.projects.get(&thread.project_id) else {
            return prompt.to_string();
        };

        let allowed_roots = attachment_allowed_roots(
            self,
            &thread.project_id,
            project,
            &config.preferences.markdown_editor,
            &config.preferences.markdown_editor_path,
        );
        let sections = attachment_context_sections(self, attachments, &allowed_roots);
        append_dispatcher_context_sections(prompt, &sections)
    }

    async fn store_dispatcher_runtime(
        &self,
        thread_id: &str,
        input_tx: mpsc::Sender<ExecutorInput>,
        accepts_input: bool,
        kill_tx: oneshot::Sender<()>,
    ) -> DispatcherRuntimeHandle {
        let handle = DispatcherRuntimeHandle {
            runtime_id: Uuid::new_v4().to_string(),
            input_tx,
            accepts_input,
            kill_tx: Arc::new(Mutex::new(Some(kill_tx))),
        };
        self.dispatcher_runtimes
            .lock()
            .await
            .insert(thread_id.to_string(), handle.clone());
        handle
    }

    async fn clear_dispatcher_runtime(&self, thread_id: &str) {
        self.dispatcher_runtimes.lock().await.remove(thread_id);
    }

    async fn clear_dispatcher_runtime_if(&self, thread_id: &str, runtime_id: &str) {
        let mut runtimes = self.dispatcher_runtimes.lock().await;
        if runtimes
            .get(thread_id)
            .map(|handle| handle.runtime_id == runtime_id)
            .unwrap_or(false)
        {
            runtimes.remove(thread_id);
        }
    }

    pub(crate) async fn interrupt_dispatcher(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        let handle = self
            .dispatcher_runtime_handle(thread_id)
            .await
            .ok_or_else(|| anyhow!("Dispatcher {thread_id} is not running"))?;
        let mut kill_tx = handle.kill_tx.lock().await;
        let Some(kill_tx) = kill_tx.take() else {
            return Err(anyhow!("Dispatcher {thread_id} is not running"));
        };
        let _ = kill_tx.send(());
        Ok(())
    }

    async fn ensure_dispatcher_runtime(
        self: &Arc<Self>,
        thread: &SessionRecord,
        initial_message: &str,
        attachments: &[String],
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<()> {
        if self.dispatcher_runtime_attached(&thread.id).await {
            return Ok(());
        }

        let config = self.config.read().await.clone();
        let project = config
            .projects
            .get(&thread.project_id)
            .cloned()
            .with_context(|| format!("Unknown project: {}", thread.project_id))?;
        let agent_kind = AgentKind::parse(&thread.agent);
        let executors = self.executors.read().await;
        let executor = executors
            .get(&agent_kind)
            .cloned()
            .with_context(|| format!("Executor '{}' is not available", thread.agent))?;
        drop(executors);

        let mut spawn_env = HashMap::new();
        spawn_env.insert("CONDUCTOR_SESSION_ID".to_string(), thread.id.clone());
        spawn_env.insert(
            "CONDUCTOR_PROJECT_ID".to_string(),
            thread.project_id.clone(),
        );
        spawn_env.insert(
            "CONDUCTOR_SESSION_KIND".to_string(),
            ACP_SESSION_KIND.to_string(),
        );
        if executor.kind() == AgentKind::ClaudeCode {
            spawn_env.insert("CLAUDECODE".to_string(), String::new());
            spawn_env.insert("ANTHROPIC_API_KEY".to_string(), String::new());
        }
        if executor.kind() == AgentKind::OpenClaw {
            if let Some(gateway_url) = thread
                .metadata
                .get(OPENCLAW_GATEWAY_URL_METADATA_KEY)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spawn_env.insert("OPENCLAW_GATEWAY_URL".to_string(), gateway_url.to_string());
            }
            if let Some(gateway_token) = thread
                .metadata
                .get(OPENCLAW_GATEWAY_TOKEN_METADATA_KEY)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spawn_env.insert(
                    "OPENCLAW_GATEWAY_TOKEN".to_string(),
                    gateway_token.to_string(),
                );
            }
            if let Some(gateway_scopes) = thread
                .metadata
                .get(OPENCLAW_GATEWAY_SCOPES_METADATA_KEY)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spawn_env.insert(
                    "OPENCLAW_GATEWAY_SCOPES".to_string(),
                    gateway_scopes.to_string(),
                );
            }
            if let Some(session_key) = thread
                .metadata
                .get(OPENCLAW_SESSION_KEY_METADATA_KEY)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                spawn_env.insert("OPENCLAW_SESSION_KEY".to_string(), session_key.to_string());
            }
            apply_openclaw_runtime_env(&mut spawn_env);
        }
        prepare_dispatcher_runtime_env(&mut spawn_env);
        let spawn_env = build_runtime_env(executor.binary_path(), &spawn_env);
        let session_mcp_servers = deserialize_mcp_servers(
            thread
                .metadata
                .get(ACP_SESSION_MCP_SERVERS_METADATA_KEY)
                .map(String::as_str),
        )
        .unwrap_or_default();
        let extra_args = match executor.kind() {
            AgentKind::Codex | AgentKind::QwenCode => self.codex_mcp_extra_args(
                &config,
                &project,
                &thread.id,
                &thread.project_id,
                Some(ACP_SESSION_KIND),
                &session_mcp_servers,
            ),
            AgentKind::ClaudeCode => self.claude_mcp_extra_args(
                &config,
                &project,
                &thread.id,
                &thread.project_id,
                Some(ACP_SESSION_KIND),
                &session_mcp_servers,
            ),
            _ => Vec::new(),
        };
        let use_headless_turns = dispatcher_uses_headless_turns(&executor.kind());
        let structured_output = if use_headless_turns {
            true
        } else {
            dispatcher_supports_interactive_structured_output(&executor.kind())
        };
        let resume_target = dispatcher_resume_target(thread, &executor.kind());

        let prompt = self
            .dispatcher_prompt_with_context(
                thread,
                &merge_dispatcher_prompt_with_user(&thread.prompt, initial_message),
                attachments,
            )
            .await;
        let handle = executor
            .spawn(SpawnOptions {
                cwd: PathBuf::from(
                    thread
                        .metadata
                        .get("agentCwd")
                        .cloned()
                        .or_else(|| thread.workspace_path.clone())
                        .unwrap_or_else(|| ".".to_string()),
                ),
                prompt,
                model,
                reasoning_effort,
                skip_permissions: true,
                extra_args,
                env: spawn_env,
                branch: None,
                timeout: project
                    .agent_config
                    .session_timeout_secs
                    .map(std::time::Duration::from_secs),
                interactive: !use_headless_turns,
                structured_output,
                resume_target,
            })
            .await?;

        let (pid, _kind, output_rx, input_tx, terminal_rx, _resize_tx, kill_tx) =
            handle.into_parts();
        let runtime_handle = self
            .store_dispatcher_runtime(&thread.id, input_tx.clone(), !use_headless_turns, kill_tx)
            .await;

        if let Some(mut terminal_rx) = terminal_rx {
            tokio::spawn(async move { while terminal_rx.recv().await.is_some() {} });
        }

        {
            let mut threads = self.dispatcher_threads.write().await;
            if let Some(current) = threads.get_mut(&thread.id) {
                current.pid = Some(pid);
                current
                    .metadata
                    .insert("startedAt".to_string(), Utc::now().to_rfc3339());
            }
        }
        if let Some(updated) = self.get_dispatcher_thread(&thread.id).await {
            self.persist_dispatcher_thread(&updated).await?;
            self.publish_dispatcher_update(&thread.id).await;
        }

        self.start_dispatcher_output_consumer(
            thread.id.clone(),
            runtime_handle.runtime_id.clone(),
            output_rx,
        );
        Ok(())
    }

    fn start_dispatcher_output_consumer(
        self: &Arc<Self>,
        thread_id: String,
        runtime_id: String,
        mut output_rx: mpsc::Receiver<ExecutorOutput>,
    ) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = output_rx.recv().await {
                let _ = state
                    .apply_dispatcher_runtime_event(&thread_id, &runtime_id, event)
                    .await;
            }
        });
    }

    async fn apply_dispatcher_runtime_event(
        &self,
        thread_id: &str,
        runtime_id: &str,
        event: ExecutorOutput,
    ) -> Result<()> {
        let force_memory_sync = matches!(
            &event,
            ExecutorOutput::NeedsInput(_)
                | ExecutorOutput::Completed { .. }
                | ExecutorOutput::Failed { .. }
        );
        let clear_runtime = matches!(
            event,
            ExecutorOutput::Completed { .. } | ExecutorOutput::Failed { .. }
        );
        let mut threads = self.dispatcher_threads.write().await;
        let Some(thread) = threads.get_mut(thread_id) else {
            drop(threads);
            if clear_runtime {
                self.clear_dispatcher_runtime_if(thread_id, runtime_id)
                    .await;
            }
            return Ok(());
        };
        if thread.status.is_terminal() {
            drop(threads);
            if clear_runtime {
                self.clear_dispatcher_runtime_if(thread_id, runtime_id)
                    .await;
            }
            return Ok(());
        }

        let mut feed_dirty = false;
        let previous_status = thread.status.clone();
        let parser_state_before = parser_state_signature(thread);

        if let Some(line) = persisted_output_line(&event) {
            let was_empty = thread.output.is_empty();
            append_output(&mut thread.output, &line);
            if was_empty {
                feed_dirty = true;
            }
        }
        thread.last_activity_at = Utc::now().to_rfc3339();
        touch_acp_dispatcher_heartbeat(thread);

        match event {
            ExecutorOutput::Stdout(line) => {
                if apply_dispatcher_stdout_event(thread, &line) {
                    feed_dirty = true;
                }
            }
            ExecutorOutput::Stderr(line) => {
                let trimmed = line.trim();
                if detect_parser_state(thread, trimmed) {
                    if append_runtime_status_entry(thread, trimmed) {
                        feed_dirty = true;
                    }
                    thread.summary = Some(trimmed.to_string());
                    thread
                        .metadata
                        .insert("summary".to_string(), trimmed.to_string());
                }
                thread.metadata.insert("lastStderr".to_string(), line);
            }
            ExecutorOutput::StructuredStatus { text, metadata } => {
                if let Some(resume_target) = metadata
                    .get("nativeResumeTarget")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        metadata
                            .get("codexThreadId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                    })
                {
                    thread.metadata.insert(
                        ACP_RESUME_TARGET_METADATA_KEY.to_string(),
                        resume_target.to_string(),
                    );
                }
                if metadata
                    .get("codexThreadId")
                    .and_then(Value::as_str)
                    .is_some()
                {
                    thread.metadata.insert(
                        "codexThreadId".to_string(),
                        metadata
                            .get("codexThreadId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    );
                }
                if !thread.status.is_terminal() {
                    if thread.status != SessionStatus::Working {
                        thread.status = SessionStatus::Working;
                        feed_dirty = true;
                    }
                    thread.activity = Some("active".to_string());
                }
                let is_thread_started =
                    metadata.get("eventKind").and_then(Value::as_str) == Some("thread_started");
                if !is_thread_started
                    && append_runtime_status_entry_with_metadata(thread, &text, Some(metadata))
                {
                    feed_dirty = true;
                }
            }
            ExecutorOutput::NeedsInput(prompt) => {
                if thread.status != SessionStatus::NeedsInput {
                    thread.status = SessionStatus::NeedsInput;
                    feed_dirty = true;
                }
                thread.activity = Some("waiting_input".to_string());
                thread.summary = Some(prompt.clone());
                thread
                    .metadata
                    .insert("summary".to_string(), prompt.clone());
                if append_runtime_status_entry(thread, &prompt) {
                    feed_dirty = true;
                }
                if !detect_parser_state(thread, &prompt) {
                    feed_dirty |= set_parser_state(thread, "needs_input", &prompt, None);
                }
            }
            ExecutorOutput::Completed { exit_code } => {
                if clear_parser_state(thread) {
                    feed_dirty = true;
                }
                thread
                    .metadata
                    .insert("exitCode".to_string(), exit_code.to_string());
                if exit_code == 0 {
                    if thread.status != SessionStatus::NeedsInput {
                        thread.status = SessionStatus::NeedsInput;
                        feed_dirty = true;
                    }
                    thread.activity = Some("waiting_input".to_string());
                    thread
                        .metadata
                        .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                    if thread
                        .summary
                        .as_ref()
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        thread.summary = Some("Ready for follow-up".to_string());
                        thread
                            .metadata
                            .insert("summary".to_string(), "Ready for follow-up".to_string());
                    }
                } else {
                    if thread.status != SessionStatus::Errored {
                        thread.status = SessionStatus::Errored;
                        feed_dirty = true;
                    }
                    thread.activity = Some("exited".to_string());
                    thread
                        .metadata
                        .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                    let summary = thread
                        .summary
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| {
                            thread
                                .metadata
                                .get("lastStderr")
                                .cloned()
                                .filter(|value| !value.trim().is_empty())
                        })
                        .unwrap_or_else(|| format!("Process exited with code {exit_code}"));
                    thread.summary = Some(summary.clone());
                    thread.metadata.insert("summary".to_string(), summary);
                }
            }
            ExecutorOutput::Failed { error, exit_code } => {
                let parser_state_detected = detect_parser_state(thread, &error);
                let requested_kill = error == "killed";
                let summary = if requested_kill {
                    "Interrupted".to_string()
                } else {
                    error.clone()
                };
                thread.status = if requested_kill {
                    SessionStatus::Killed
                } else {
                    SessionStatus::Errored
                };
                thread.activity = Some("exited".to_string());
                thread
                    .metadata
                    .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                thread.summary = Some(summary.clone());
                thread.metadata.insert("summary".to_string(), summary);
                if let Some(code) = exit_code {
                    thread
                        .metadata
                        .insert("exitCode".to_string(), code.to_string());
                }
                if !parser_state_detected && requested_kill && clear_parser_state(thread) {
                    feed_dirty = true;
                }
            }
            ExecutorOutput::Composite(_) => {}
        }

        if thread.status != previous_status {
            feed_dirty = true;
        }
        if parser_state_signature(thread) != parser_state_before {
            feed_dirty = true;
        }

        let should_sync_memory = should_sync_dispatcher_session_memory(thread, force_memory_sync);
        let updated = thread.clone();
        drop(threads);
        if clear_runtime {
            self.clear_dispatcher_runtime_if(thread_id, runtime_id)
                .await;
        }
        self.persist_dispatcher_thread(&updated).await?;
        if should_sync_memory {
            self.sync_acp_dispatcher_state(&updated).await?;
        }
        if feed_dirty {
            self.publish_dispatcher_update(thread_id).await;
        }
        Ok(())
    }

    pub(crate) async fn send_to_dispatcher_thread(
        self: &Arc<Self>,
        thread_id: &str,
        request: DispatcherTurnRequest,
    ) -> Result<()> {
        let DispatcherTurnRequest {
            message,
            runtime_message,
            source,
            entry_id,
            recorded_attachments,
            runtime_attachments,
            runtime_context,
            model,
            reasoning_effort,
            metadata,
        } = request;
        let uses_headless_turns = self
            .get_dispatcher_thread(thread_id)
            .await
            .map(|thread| dispatcher_uses_headless_turns(&AgentKind::parse(&thread.agent)))
            .unwrap_or(false);
        if uses_headless_turns && self.dispatcher_runtime_attached(thread_id).await {
            return Err(anyhow!(
                "Dispatcher is already working on the current turn. Wait for it to finish or interrupt it first."
            ));
        }

        let active_skills = self
            .active_session_skills
            .lock()
            .await
            .get(thread_id)
            .cloned()
            .unwrap_or_default();

        let mut threads = self.dispatcher_threads.write().await;
        let thread = threads
            .get_mut(thread_id)
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        clear_parser_state(thread);
        thread.last_activity_at = Utc::now().to_rfc3339();
        thread.status = SessionStatus::Working;
        thread.activity = Some("active".to_string());
        touch_acp_dispatcher_heartbeat(thread);
        let effective_attachments =
            merge_dispatcher_context_attachments(thread, &runtime_attachments);

        let preferred_implementation_agent = dispatcher_preferred_implementation_agent(thread);
        let preferred_implementation_model = dispatcher_preferred_implementation_model(thread);
        let preferred_implementation_reasoning =
            dispatcher_preferred_implementation_reasoning_effort(thread);
        update_dispatcher_active_skills_metadata(thread, &active_skills);
        let allow_board_mutations = acp_dispatcher_turn_allows_board_mutations(&message);
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            if allow_board_mutations {
                ACP_APPROVAL_GRANTED.to_string()
            } else {
                ACP_APPROVAL_REQUIRED.to_string()
            },
        );
        let runtime_input_message = runtime_message.as_deref().unwrap_or(&message);
        let mut runtime_message = format!(
            "{}\n\n{}\n\n{}",
            acp_dispatcher_turn_prefix(allow_board_mutations),
            acp_dispatcher_preference_note(
                &preferred_implementation_agent,
                preferred_implementation_model.as_deref(),
                preferred_implementation_reasoning.as_deref(),
            ),
            rewrite_acp_dispatcher_command(runtime_input_message)
        );
        if let Some(runtime_context) = runtime_context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            runtime_message.push_str("\n\n");
            runtime_message.push_str(runtime_context);
        }

        if let Some(model_value) = model.clone() {
            thread.model = Some(model_value.clone());
            thread.metadata.insert("model".to_string(), model_value);
        }
        if let Some(reasoning) = reasoning_effort.clone() {
            thread.reasoning_effort = Some(reasoning.clone());
            thread
                .metadata
                .insert("reasoningEffort".to_string(), reasoning);
        }
        thread.conversation.push(ConversationEntry {
            id: entry_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            kind: "user_message".to_string(),
            source,
            text: message.clone(),
            created_at: Utc::now().to_rfc3339(),
            attachments: recorded_attachments.clone(),
            metadata,
        });
        enforce_conversation_limit(thread);
        let updated = thread.clone();
        drop(threads);

        self.persist_dispatcher_thread(&updated).await?;
        self.publish_dispatcher_update(thread_id).await;

        let runtime_prompt = self
            .dispatcher_prompt_with_context(&updated, &runtime_message, &effective_attachments)
            .await;

        if !uses_headless_turns {
            if let Some(runtime_handle) = self.dispatcher_runtime_input(thread_id).await {
                if let Err(err) = runtime_handle
                    .input_tx
                    .send(ExecutorInput::Text(runtime_prompt))
                    .await
                {
                    tracing::warn!(
                        thread_id = %thread_id,
                        error = %err,
                        "dispatcher runtime input channel closed, restarting runtime"
                    );
                    self.clear_dispatcher_runtime_if(thread_id, &runtime_handle.runtime_id)
                        .await;
                    self.ensure_dispatcher_runtime(
                        &updated,
                        &runtime_message,
                        &effective_attachments,
                        model.or_else(|| updated.model.clone()),
                        reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
                    )
                    .await?;
                }
            } else {
                self.ensure_dispatcher_runtime(
                    &updated,
                    &runtime_message,
                    &effective_attachments,
                    model.or_else(|| updated.model.clone()),
                    reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
                )
                .await?;
            }
        } else {
            self.ensure_dispatcher_runtime(
                &updated,
                &runtime_message,
                &effective_attachments,
                model.or_else(|| updated.model.clone()),
                reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
            )
            .await?;
        }

        if let Err(err) = self
            .record_acp_dispatcher_turn(&updated, &message, &recorded_attachments)
            .await
        {
            tracing::warn!(
                session_id = %updated.id,
                error = %err,
                "failed to record ACP dispatcher turn"
            );
        }
        Ok(())
    }

    pub(crate) async fn maintain_acp_dispatchers(&self) {
        let now = Utc::now();
        let due_sessions = {
            let sessions = self.dispatcher_threads.read().await;
            sessions
                .values()
                .filter(|session| is_acp_dispatcher_thread(session))
                .filter(|session| session.status != SessionStatus::Archived)
                .filter(|session| heartbeat_due_eligible(session))
                .filter_map(|session| {
                    let (_, next, state) = heartbeat_times(session);
                    (state != "due" && now >= next).then_some(session.id.clone())
                })
                .collect::<Vec<_>>()
        };

        for session_id in due_sessions {
            let updated = {
                let mut sessions = self.dispatcher_threads.write().await;
                let Some(session) = sessions.get_mut(&session_id) else {
                    continue;
                };
                if !is_acp_dispatcher_thread(session) || session.status == SessionStatus::Archived {
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
                    id: Uuid::new_v4().to_string(),
                    kind: "system_message".to_string(),
                    source: "acp_heartbeat".to_string(),
                    text: "ACP heartbeat due. Review board state, blockers, deferred follow-ups, and which tasks should be shaped or handed off next.".to_string(),
                    created_at: now.to_rfc3339(),
                    attachments: Vec::new(),
                    metadata: HashMap::new(),
                });
                enforce_conversation_limit(session);
                session.clone()
            };

            if let Err(err) = self.persist_dispatcher_thread(&updated).await {
                tracing::warn!(session_id = %session_id, error = %err, "failed to persist ACP heartbeat");
                continue;
            }
            if let Err(err) = self.sync_acp_dispatcher_state(&updated).await {
                tracing::warn!(session_id = %session_id, error = %err, "failed to sync ACP heartbeat state");
            }
            if heartbeat_can_prompt_live_runtime(&updated) {
                if let Some(runtime_handle) = self.dispatcher_runtime_input(&session_id).await {
                    if let Err(err) = runtime_handle
                        .input_tx
                        .send(ExecutorInput::Text(
                            "ACP heartbeat due. Review board state, blockers, deferred follow-ups, and which tasks should be shaped or handed off next.".to_string(),
                        ))
                        .await
                    {
                        tracing::warn!(session_id = %session_id, error = %err, "failed to deliver ACP heartbeat prompt");
                    }
                }
            }
            self.publish_dispatcher_update(&session_id).await;
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

#[cfg(test)]
mod tests {
    use super::{
        build_acp_dispatcher_prompt, codex_runtime_model_entry,
        codex_runtime_reasoning_supported_in_cache, dispatcher_context_attachment_paths,
        dispatcher_model_supported_for_agent, dispatcher_resume_target,
        dispatcher_supports_interactive_structured_output, dispatcher_uses_headless_turns,
        merge_dispatcher_context_attachments, normalize_loaded_dispatcher_thread,
        prepare_dispatcher_runtime_env, read_json, AcpSessionMemoryState, AppState,
        CreateDispatcherThreadOptions, DispatcherPreferencesPatch, OpenClawDispatcherConfigPatch,
        ACP_APPROVAL_GRANTED, ACP_APPROVAL_REQUIRED, ACP_APPROVAL_STATE_METADATA_KEY,
        ACP_HEARTBEAT_INTERVAL, ACP_IMPLEMENTATION_AGENT_METADATA_KEY,
        ACP_RESUME_TARGET_METADATA_KEY, ACP_SESSION_KIND, OPENCLAW_GATEWAY_SCOPES_METADATA_KEY,
        OPENCLAW_GATEWAY_TOKEN_CONFIGURED_METADATA_KEY, OPENCLAW_GATEWAY_TOKEN_METADATA_KEY,
        OPENCLAW_GATEWAY_URL_METADATA_KEY, OPENCLAW_SESSION_KEY_METADATA_KEY,
    };
    use crate::state::{ConversationEntry, DispatcherTurnRequest, SessionRecord, SessionStatus};
    use anyhow::Result;
    use async_trait::async_trait;
    use chrono::Utc;
    use conductor_core::{
        config::{ConductorConfig, PreferencesConfig, ProjectConfig},
        types::AgentKind,
    };
    use conductor_db::Database;
    use conductor_executors::executor::{Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::timeout;
    use uuid::Uuid;

    #[derive(Clone)]
    struct DelayedHeadlessExecutor {
        assistant_text: String,
        delay: Duration,
    }

    #[async_trait]
    impl Executor for DelayedHeadlessExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "DelayedHeadlessExecutor"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/tmp/delayed-headless-executor")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, _options: SpawnOptions) -> Result<ExecutorHandle> {
            let (output_tx, output_rx) = mpsc::channel(8);
            let (input_tx, _input_rx) = mpsc::channel(1);
            let (kill_tx, mut kill_rx) = oneshot::channel();
            let assistant_text = self.assistant_text.clone();
            let delay = self.delay;

            tokio::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {
                        let _ = output_tx.send(ExecutorOutput::Stdout(assistant_text)).await;
                        let _ = output_tx.send(ExecutorOutput::Completed { exit_code: 0 }).await;
                    }
                    _ = &mut kill_rx => {
                        let _ = output_tx.send(ExecutorOutput::Failed {
                            error: "killed".to_string(),
                            exit_code: None,
                        }).await;
                    }
                }
            });

            Ok(ExecutorHandle::new(
                4242,
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
        (root, state)
    }

    #[test]
    fn prepare_dispatcher_runtime_env_sets_term_defaults() {
        let mut env = HashMap::new();
        prepare_dispatcher_runtime_env(&mut env);
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
    }

    #[test]
    fn prepare_dispatcher_runtime_env_removes_conflicting_color_overrides() {
        let mut env = HashMap::from([
            ("NO_COLOR".to_string(), "1".to_string()),
            ("FORCE_COLOR".to_string(), "1".to_string()),
            ("CLICOLOR_FORCE".to_string(), "1".to_string()),
            ("TERM".to_string(), "screen-256color".to_string()),
        ]);
        prepare_dispatcher_runtime_env(&mut env);
        assert_eq!(env.get("TERM").map(String::as_str), Some("screen-256color"));
        assert!(!env.contains_key("NO_COLOR"));
        assert!(!env.contains_key("FORCE_COLOR"));
        assert!(!env.contains_key("CLICOLOR_FORCE"));
    }

    #[test]
    fn dispatcher_runtime_mode_selection_matches_agent_capabilities() {
        assert!(dispatcher_uses_headless_turns(&AgentKind::Codex));
        assert!(dispatcher_uses_headless_turns(&AgentKind::QwenCode));
        assert!(!dispatcher_uses_headless_turns(&AgentKind::ClaudeCode));

        assert!(dispatcher_supports_interactive_structured_output(
            &AgentKind::ClaudeCode
        ));
        assert!(dispatcher_supports_interactive_structured_output(
            &AgentKind::GithubCopilot
        ));
        assert!(!dispatcher_supports_interactive_structured_output(
            &AgentKind::OpenCode
        ));
    }

    #[test]
    fn headless_dispatchers_rebuild_state_instead_of_reusing_native_resume_targets() {
        let mut thread = SessionRecord::new(
            "session-1".to_string(),
            "demo".to_string(),
            None,
            None,
            None,
            "codex".to_string(),
            None,
            None,
            String::new(),
            None,
        );
        thread.metadata.insert(
            ACP_RESUME_TARGET_METADATA_KEY.to_string(),
            "session-123".to_string(),
        );

        assert_eq!(dispatcher_resume_target(&thread, &AgentKind::Codex), None);
        assert_eq!(
            dispatcher_resume_target(&thread, &AgentKind::QwenCode),
            None
        );
        assert_eq!(
            dispatcher_resume_target(&thread, &AgentKind::ClaudeCode),
            Some("session-123".to_string())
        );
    }

    #[tokio::test]
    async fn dispatcher_prompt_requires_board_inspection_and_launch_ready_packets() {
        let (root, state) = build_test_state("acp-dispatcher-prompt-shaping").await;
        let config = state.config.read().await.clone();
        let project = config
            .projects
            .get("demo")
            .expect("demo project should exist");
        let prompt = build_acp_dispatcher_prompt(
            &state,
            "demo",
            project,
            "Review the dispatcher and shape the next tasks.",
        );

        assert!(prompt.contains("conductor_get_board"));
        assert!(prompt.contains("conductor_dispatcher_create_task"));
        assert!(prompt.contains("conductor_dispatcher_update_task"));
        assert!(prompt.contains("conductor_dispatcher_handoff_task"));
        assert!(prompt.contains("Never edit `CONDUCTOR.md`, `.conductor/tasks/*.md`, or other board projection artifacts directly"));
        assert!(prompt.contains("A dispatcher task-mutation turn is only complete after the relevant MCP task tool succeeds"));
        assert!(prompt.contains("Treat `surfaces` as the task's reference files"));
        assert!(prompt.contains("Treat `skills` as required worker guidance"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn dispatcher_prompt_prefers_external_repo_board_over_workspace_shadow_board() {
        let workspace = std::env::temp_dir().join(format!(
            "acp-dispatcher-external-board-workspace-{}",
            Uuid::new_v4()
        ));
        let external_repo = std::env::temp_dir().join(format!(
            "acp-dispatcher-external-board-repo-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(workspace.join("projects").join("demo")).expect("shadow board dir");
        fs::create_dir_all(&external_repo).expect("external repo");
        fs::write(
            workspace.join("projects").join("demo").join("CONDUCTOR.md"),
            "## Shadow\n",
        )
        .expect("shadow board write");
        fs::write(external_repo.join("CONDUCTOR.md"), "## Repo\n").expect("repo board write");

        let config = ConductorConfig {
            workspace: workspace.clone(),
            preferences: PreferencesConfig {
                coding_agent: "codex".to_string(),
                ..PreferencesConfig::default()
            },
            projects: BTreeMap::from([(
                "demo".to_string(),
                ProjectConfig {
                    path: external_repo.to_string_lossy().to_string(),
                    board_dir: Some("demo".to_string()),
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
        let state = AppState::new(workspace.join("conductor.yaml"), config, db).await;
        let config = state.config.read().await.clone();
        let project = config
            .projects
            .get("demo")
            .expect("demo project should exist");

        let prompt = build_acp_dispatcher_prompt(&state, "demo", project, "");

        assert!(prompt.contains(&format!(
            "- Board path: `{}`",
            external_repo.join("CONDUCTOR.md").to_string_lossy()
        )));
        assert!(!prompt.contains("- Board path: `projects/demo/CONDUCTOR.md`"));

        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&external_repo);
    }

    #[test]
    fn dispatcher_model_support_accepts_forward_compatible_runtime_ids() {
        assert!(dispatcher_model_supported_for_agent(
            "codex",
            "gpt-5.3-codex-spark"
        ));
        assert!(dispatcher_model_supported_for_agent(
            "codex",
            "openai/gpt-5.4"
        ));
        assert!(dispatcher_model_supported_for_agent(
            "claude-code",
            "claude-sonnet-4-7"
        ));
        assert!(dispatcher_model_supported_for_agent(
            "gemini",
            "gemini-3.2-pro"
        ));
        assert!(!dispatcher_model_supported_for_agent(
            "claude-code",
            "gpt-5.4"
        ));
    }

    #[test]
    fn codex_runtime_model_entry_matches_listed_models_only() {
        let cache = json!({
            "models": [
                { "slug": "gpt-5.3-codex-spark", "visibility": "list" },
                { "slug": "gpt-5.3-codex", "visibility": "hidden" }
            ]
        });

        assert!(codex_runtime_model_entry(&cache, "gpt-5.3-codex-spark").is_some());
        assert!(codex_runtime_model_entry(&cache, "Gpt-5.3-Codex-Spark").is_some());
        assert!(codex_runtime_model_entry(&cache, "gpt-5.3-codex").is_none());
    }

    #[test]
    fn codex_runtime_reasoning_supported_reads_per_model_levels() {
        let cache = json!({
            "models": [
                {
                    "slug": "gpt-5.3-codex-spark",
                    "visibility": "list",
                    "supported_reasoning_levels": [
                        { "effort": "medium" },
                        { "effort": "high" }
                    ]
                }
            ]
        });

        assert_eq!(
            codex_runtime_reasoning_supported_in_cache(&cache, "gpt-5.3-codex-spark", "high"),
            Some(true)
        );
        assert_eq!(
            codex_runtime_reasoning_supported_in_cache(&cache, "gpt-5.3-codex-spark", "xhigh"),
            Some(false)
        );
    }

    #[test]
    fn dispatcher_context_attachments_are_runtime_only() {
        let mut thread = SessionRecord::new(
            "dispatcher-test".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/repo".to_string()),
            "codex".to_string(),
            None,
            None,
            "dispatcher prompt".to_string(),
            None,
        );
        thread.status = SessionStatus::Idle;
        thread.metadata.insert(
            "acpProjectMemoryPath".to_string(),
            ".acp/project-memory.md".to_string(),
        );
        thread.metadata.insert(
            "acpSessionMemoryPath".to_string(),
            ".acp/session-memory.md".to_string(),
        );
        thread
            .metadata
            .insert("acpBoardPath".to_string(), "CONDUCTOR.md".to_string());

        assert_eq!(
            dispatcher_context_attachment_paths(&thread),
            vec![
                ".acp/project-memory.md".to_string(),
                ".acp/session-memory.md".to_string(),
                "CONDUCTOR.md".to_string(),
            ]
        );

        let user_attachments = vec!["notes/spec.md".to_string()];
        let effective = merge_dispatcher_context_attachments(&thread, &user_attachments);

        assert_eq!(user_attachments, vec!["notes/spec.md".to_string()]);
        assert_eq!(
            effective,
            vec![
                "notes/spec.md".to_string(),
                ".acp/project-memory.md".to_string(),
                ".acp/session-memory.md".to_string(),
                "CONDUCTOR.md".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_loaded_dispatcher_thread_strips_internal_context_attachments() {
        let mut thread = SessionRecord::new(
            "dispatcher-load-test".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/repo".to_string()),
            "codex".to_string(),
            None,
            None,
            "dispatcher prompt".to_string(),
            None,
        );
        thread.status = SessionStatus::Idle;
        thread
            .metadata
            .insert("sessionKind".to_string(), ACP_SESSION_KIND.to_string());
        thread
            .metadata
            .insert("role".to_string(), "orchestrator".to_string());
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_REQUIRED.to_string(),
        );
        thread.metadata.insert(
            "acpProjectMemoryPath".to_string(),
            ".conductor/rust-backend/acp/demo/project-memory.md".to_string(),
        );
        thread.metadata.insert(
            "acpSessionMemoryPath".to_string(),
            ".conductor/rust-backend/acp/demo/session-memory.md".to_string(),
        );
        thread.metadata.insert(
            "acpBoardPath".to_string(),
            "projects/demo/CONDUCTOR.md".to_string(),
        );
        thread.conversation.push(ConversationEntry {
            id: "user-turn".to_string(),
            kind: "user_message".to_string(),
            source: "dispatcher_ui".to_string(),
            text: "create two tasks".to_string(),
            created_at: Utc::now().to_rfc3339(),
            attachments: vec![
                ".conductor/rust-backend/acp/demo/project-memory.md".to_string(),
                ".conductor/rust-backend/acp/demo/session-memory.md".to_string(),
                ".conductor/rust-backend/acp/demo/generated-context.md".to_string(),
                "projects/demo/CONDUCTOR.md".to_string(),
                "notes/spec.md".to_string(),
            ],
            metadata: HashMap::new(),
        });

        assert!(normalize_loaded_dispatcher_thread(&mut thread));
        assert_eq!(
            thread.conversation[0].attachments,
            vec!["notes/spec.md".to_string()]
        );
    }

    #[test]
    fn normalize_loaded_dispatcher_thread_restores_ready_dispatchers_to_execution_mode() {
        let mut thread = SessionRecord::new(
            "dispatcher-load-approval".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/repo".to_string()),
            "codex".to_string(),
            None,
            None,
            "dispatcher prompt".to_string(),
            None,
        );
        thread.status = SessionStatus::Idle;
        thread.activity = Some("idle".to_string());
        thread.summary = Some("Dispatcher ready".to_string());
        thread
            .metadata
            .insert("sessionKind".to_string(), ACP_SESSION_KIND.to_string());
        thread
            .metadata
            .insert("role".to_string(), "orchestrator".to_string());
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_REQUIRED.to_string(),
        );

        assert!(normalize_loaded_dispatcher_thread(&mut thread));
        assert_eq!(
            thread
                .metadata
                .get(ACP_APPROVAL_STATE_METADATA_KEY)
                .map(String::as_str),
            Some(ACP_APPROVAL_GRANTED)
        );
    }

    #[tokio::test]
    async fn headless_dispatcher_send_returns_before_runtime_finishes() {
        let (root, state) = build_test_state("acp-headless-send-fast").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        state.executors.write().await.insert(
            AgentKind::Codex,
            Arc::new(DelayedHeadlessExecutor {
                assistant_text: "headless assistant reply".to_string(),
                delay: Duration::from_millis(250),
            }),
        );

        timeout(
            Duration::from_millis(100),
            state.send_to_dispatcher_thread(
                &thread.id,
                DispatcherTurnRequest::plain(
                    "Ship the fix".to_string(),
                    Vec::new(),
                    None,
                    None,
                    "chat",
                ),
            ),
        )
        .await
        .expect("headless send should not block on runtime completion")
        .expect("dispatcher send should succeed");

        tokio::time::sleep(Duration::from_millis(350)).await;

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should still exist");
        assert!(updated
            .conversation
            .iter()
            .any(|entry| entry.kind == "assistant_message"
                && entry.text.contains("headless assistant reply")));
        assert_eq!(updated.status, SessionStatus::NeedsInput);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn runtime_events_refresh_session_memory_artifacts() {
        let (root, state) = build_test_state("acp-runtime-memory-sync").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                "runtime-test",
                ExecutorOutput::Stdout("assistant update".to_string()),
            )
            .await
            .expect("runtime event should be applied");

        let session_memory = read_json::<AcpSessionMemoryState>(
            &state.acp_session_memory_json_path("demo", &thread.id),
        )
        .await
        .expect("session memory should exist");
        assert!(session_memory
            .recent_conversation
            .iter()
            .any(|note| note.label == "Assistant" && note.text.contains("assistant update")));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn dispatcher_preferences_sync_runtime_and_implementation_selection() {
        let (root, state) = build_test_state("acp-dispatcher-pref-sync").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        let updated = state
            .update_dispatcher_preferences(
                &thread.id,
                DispatcherPreferencesPatch {
                    dispatcher_agent: Some("openclaw".to_string()),
                    implementation_agent: Some("openclaw".to_string()),
                    openclaw_config: OpenClawDispatcherConfigPatch::default(),
                    ..DispatcherPreferencesPatch::default()
                },
            )
            .await
            .expect("dispatcher preferences should update");

        assert_eq!(updated.agent, "openclaw");
        assert_eq!(updated.model, None);
        assert_eq!(updated.reasoning_effort, None);
        assert_eq!(
            updated
                .metadata
                .get(ACP_IMPLEMENTATION_AGENT_METADATA_KEY)
                .map(String::as_str),
            Some("openclaw")
        );

        let updated = state
            .update_dispatcher_preferences(
                &thread.id,
                DispatcherPreferencesPatch {
                    dispatcher_agent: Some("codex".to_string()),
                    dispatcher_model: Some("gpt-5.4".to_string()),
                    dispatcher_reasoning_effort: Some("high".to_string()),
                    implementation_agent: Some("codex".to_string()),
                    implementation_model: Some("gpt-5.4".to_string()),
                    implementation_reasoning_effort: Some("high".to_string()),
                    openclaw_config: OpenClawDispatcherConfigPatch::default(),
                },
            )
            .await
            .expect("dispatcher runtime should accept codex selections");

        assert_eq!(updated.agent, "codex");
        assert_eq!(updated.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(updated.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            updated.metadata.get("model").map(String::as_str),
            Some("gpt-5.4")
        );
        assert_eq!(
            updated.metadata.get("reasoningEffort").map(String::as_str),
            Some("high")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn dispatcher_preferences_store_openclaw_runtime_config() {
        let (root, state) = build_test_state("acp-openclaw-config").await;
        let gateway_token = ["gateway", "-token-", "123"].concat();
        let session_key = ["paperclip:", "issue", ":123"].concat();
        let thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    openclaw_config: OpenClawDispatcherConfigPatch {
                        gateway_url: Some("ws://127.0.0.1:18789".to_string()),
                        gateway_token: Some(gateway_token.clone()),
                        gateway_scopes: Some("operator.admin".to_string()),
                        session_key: Some(session_key.clone()),
                    },
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should be created");

        assert_eq!(
            thread
                .metadata
                .get(OPENCLAW_GATEWAY_URL_METADATA_KEY)
                .map(String::as_str),
            Some("ws://127.0.0.1:18789")
        );
        assert_eq!(
            thread
                .metadata
                .get(OPENCLAW_GATEWAY_TOKEN_METADATA_KEY)
                .map(String::as_str),
            Some(gateway_token.as_str())
        );
        assert_eq!(
            thread
                .metadata
                .get(OPENCLAW_GATEWAY_TOKEN_CONFIGURED_METADATA_KEY)
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            thread
                .metadata
                .get(OPENCLAW_GATEWAY_SCOPES_METADATA_KEY)
                .map(String::as_str),
            Some("operator.admin")
        );
        assert_eq!(
            thread
                .metadata
                .get(OPENCLAW_SESSION_KEY_METADATA_KEY)
                .map(String::as_str),
            Some(session_key.as_str())
        );

        let updated = state
            .update_dispatcher_preferences(
                &thread.id,
                DispatcherPreferencesPatch {
                    openclaw_config: OpenClawDispatcherConfigPatch {
                        gateway_token: Some(String::new()),
                        gateway_scopes: Some("operator.read,operator.write".to_string()),
                        session_key: Some(
                            "conductor:project_dispatcher:demo:dispatcher-1".to_string(),
                        ),
                        ..OpenClawDispatcherConfigPatch::default()
                    },
                    ..DispatcherPreferencesPatch::default()
                },
            )
            .await
            .expect("dispatcher thread should update");

        assert!(!updated
            .metadata
            .contains_key(OPENCLAW_GATEWAY_TOKEN_METADATA_KEY));
        assert!(!updated
            .metadata
            .contains_key(OPENCLAW_GATEWAY_TOKEN_CONFIGURED_METADATA_KEY));
        assert_eq!(
            updated
                .metadata
                .get(OPENCLAW_GATEWAY_SCOPES_METADATA_KEY)
                .map(String::as_str),
            Some("operator.read,operator.write")
        );
        assert_eq!(
            updated
                .metadata
                .get(OPENCLAW_SESSION_KEY_METADATA_KEY)
                .map(String::as_str),
            Some("conductor:project_dispatcher:demo:dispatcher-1")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn create_dispatcher_thread_ignores_blank_agent_values() {
        let (root, state) = build_test_state("acp-blank-agent-values").await;
        let thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    dispatcher_agent: Some("   ".to_string()),
                    implementation_agent: Some("   ".to_string()),
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should be created");

        assert_eq!(thread.agent, "codex");
        assert_eq!(
            thread
                .metadata
                .get(ACP_IMPLEMENTATION_AGENT_METADATA_KEY)
                .map(String::as_str),
            Some("codex")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn structured_runtime_events_refresh_heartbeat_metadata() {
        let (root, state) = build_test_state("acp-structured-heartbeat").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let overdue_at =
            (Utc::now() - ACP_HEARTBEAT_INTERVAL - chrono::Duration::minutes(1)).to_rfc3339();
        thread
            .metadata
            .insert("acpHeartbeatState".to_string(), "due".to_string());
        thread
            .metadata
            .insert("acpLastHeartbeatAt".to_string(), overdue_at.clone());
        thread
            .metadata
            .insert("acpNextHeartbeatAt".to_string(), overdue_at);
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                "runtime-test",
                ExecutorOutput::StructuredStatus {
                    text: "Thinking".to_string(),
                    metadata: HashMap::new(),
                },
            )
            .await
            .expect("structured runtime event should be applied");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(
            updated
                .metadata
                .get("acpHeartbeatState")
                .map(String::as_str),
            Some("active")
        );
        assert!(updated
            .metadata
            .get("acpNextHeartbeatAt")
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn watchdog_skips_working_dispatchers() {
        let (root, state) = build_test_state("acp-watchdog-working").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let overdue_at =
            (Utc::now() - ACP_HEARTBEAT_INTERVAL - chrono::Duration::minutes(1)).to_rfc3339();
        thread.status = SessionStatus::Working;
        thread.activity = Some("active".to_string());
        thread
            .metadata
            .insert("acpHeartbeatState".to_string(), "active".to_string());
        thread
            .metadata
            .insert("acpLastHeartbeatAt".to_string(), overdue_at.clone());
        thread
            .metadata
            .insert("acpNextHeartbeatAt".to_string(), overdue_at);
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");
        let (input_tx, mut input_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        let _ = state
            .store_dispatcher_runtime(&thread.id, input_tx, true, kill_tx)
            .await;

        state.maintain_acp_dispatchers().await;

        assert!(input_rx.try_recv().is_err());
        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_ne!(updated.summary.as_deref(), Some("ACP heartbeat due"));
        assert!(updated
            .conversation
            .iter()
            .all(|entry| entry.source != "acp_heartbeat"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn watchdog_skips_terminal_dispatchers() {
        let (root, state) = build_test_state("acp-watchdog-terminal").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let overdue_at =
            (Utc::now() - ACP_HEARTBEAT_INTERVAL - chrono::Duration::minutes(1)).to_rfc3339();
        thread.status = SessionStatus::Errored;
        thread.activity = Some("exited".to_string());
        thread
            .metadata
            .insert("acpHeartbeatState".to_string(), "active".to_string());
        thread
            .metadata
            .insert("acpLastHeartbeatAt".to_string(), overdue_at.clone());
        thread
            .metadata
            .insert("acpNextHeartbeatAt".to_string(), overdue_at);
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");

        state.maintain_acp_dispatchers().await;

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_ne!(updated.summary.as_deref(), Some("ACP heartbeat due"));
        assert!(updated
            .conversation
            .iter()
            .all(|entry| entry.source != "acp_heartbeat"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn watchdog_prompts_waiting_dispatchers_with_live_runtime() {
        let (root, state) = build_test_state("acp-watchdog-waiting").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let overdue_at =
            (Utc::now() - ACP_HEARTBEAT_INTERVAL - chrono::Duration::minutes(1)).to_rfc3339();
        thread.status = SessionStatus::NeedsInput;
        thread.activity = Some("waiting_input".to_string());
        thread
            .metadata
            .insert("acpHeartbeatState".to_string(), "active".to_string());
        thread
            .metadata
            .insert("acpLastHeartbeatAt".to_string(), overdue_at.clone());
        thread
            .metadata
            .insert("acpNextHeartbeatAt".to_string(), overdue_at);
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");
        let (input_tx, mut input_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        let _ = state
            .store_dispatcher_runtime(&thread.id, input_tx, true, kill_tx)
            .await;

        state.maintain_acp_dispatchers().await;

        let message = input_rx
            .recv()
            .await
            .expect("heartbeat prompt should be sent");
        match message {
            conductor_executors::executor::ExecutorInput::Text(text) => assert_eq!(
                text,
                "ACP heartbeat due. Review board state, blockers, deferred follow-ups, and which tasks should be shaped or handed off next."
            ),
            other => panic!("expected heartbeat prompt text, got {other:?}"),
        }
        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(updated.summary.as_deref(), Some("ACP heartbeat due"));
        assert!(updated
            .conversation
            .iter()
            .any(|entry| entry.source == "acp_heartbeat"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn headless_runtime_without_input_receiver_still_counts_as_attached() {
        let (root, state) = build_test_state("acp-headless-runtime-attached").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let (input_tx, input_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        drop(input_rx);

        let _ = state
            .store_dispatcher_runtime(&thread.id, input_tx, false, kill_tx)
            .await;

        assert!(state.dispatcher_runtime_attached(&thread.id).await);
        assert!(state.dispatcher_runtime_input(&thread.id).await.is_none());
        assert!(state.dispatcher_runtime_attached(&thread.id).await);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn interactive_runtime_with_closed_input_is_cleared() {
        let (root, state) = build_test_state("acp-interactive-runtime-cleared").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let (input_tx, input_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        drop(input_rx);

        let _ = state
            .store_dispatcher_runtime(&thread.id, input_tx, true, kill_tx)
            .await;

        assert!(!state.dispatcher_runtime_attached(&thread.id).await);
        assert!(state.dispatcher_runtime_input(&thread.id).await.is_none());
        assert!(!state.dispatcher_runtime_attached(&thread.id).await);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_dispatcher_thread_removes_runtime_state_and_session_artifacts() {
        let (root, state) = build_test_state("acp-delete-thread").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let project_memory = state.acp_project_memory_json_path("demo");
        let session_json = state.acp_session_memory_json_path("demo", &thread.id);
        let session_md = state.acp_session_memory_markdown_path("demo", &thread.id);
        let snapshot = state.dispatcher_snapshot_path(&thread.id);
        let (input_tx, _input_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        let _ = state
            .store_dispatcher_runtime(&thread.id, input_tx, true, kill_tx)
            .await;
        state
            .active_session_skills
            .lock()
            .await
            .insert(thread.id.clone(), vec!["dispatcher-skill".to_string()]);

        assert!(snapshot.exists());
        assert!(session_json.exists());
        assert!(session_md.exists());
        assert!(project_memory.exists());
        assert!(state.dispatcher_runtime_attached(&thread.id).await);

        state
            .delete_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should be deleted");

        assert!(state.get_dispatcher_thread(&thread.id).await.is_none());
        assert!(state
            .project_dispatcher_threads("demo", None)
            .await
            .iter()
            .all(|candidate| candidate.id != thread.id));
        timeout(Duration::from_secs(1), async {
            loop {
                if !snapshot.exists() && !session_json.exists() && !session_md.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dispatcher artifacts should be removed asynchronously");
        assert!(project_memory.exists());
        assert!(!state.dispatcher_runtime_attached(&thread.id).await);
        assert!(!state
            .active_session_skills
            .lock()
            .await
            .contains_key(&thread.id));

        let _ = fs::remove_dir_all(root);
    }
}
