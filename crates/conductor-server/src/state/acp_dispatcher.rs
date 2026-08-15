use anyhow::{anyhow, Context, Result};
use chrono::Utc;
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

use super::acp_heartbeat::{
    heartbeat_can_prompt_live_runtime, heartbeat_due_eligible, heartbeat_times,
    should_sync_dispatcher_session_memory, touch_acp_dispatcher_heartbeat, ACP_HEARTBEAT_INTERVAL,
    ACP_WATCHDOG_INTERVAL,
};
use super::acp_memory::{
    clip_text, conversation_note, extract_task_refs, render_project_memory_markdown,
    render_session_memory_markdown, should_promote_to_long_term_memory, AcpDispatcherArtifacts,
    AcpMemoryNote, AcpProjectMemoryState, AcpSessionMemoryState, ACP_LONG_TERM_LIMIT,
    ACP_MAX_NOTE_CHARS, ACP_MEMORY_VERSION, ACP_RECENT_BOARD_ACTIVITY_LIMIT, ACP_SHORT_TERM_LIMIT,
};
use super::helpers::{
    append_runtime_assistant_snapshot, append_streamed_runtime_assistant_delta,
    apply_openclaw_runtime_env, is_runtime_status_line, latest_turn_runtime_assistant_text,
    resolve_board_file, sanitize_terminal_text, settle_runtime_tool_statuses,
    upsert_runtime_status_entry,
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
const ACP_APPROVAL_STATE_METADATA_KEY: &str = "acpPlanApprovalState";
const ACP_APPROVAL_REQUIRED: &str = "approval_required";
const ACP_APPROVAL_GRANTED: &str = "approved_for_next_mutation";
const ACP_APPROVAL_READY_MESSAGE: &str =
    "Plan ready for approval. Review the proposal, then approve it or request changes.";
pub(crate) const ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY: &str = "acpSessionMemorySyncedAt";
pub(crate) const ACP_ACTIVE_SKILLS_METADATA_KEY: &str = "acpActiveSkills";
pub(crate) const ACP_IMPLEMENTATION_AGENT_METADATA_KEY: &str = "acpImplementationAgent";
pub(crate) const ACP_IMPLEMENTATION_MODEL_METADATA_KEY: &str = "acpImplementationModel";
pub(crate) const ACP_IMPLEMENTATION_REASONING_METADATA_KEY: &str =
    "acpImplementationReasoningEffort";
const ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY: &str = "acpRuntimeLaunchAgent";
const ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY: &str = "acpRuntimeLaunchModel";
const ACP_RUNTIME_LAUNCH_REASONING_METADATA_KEY: &str = "acpRuntimeLaunchReasoningEffort";
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

const DISPATCHER_IMPLEMENTATION_AGENT_OPTIONS: [DispatcherSelectOption; 7] = [
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
        value: "cursor-cli",
        name: "Cursor CLI",
        description: "Route implementation work to Cursor CLI sessions.",
    },
    DispatcherSelectOption {
        value: "openclaw",
        name: "OpenClaw",
        description: "Route work through an OpenClaw gateway-backed runtime.",
    },
    DispatcherSelectOption {
        value: "pi",
        name: "Pi",
        description: "Route implementation work to Pi coding agent sessions.",
    },
    DispatcherSelectOption {
        value: "letta",
        name: "Letta Code",
        description: "Route implementation work to Letta Code sessions.",
    },
];

const DISPATCHER_OPENCLAW_MODEL_OPTIONS: [DispatcherSelectOption; 0] = [];
const DISPATCHER_OPENCLAW_REASONING_OPTIONS: [DispatcherSelectOption; 0] = [];
const DISPATCHER_CURSOR_MODEL_OPTIONS: [DispatcherSelectOption; 0] = [];
const DISPATCHER_LETTA_MODEL_OPTIONS: [DispatcherSelectOption; 0] = [];

const DISPATCHER_PI_MODEL_OPTIONS: [DispatcherSelectOption; 6] = [
    DispatcherSelectOption {
        value: "openai/gpt-5.5",
        name: "GPT-5.5",
        description: "Latest frontier OpenAI model exposed by Pi.",
    },
    DispatcherSelectOption {
        value: "openai/gpt-5.4",
        name: "GPT-5.4",
        description: "Previous frontier OpenAI model exposed by Pi.",
    },
    DispatcherSelectOption {
        value: "openai/gpt-5.4-mini",
        name: "GPT-5.4-Mini",
        description: "Smaller GPT-5.4 variant exposed by Pi.",
    },
    DispatcherSelectOption {
        value: "openai/gpt-5.3-codex",
        name: "GPT-5.3-Codex",
        description: "Balanced coding model exposed by Pi.",
    },
    DispatcherSelectOption {
        value: "openai/gpt-5.2-codex",
        name: "GPT-5.2-Codex",
        description: "Previous generation coding model exposed by Pi.",
    },
    DispatcherSelectOption {
        value: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Claude Sonnet model exposed through Pi providers.",
    },
];

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

const GEMINI_STALE_FLASH_MODEL_ID: &str = "gemini-3.1-flash-preview";
const GEMINI_FLASH_MODEL_ID: &str = "gemini-3-flash-preview";

const DISPATCHER_GEMINI_MODEL_OPTIONS: [DispatcherSelectOption; 2] = [
    DispatcherSelectOption {
        value: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        description: "High-capability Gemini model discovered in local Gemini sessions.",
    },
    DispatcherSelectOption {
        value: GEMINI_FLASH_MODEL_ID,
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

pub(crate) fn is_acp_dispatcher_thread(session: &SessionRecord) -> bool {
    session.metadata.get("sessionKind").map(String::as_str) == Some(ACP_SESSION_KIND)
}

fn display_path(workspace_root: &Path, path: &Path) -> String {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
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
    let previous_kind = session
        .metadata
        .insert(PARSER_STATE_KEY.to_string(), kind.to_string());
    changed |= previous_kind.as_deref() != Some(kind);

    let previous_message = session
        .metadata
        .insert(PARSER_STATE_MESSAGE_KEY.to_string(), trimmed.to_string());
    changed |= previous_message.as_deref() != Some(trimmed);

    if let Some(value) = command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let previous_command = session
            .metadata
            .insert(PARSER_STATE_COMMAND_KEY.to_string(), value.to_string());
        changed |= previous_command.as_deref() != Some(value);
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

fn mark_dispatcher_waiting_for_approval(session: &mut SessionRecord) -> bool {
    let mut changed = false;
    if session.status != SessionStatus::NeedsInput {
        session.status = SessionStatus::NeedsInput;
        changed = true;
    }
    if session.activity.as_deref() != Some("waiting_input") {
        session.activity = Some("waiting_input".to_string());
        changed = true;
    }
    if session.summary.as_deref() != Some(ACP_APPROVAL_READY_MESSAGE) {
        session.summary = Some(ACP_APPROVAL_READY_MESSAGE.to_string());
        changed = true;
    }
    if session.metadata.get("summary").map(String::as_str) != Some(ACP_APPROVAL_READY_MESSAGE) {
        session.metadata.insert(
            "summary".to_string(),
            ACP_APPROVAL_READY_MESSAGE.to_string(),
        );
        changed = true;
    }
    if set_parser_state(
        session,
        ACP_APPROVAL_REQUIRED,
        ACP_APPROVAL_READY_MESSAGE,
        None,
    ) {
        changed = true;
    }
    changed
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
        "letta connect",
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
        "pi" | "pi-coding-agent" => Some("pi".to_string()),
        "letta" => Some("letta connect".to_string()),
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

fn concise_dispatcher_runtime_error(error: &str, exit_code: Option<i32>) -> String {
    let sanitized = sanitize_terminal_text(error);
    for line in sanitized.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("at ")
            || trimmed.starts_with("node:")
            || trimmed.starts_with("file://")
            || trimmed.starts_with('/')
            || trimmed.eq_ignore_ascii_case("stack trace")
        {
            continue;
        }
        let normalized = trimmed
            .strip_prefix("Error: ")
            .or_else(|| trimmed.strip_prefix("error: "))
            .unwrap_or(trimmed)
            .trim();
        if !normalized.is_empty() {
            return normalized.to_string();
        }
    }

    exit_code
        .map(|code| format!("Dispatcher runtime exited with code {code}"))
        .unwrap_or_else(|| "Dispatcher runtime exited unexpectedly".to_string())
}

fn clear_dispatcher_runtime_error(session: &mut SessionRecord) {
    session.metadata.remove("error");
}

fn set_dispatcher_runtime_error(session: &mut SessionRecord, error: &str, exit_code: Option<i32>) {
    let detail = concise_dispatcher_runtime_error(error, exit_code);
    session.metadata.insert("error".to_string(), detail.clone());
    session.summary = Some(detail.clone());
    session.metadata.insert("summary".to_string(), detail);
}

fn set_dispatcher_runtime_launch_metadata(
    session: &mut SessionRecord,
    agent: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) {
    session.metadata.insert(
        ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY.to_string(),
        agent.to_string(),
    );
    match model.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            session.metadata.insert(
                ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY.to_string(),
                value.to_string(),
            );
        }
        None => {
            session
                .metadata
                .remove(ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY);
        }
    }
    match reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            session.metadata.insert(
                ACP_RUNTIME_LAUNCH_REASONING_METADATA_KEY.to_string(),
                value.to_string(),
            );
        }
        None => {
            session
                .metadata
                .remove(ACP_RUNTIME_LAUNCH_REASONING_METADATA_KEY);
        }
    }
}

fn clear_dispatcher_runtime_launch_metadata(session: &mut SessionRecord) {
    session
        .metadata
        .remove(ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY);
    session
        .metadata
        .remove(ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY);
    session
        .metadata
        .remove(ACP_RUNTIME_LAUNCH_REASONING_METADATA_KEY);
}

fn dispatcher_runtime_launch_matches_thread(session: &SessionRecord) -> bool {
    let runtime_agent = session
        .metadata
        .get(ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if runtime_agent != Some(session.agent.trim()) {
        return false;
    }

    let runtime_model = session
        .metadata
        .get(ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let thread_model = session
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if runtime_model != thread_model {
        return false;
    }

    let runtime_reasoning = session
        .metadata
        .get(ACP_RUNTIME_LAUNCH_REASONING_METADATA_KEY)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let thread_reasoning = session
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    runtime_reasoning == thread_reasoning
}

fn clear_dispatcher_runtime_state(thread: &mut SessionRecord) {
    thread.pid = None;
    thread.metadata.remove("startedAt");
    thread.metadata.remove("lastStderr");
    thread.metadata.remove("exitCode");
    clear_dispatcher_runtime_launch_metadata(thread);
    clear_parser_state(thread);
}

fn prepare_dispatcher_for_runtime_preference_change(thread: &mut SessionRecord) {
    clear_dispatcher_runtime_state(thread);
    clear_dispatcher_runtime_error(thread);
    thread.metadata.remove(ACP_APPROVAL_STATE_METADATA_KEY);
    thread.metadata.remove("finishedAt");
    thread.status = SessionStatus::Idle;
    thread.activity = Some("idle".to_string());
    thread.summary = Some("Dispatcher ready for the next turn".to_string());
    thread.metadata.insert(
        "summary".to_string(),
        "Dispatcher ready for the next turn".to_string(),
    );
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
    upsert_runtime_status_entry(session, text, explicit_metadata)
}

fn append_runtime_status_entry(session: &mut SessionRecord, text: &str) -> bool {
    append_runtime_status_entry_with_metadata(session, text, None)
}

fn append_runtime_assistant_delta(session: &mut SessionRecord, delta: &str) -> bool {
    append_streamed_runtime_assistant_delta(session, delta)
}

fn append_runtime_assistant_entry(session: &mut SessionRecord, text: &str) -> bool {
    append_runtime_assistant_snapshot(session, text)
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

fn running_inside_dispatcher_mcp_server() -> bool {
    std::env::var("CONDUCTOR_SESSION_KIND").ok().as_deref() == Some(ACP_SESSION_KIND)
}

fn normalize_loaded_dispatcher_thread(
    thread: &mut SessionRecord,
    terminate_loaded_pid: bool,
) -> bool {
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
    let approval_state = thread
        .metadata
        .get(ACP_APPROVAL_STATE_METADATA_KEY)
        .cloned();
    let approval_required = approval_state.as_deref() == Some(ACP_APPROVAL_REQUIRED);
    let should_set_default_approval = approval_state.is_none();
    if should_set_default_approval {
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_GRANTED.to_string(),
        );
        changed = true;
    }

    let loaded_pid = thread.pid.filter(|pid| *pid > 1);
    let live_pid = loaded_pid.filter(|pid| is_process_alive(*pid));
    let should_reset_runtime_state = terminate_loaded_pid || live_pid.is_none();

    if should_reset_runtime_state {
        if let Some(pid) = loaded_pid {
            if terminate_loaded_pid && live_pid.is_some() {
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

    if approval_required
        && matches!(
            thread.status,
            SessionStatus::Idle | SessionStatus::NeedsInput
        )
        && mark_dispatcher_waiting_for_approval(thread)
    {
        changed = true;
    }

    if apply_dispatcher_implementation_preferences(thread, None, None, None) {
        changed = true;
    }

    changed
}

fn canonical_dispatcher_agent(value: &str) -> Option<String> {
    match AgentKind::parse(value) {
        AgentKind::Codex
        | AgentKind::ClaudeCode
        | AgentKind::Gemini
        | AgentKind::OpenClaw
        | AgentKind::Letta => Some(AgentKind::parse(value).to_string()),
        _ => None,
    }
}

fn validate_requested_dispatcher_agent(value: Option<String>) -> Result<Option<String>> {
    match normalize_optional_string(value) {
        Some(value) => canonical_dispatcher_agent(&value).map(Some).ok_or_else(|| {
            anyhow!(
                "Unsupported dispatcher agent `{value}`. Expected codex, claude-code, gemini, openclaw, or letta"
            )
        }),
        None => Ok(None),
    }
}

fn canonical_implementation_agent(value: &str) -> Option<String> {
    match AgentKind::parse(value) {
        AgentKind::Codex
        | AgentKind::ClaudeCode
        | AgentKind::Gemini
        | AgentKind::OpenClaw
        | AgentKind::CursorCli
        | AgentKind::Pi
        | AgentKind::Letta => Some(AgentKind::parse(value).to_string()),
        _ => None,
    }
}

fn validate_requested_implementation_agent(value: Option<String>) -> Result<Option<String>> {
    match normalize_optional_string(value) {
        Some(value) => canonical_implementation_agent(&value).map(Some).ok_or_else(|| {
            anyhow!(
                "Unsupported implementation agent `{value}`. Expected codex, claude-code, gemini, openclaw, cursor-cli, pi, or letta"
            )
        }),
        None => Ok(None),
    }
}

fn default_implementation_agent(
    requested_agent: Option<&str>,
    project: &ProjectConfig,
    default_agent: &str,
) -> String {
    let candidate = requested_agent
        .or(project.agent.as_deref())
        .unwrap_or(default_agent);
    canonical_implementation_agent(candidate).unwrap_or_else(|| "codex".to_string())
}

fn default_dispatcher_agent(project: &ProjectConfig, default_agent: &str) -> String {
    project
        .agent
        .as_deref()
        .and_then(canonical_dispatcher_agent)
        .or_else(|| canonical_dispatcher_agent(default_agent))
        .unwrap_or_else(|| "codex".to_string())
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_implementation_agent(value: Option<String>) -> Option<String> {
    normalize_optional_string(value).and_then(|value| canonical_implementation_agent(&value))
}

fn normalize_dispatcher_model_for_agent(agent: &str, model: Option<&str>) -> Option<String> {
    let trimmed = model.map(str::trim).filter(|value| !value.is_empty())?;
    let canonical_agent =
        canonical_implementation_agent(agent).unwrap_or_else(|| "codex".to_string());
    if canonical_agent == "gemini" && trimmed.eq_ignore_ascii_case(GEMINI_STALE_FLASH_MODEL_ID) {
        return Some(GEMINI_FLASH_MODEL_ID.to_string());
    }
    dispatcher_model_supported_for_agent(&canonical_agent, trimmed).then(|| trimmed.to_string())
}

fn requested_dispatcher_model_for_agent(
    agent: &str,
    model: Option<&str>,
    label: &str,
) -> Result<Option<String>> {
    let Some(trimmed) = model.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    normalize_dispatcher_model_for_agent(agent, Some(trimmed))
        .map(Some)
        .ok_or_else(|| anyhow!("Unsupported {label} model `{trimmed}` for agent `{agent}`"))
}

pub(crate) fn dispatcher_implementation_agent_options() -> &'static [DispatcherSelectOption] {
    &DISPATCHER_IMPLEMENTATION_AGENT_OPTIONS
}

pub(crate) fn dispatcher_implementation_model_options(
    agent: &str,
) -> &'static [DispatcherSelectOption] {
    match canonical_implementation_agent(agent)
        .unwrap_or_else(|| "codex".to_string())
        .as_str()
    {
        "claude-code" => &DISPATCHER_CLAUDE_MODEL_OPTIONS,
        "gemini" => &DISPATCHER_GEMINI_MODEL_OPTIONS,
        "openclaw" => &DISPATCHER_OPENCLAW_MODEL_OPTIONS,
        "cursor-cli" => &DISPATCHER_CURSOR_MODEL_OPTIONS,
        "pi" => &DISPATCHER_PI_MODEL_OPTIONS,
        "letta" => &DISPATCHER_LETTA_MODEL_OPTIONS,
        _ => &DISPATCHER_CODEX_MODEL_OPTIONS,
    }
}

pub(crate) fn dispatcher_implementation_reasoning_options(
    agent: &str,
) -> &'static [DispatcherSelectOption] {
    match canonical_implementation_agent(agent)
        .unwrap_or_else(|| "codex".to_string())
        .as_str()
    {
        "gemini" => &[],
        "openclaw" => &DISPATCHER_OPENCLAW_REASONING_OPTIONS,
        "letta" => &[],
        "claude-code" => &DISPATCHER_DEFAULT_REASONING_OPTIONS,
        "pi" => &DISPATCHER_CODEX_REASONING_OPTIONS,
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
    match canonical_implementation_agent(agent)
        .unwrap_or_else(|| "codex".to_string())
        .as_str()
    {
        "claude-code" => Some("medium"),
        "codex" => Some("high"),
        "pi" => Some("high"),
        "cursor-cli" => Some("medium"),
        "openclaw" | "letta" => None,
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
        AgentKind::Codex
            | AgentKind::QwenCode
            | AgentKind::Gemini
            | AgentKind::OpenClaw
            | AgentKind::Pi
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
    match canonical_implementation_agent(agent)
        .unwrap_or_else(|| "codex".to_string())
        .as_str()
    {
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
        "letta" => {
            // Letta Code accepts provider-specific model IDs through --model.
            true
        }
        "pi" => {
            // Pi accepts provider/model IDs and custom model patterns through --model.
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
    if canonical_implementation_agent(agent).as_deref() == Some("codex") {
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
    normalize_dispatcher_model_for_agent(agent, implementation_model)
        .or_else(|| {
            current_model
                .as_deref()
                .and_then(|value| normalize_dispatcher_model_for_agent(agent, Some(value)))
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
        .and_then(canonical_implementation_agent)
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
    async fn dispatcher_transition_guard(&self, thread_id: &str) -> Arc<Mutex<()>> {
        let mut guards = self.dispatcher_transition_guards.lock().await;
        guards
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

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
        self.load_dispatchers_from_disk_with_pid_termination(
            !running_inside_dispatcher_mcp_server(),
        )
        .await;
    }

    async fn load_dispatchers_from_disk_with_pid_termination(&self, terminate_loaded_pids: bool) {
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
                    let changed =
                        normalize_loaded_dispatcher_thread(&mut session, terminate_loaded_pids);
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
        self.persist_current_dispatcher_snapshot(&thread.id).await?;
        self.invalidate_dispatcher_caches(&thread.id).await;
        Ok(())
    }

    async fn write_dispatcher_snapshot(&self, thread: &SessionRecord) -> Result<()> {
        let path = self.dispatcher_snapshot_path(&thread.id);
        let content = serde_json::to_string_pretty(thread)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    async fn dispatcher_snapshot_guard(&self, thread_id: &str) -> Arc<Mutex<()>> {
        let mut guards = self.dispatcher_snapshot_guards.lock().await;
        Arc::clone(
            guards
                .entry(thread_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    pub(crate) async fn persist_current_dispatcher_snapshot(&self, thread_id: &str) -> Result<()> {
        let guard = self.dispatcher_snapshot_guard(thread_id).await;
        let _write_lock = guard.lock().await;
        let snapshot = self.dispatcher_threads.read().await.get(thread_id).cloned();
        if let Some(snapshot) = snapshot {
            self.write_dispatcher_snapshot(&snapshot).await?;
        }
        Ok(())
    }

    pub(crate) async fn replace_dispatcher_thread(&self, thread: SessionRecord) -> Result<()> {
        {
            let mut guard = self.dispatcher_threads.write().await;
            guard.insert(thread.id.clone(), thread.clone());
        }
        self.persist_dispatcher_thread(&thread).await?;
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
        self.pending_dispatcher_flushes
            .lock()
            .await
            .remove(thread_id);
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
        let pending_updates: Arc<tokio::sync::Mutex<HashSet<String>>> =
            Arc::clone(&self.pending_dispatcher_updates);
        let dispatcher_updates = self.dispatcher_updates.clone();
        let should_schedule = {
            let mut pending = self.pending_dispatcher_updates.lock().await;
            pending.insert(thread_id.to_string())
        };
        if !should_schedule {
            return;
        }

        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let should_send = {
                let mut pending = pending_updates.lock().await;
                pending.remove(&thread_id)
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
            normalize_implementation_agent(Some(config.preferences.coding_agent.clone()))
                .unwrap_or_else(|| "codex".to_string());
        let requested_dispatcher_agent = validate_requested_dispatcher_agent(dispatcher_agent)?;
        let requested_implementation_agent =
            validate_requested_implementation_agent(implementation_agent.clone())?;
        let agent = requested_dispatcher_agent
            .unwrap_or_else(|| default_dispatcher_agent(&project, &default_agent));
        let dispatcher_model = requested_dispatcher_model_for_agent(
            &agent,
            dispatcher_model.as_deref(),
            "dispatcher",
        )?;
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
                    if requested_implementation_agent.is_some()
                        || implementation_model.is_some()
                        || implementation_reasoning_effort.is_some()
                        || has_openclaw_dispatcher_config_patch(&openclaw_config)
                    {
                        updated = self
                            .update_dispatcher_preferences(
                                &updated.id,
                                DispatcherPreferencesPatch {
                                    implementation_agent: requested_implementation_agent.clone(),
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
        let selected_implementation_agent = requested_implementation_agent.unwrap_or_else(|| {
            default_implementation_agent(Some(agent.as_str()), &project, &default_agent)
        });
        thread.metadata.insert(
            ACP_IMPLEMENTATION_AGENT_METADATA_KEY.to_string(),
            selected_implementation_agent.clone(),
        );
        let implementation_model = requested_dispatcher_model_for_agent(
            &selected_implementation_agent,
            implementation_model.as_deref(),
            "implementation",
        )?;
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
        let transition_guard = self.dispatcher_transition_guard(thread_id).await;
        let _transition_lock = transition_guard.lock().await;
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

        let current_dispatcher_agent = canonical_dispatcher_agent(&thread.agent)
            .unwrap_or_else(|| thread.agent.trim().to_ascii_lowercase());
        let requested_dispatcher_agent = validate_requested_dispatcher_agent(dispatcher_agent)?;
        let target_dispatcher_agent =
            requested_dispatcher_agent.unwrap_or_else(|| current_dispatcher_agent.clone());

        let requested_dispatcher_model = requested_dispatcher_model_for_agent(
            &target_dispatcher_agent,
            dispatcher_model.as_deref(),
            "dispatcher",
        )?;
        let next_dispatcher_model = requested_dispatcher_model.or_else(|| {
            thread.model.as_deref().and_then(|value| {
                normalize_dispatcher_model_for_agent(&target_dispatcher_agent, Some(value))
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

        let requested_implementation_agent =
            validate_requested_implementation_agent(implementation_agent.clone())?;
        let target_implementation_agent = requested_implementation_agent.unwrap_or_else(|| {
            canonical_implementation_agent(&dispatcher_preferred_implementation_agent(&thread))
                .unwrap_or_else(|| "codex".to_string())
        });
        let requested_implementation_model = requested_dispatcher_model_for_agent(
            &target_implementation_agent,
            implementation_model.as_deref(),
            "implementation",
        )?;
        let target_implementation_model = resolve_dispatcher_implementation_model(
            &thread,
            &target_implementation_agent,
            requested_implementation_model.as_deref(),
        );
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
            clear_dispatcher_runtime_launch_metadata(&mut thread);
        }

        let implementation_changed = apply_dispatcher_implementation_preferences(
            &mut thread,
            implementation_agent,
            requested_implementation_model,
            implementation_reasoning_effort,
        );
        let openclaw_changed = apply_openclaw_dispatcher_config(&mut thread, &openclaw_config);
        if !runtime_changed && !implementation_changed && !openclaw_changed {
            return Ok(thread);
        }

        let retired_runtime = if runtime_changed {
            self.take_dispatcher_runtime(thread_id).await
        } else {
            None
        };
        if runtime_changed
            && (retired_runtime.is_some()
                || matches!(
                    thread.status,
                    SessionStatus::Working
                        | SessionStatus::Queued
                        | SessionStatus::Spawning
                        | SessionStatus::NeedsInput
                ))
        {
            prepare_dispatcher_for_runtime_preference_change(&mut thread);
        }

        thread.last_activity_at = Utc::now().to_rfc3339();
        let replace_result = self.replace_dispatcher_thread(thread.clone()).await;
        if let Some(handle) = retired_runtime {
            self.interrupt_retired_dispatcher_runtime(handle).await;
        }
        replace_result?;
        self.sync_acp_dispatcher_state(&thread).await?;
        Ok(thread)
    }

    pub(crate) async fn update_dispatcher_runtime_preferences(
        self: &Arc<Self>,
        thread_id: &str,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<SessionRecord> {
        let transition_guard = self.dispatcher_transition_guard(thread_id).await;
        let _transition_lock = transition_guard.lock().await;
        let mut thread = self
            .get_dispatcher_thread(thread_id)
            .await
            .with_context(|| format!("Unknown dispatcher {thread_id}"))?;

        let dispatcher_agent = canonical_dispatcher_agent(&thread.agent)
            .unwrap_or_else(|| thread.agent.trim().to_ascii_lowercase());
        let requested_model = requested_dispatcher_model_for_agent(
            &dispatcher_agent,
            model.as_deref(),
            "dispatcher",
        )?;
        let target_model = requested_model.clone().or_else(|| {
            thread.model.as_deref().and_then(|value| {
                normalize_dispatcher_model_for_agent(&dispatcher_agent, Some(value))
            })
        });
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

        let next_model = target_model;
        let next_reasoning = reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
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
        clear_dispatcher_runtime_launch_metadata(&mut thread);
        let retired_runtime = self.take_dispatcher_runtime(thread_id).await;
        if retired_runtime.is_some()
            || matches!(
                thread.status,
                SessionStatus::Working
                    | SessionStatus::Queued
                    | SessionStatus::Spawning
                    | SessionStatus::NeedsInput
            )
        {
            prepare_dispatcher_for_runtime_preference_change(&mut thread);
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
        let replace_result = self.replace_dispatcher_thread(thread.clone()).await;
        if let Some(handle) = retired_runtime {
            self.interrupt_retired_dispatcher_runtime(handle).await;
        }
        replace_result?;
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
                    "cursor-cli".to_string(),
                    "openclaw".to_string(),
                    "pi".to_string(),
                    "letta".to_string(),
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
                    "cursor-cli".to_string(),
                    "openclaw".to_string(),
                    "pi".to_string(),
                    "letta".to_string(),
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
            Some(handle) if handle.input_tx.is_closed() => {
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

    async fn take_dispatcher_runtime(&self, thread_id: &str) -> Option<DispatcherRuntimeHandle> {
        self.dispatcher_runtimes.lock().await.remove(thread_id)
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

    async fn interrupt_retired_dispatcher_runtime(&self, handle: DispatcherRuntimeHandle) {
        let mut kill_tx = handle.kill_tx.lock().await;
        if let Some(kill_tx) = kill_tx.take() {
            let _ = kill_tx.send(());
        }
    }

    async fn persist_dispatcher_runtime_recovery_failure(
        self: &Arc<Self>,
        thread_id: &str,
        error: &anyhow::Error,
    ) -> Result<()> {
        self.clear_dispatcher_runtime(thread_id).await;

        let detail = format!(
            "Failed to recover dispatcher runtime: {}",
            concise_dispatcher_runtime_error(&error.to_string(), None)
        );
        let updated = {
            let mut threads = self.dispatcher_threads.write().await;
            let Some(thread) = threads.get_mut(thread_id) else {
                return Ok(());
            };
            if !matches!(
                thread.status,
                SessionStatus::Working | SessionStatus::Queued | SessionStatus::Spawning
            ) {
                return Ok(());
            }

            clear_dispatcher_runtime_state(thread);
            thread.status = SessionStatus::Errored;
            thread.activity = Some("exited".to_string());
            thread.last_activity_at = Utc::now().to_rfc3339();
            thread
                .metadata
                .insert("finishedAt".to_string(), thread.last_activity_at.clone());
            set_dispatcher_runtime_error(thread, &detail, None);
            thread.clone()
        };

        self.persist_dispatcher_thread(&updated).await?;
        self.sync_acp_dispatcher_state(&updated).await?;
        self.publish_dispatcher_update(thread_id).await;
        Ok(())
    }

    async fn ensure_dispatcher_runtime_or_recover(
        self: &Arc<Self>,
        thread: &SessionRecord,
        initial_message: &str,
        attachments: &[String],
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Result<()> {
        match self
            .ensure_dispatcher_runtime(
                thread,
                initial_message,
                attachments,
                model,
                reasoning_effort,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(err) => {
                self.persist_dispatcher_runtime_recovery_failure(&thread.id, &err)
                    .await?;
                Err(err)
            }
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
            spawn_env.insert("CLAUDECODE".to_string(), "1".to_string());
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

        let runtime_prompt = self
            .dispatcher_prompt_with_context(
                thread,
                &merge_dispatcher_prompt_with_user(&thread.prompt, initial_message),
                attachments,
            )
            .await;
        let send_initial_prompt_after_runtime_attach = !use_headless_turns
            && executor.supports_direct_terminal_ui()
            && !executor.accepts_prompt_on_launch_when_interactive()
            && !runtime_prompt.trim().is_empty();
        let launch_prompt = if send_initial_prompt_after_runtime_attach {
            String::new()
        } else {
            runtime_prompt.clone()
        };
        let launch_model = model.clone();
        let launch_reasoning_effort = reasoning_effort.clone();
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
                prompt: launch_prompt,
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
                set_dispatcher_runtime_launch_metadata(
                    current,
                    &thread.agent,
                    launch_model.as_deref(),
                    launch_reasoning_effort.as_deref(),
                );
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
        if send_initial_prompt_after_runtime_attach {
            runtime_handle
                .input_tx
                .send(ExecutorInput::Text(runtime_prompt))
                .await?;
        }
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
                if let Err(err) = state
                    .apply_dispatcher_runtime_event(&thread_id, &runtime_id, event)
                    .await
                {
                    tracing::error!(
                        thread_id = %thread_id,
                        runtime_id = %runtime_id,
                        error = %err,
                        "failed to apply dispatcher runtime event"
                    );
                }
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
        let Some(active_runtime_id) = self
            .dispatcher_runtime_handle(thread_id)
            .await
            .map(|handle| handle.runtime_id)
        else {
            return Ok(());
        };
        if active_runtime_id != runtime_id {
            return Ok(());
        }
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
            ExecutorOutput::AssistantDelta(delta) => {
                clear_dispatcher_runtime_error(thread);
                if !thread.status.is_terminal() {
                    if thread.status != SessionStatus::Working {
                        thread.status = SessionStatus::Working;
                    }
                    thread.activity = Some("active".to_string());
                }
                if append_runtime_assistant_delta(thread, &delta) {
                    feed_dirty = true;
                }
            }
            ExecutorOutput::Stdout(line) => {
                clear_dispatcher_runtime_error(thread);
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
                clear_dispatcher_runtime_error(thread);
                if let Some(resume_target) = metadata
                    .get("nativeResumeTarget")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
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
                clear_dispatcher_runtime_error(thread);
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
                if let Some(summary) = latest_turn_runtime_assistant_text(thread) {
                    thread.summary = Some(summary.clone());
                    thread.metadata.insert("summary".to_string(), summary);
                }
                if clear_parser_state(thread) {
                    feed_dirty = true;
                }
                clear_dispatcher_runtime_launch_metadata(thread);
                thread
                    .metadata
                    .insert("exitCode".to_string(), exit_code.to_string());
                if exit_code == 0 {
                    clear_dispatcher_runtime_error(thread);
                    let approval_required = thread
                        .metadata
                        .get(ACP_APPROVAL_STATE_METADATA_KEY)
                        .map(String::as_str)
                        == Some(ACP_APPROVAL_REQUIRED);
                    if approval_required {
                        if mark_dispatcher_waiting_for_approval(thread) {
                            feed_dirty = true;
                        }
                        thread
                            .metadata
                            .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                    } else {
                        let uses_headless_turns =
                            dispatcher_uses_headless_turns(&AgentKind::parse(&thread.agent));
                        if uses_headless_turns {
                            if thread.status != SessionStatus::Idle {
                                thread.status = SessionStatus::Idle;
                                feed_dirty = true;
                            }
                            thread.activity = Some("idle".to_string());
                            thread
                                .metadata
                                .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                            if thread
                                .summary
                                .as_ref()
                                .map(|value| value.trim().is_empty())
                                .unwrap_or(true)
                            {
                                thread.summary =
                                    Some("Dispatcher ready for the next turn".to_string());
                                thread.metadata.insert(
                                    "summary".to_string(),
                                    "Dispatcher ready for the next turn".to_string(),
                                );
                            }
                        } else {
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
                                thread.metadata.insert(
                                    "summary".to_string(),
                                    "Ready for follow-up".to_string(),
                                );
                            }
                        }
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
                    let error = thread
                        .metadata
                        .get("lastStderr")
                        .cloned()
                        .or_else(|| thread.summary.clone())
                        .unwrap_or_else(|| format!("Process exited with code {exit_code}"));
                    set_dispatcher_runtime_error(thread, &error, Some(exit_code));
                }
            }
            ExecutorOutput::Failed { error, exit_code } => {
                let parser_state_detected = detect_parser_state(thread, &error);
                let requested_kill = error == "killed";
                clear_dispatcher_runtime_launch_metadata(thread);
                thread.status = if requested_kill {
                    SessionStatus::Killed
                } else {
                    SessionStatus::Errored
                };
                thread.activity = Some("exited".to_string());
                thread
                    .metadata
                    .insert("finishedAt".to_string(), Utc::now().to_rfc3339());
                if requested_kill {
                    clear_dispatcher_runtime_error(thread);
                    thread.summary = Some("Interrupted".to_string());
                    thread
                        .metadata
                        .insert("summary".to_string(), "Interrupted".to_string());
                } else {
                    set_dispatcher_runtime_error(thread, &error, exit_code);
                }
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
        if clear_runtime
            && settle_runtime_tool_statuses(
                thread,
                matches!(
                    thread.status,
                    SessionStatus::Errored | SessionStatus::Killed | SessionStatus::Terminated
                ),
            )
        {
            feed_dirty = true;
        }

        let should_sync_memory = should_sync_dispatcher_session_memory(thread, force_memory_sync);
        let memory_snapshot = should_sync_memory.then(|| thread.clone());
        if clear_runtime {
            self.clear_dispatcher_runtime_if(thread_id, runtime_id)
                .await;
        }
        drop(threads);
        if feed_dirty {
            self.publish_dispatcher_update(thread_id).await;
        }
        if force_memory_sync {
            self.persist_current_dispatcher_snapshot(thread_id).await?;
        } else {
            self.queue_dispatcher_flush(thread_id).await;
        }
        if let Some(memory_snapshot) = memory_snapshot.as_ref() {
            self.sync_acp_dispatcher_state(memory_snapshot).await?;
        }
        Ok(())
    }

    pub(crate) async fn send_to_dispatcher_thread(
        self: &Arc<Self>,
        thread_id: &str,
        request: DispatcherTurnRequest,
    ) -> Result<()> {
        let transition_guard = self.dispatcher_transition_guard(thread_id).await;
        let _transition_lock = transition_guard.lock().await;
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
        let dispatcher_agent = canonical_dispatcher_agent(&thread.agent)
            .unwrap_or_else(|| thread.agent.trim().to_ascii_lowercase());
        let requested_model = requested_dispatcher_model_for_agent(
            &dispatcher_agent,
            model.as_deref(),
            "dispatcher",
        )?;
        let effective_model = requested_model.or_else(|| {
            thread.model.as_deref().and_then(|value| {
                normalize_dispatcher_model_for_agent(&dispatcher_agent, Some(value))
            })
        });

        clear_parser_state(thread);
        clear_dispatcher_runtime_error(thread);
        thread.metadata.remove("lastStderr");
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

        if thread.model != effective_model {
            thread.model = effective_model.clone();
            match effective_model.as_ref() {
                Some(model_value) => {
                    thread
                        .metadata
                        .insert("model".to_string(), model_value.clone());
                }
                None => {
                    thread.metadata.remove("model");
                }
            }
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

        let runtime_prompt = self
            .dispatcher_prompt_with_context(&updated, &runtime_message, &effective_attachments)
            .await;

        if !uses_headless_turns {
            if let Some(runtime_handle) = self.dispatcher_runtime_input(thread_id).await {
                if !dispatcher_runtime_launch_matches_thread(&updated) {
                    let _ = self.interrupt_dispatcher(thread_id).await;
                    self.clear_dispatcher_runtime_if(thread_id, &runtime_handle.runtime_id)
                        .await;
                    self.ensure_dispatcher_runtime_or_recover(
                        &updated,
                        &runtime_message,
                        &effective_attachments,
                        updated.model.clone(),
                        reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
                    )
                    .await?;
                } else if let Err(err) = runtime_handle
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
                    self.ensure_dispatcher_runtime_or_recover(
                        &updated,
                        &runtime_message,
                        &effective_attachments,
                        updated.model.clone(),
                        reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
                    )
                    .await?;
                }
            } else {
                self.ensure_dispatcher_runtime_or_recover(
                    &updated,
                    &runtime_message,
                    &effective_attachments,
                    updated.model.clone(),
                    reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
                )
                .await?;
            }
        } else {
            self.ensure_dispatcher_runtime_or_recover(
                &updated,
                &runtime_message,
                &effective_attachments,
                updated.model.clone(),
                reasoning_effort.or_else(|| updated.reasoning_effort.clone()),
            )
            .await?;
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
        merge_dispatcher_context_attachments, normalize_dispatcher_model_for_agent,
        normalize_loaded_dispatcher_thread, prepare_dispatcher_for_runtime_preference_change,
        prepare_dispatcher_runtime_env, read_json, AcpSessionMemoryState, AppState,
        CreateDispatcherThreadOptions, DispatcherPreferencesPatch, DispatcherRuntimeHandle,
        OpenClawDispatcherConfigPatch, ACP_APPROVAL_REQUIRED, ACP_APPROVAL_STATE_METADATA_KEY,
        ACP_HEARTBEAT_INTERVAL, ACP_IMPLEMENTATION_AGENT_METADATA_KEY,
        ACP_IMPLEMENTATION_MODEL_METADATA_KEY, ACP_IMPLEMENTATION_REASONING_METADATA_KEY,
        ACP_RESUME_TARGET_METADATA_KEY, ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY,
        ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY, ACP_SESSION_KIND, GEMINI_FLASH_MODEL_ID,
        GEMINI_STALE_FLASH_MODEL_ID, OPENCLAW_GATEWAY_SCOPES_METADATA_KEY,
        OPENCLAW_GATEWAY_TOKEN_CONFIGURED_METADATA_KEY, OPENCLAW_GATEWAY_TOKEN_METADATA_KEY,
        OPENCLAW_GATEWAY_URL_METADATA_KEY, OPENCLAW_SESSION_KEY_METADATA_KEY,
    };
    use crate::state::{ConversationEntry, DispatcherTurnRequest, SessionRecord, SessionStatus};
    use anyhow::{anyhow, Result};
    use async_trait::async_trait;
    use chrono::Utc;
    use conductor_core::{
        config::{ConductorConfig, PreferencesConfig, ProjectConfig},
        types::AgentKind,
    };
    use conductor_db::Database;
    use conductor_executors::executor::{
        Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions,
    };
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::process::Command;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::timeout;
    use uuid::Uuid;

    #[derive(Clone)]
    struct DelayedHeadlessExecutor {
        assistant_text: String,
        delay: Duration,
    }

    #[derive(Clone)]
    struct PromptAfterAttachExecutor {
        observed_input_tx: mpsc::UnboundedSender<String>,
    }

    #[derive(Clone)]
    struct FailingSpawnExecutor {
        error: String,
    }

    #[async_trait]
    impl Executor for PromptAfterAttachExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Letta
        }

        fn name(&self) -> &str {
            "PromptAfterAttachExecutor"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/tmp/prompt-after-attach-executor")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        fn supports_direct_terminal_ui(&self) -> bool {
            true
        }

        fn accepts_prompt_on_launch_when_interactive(&self) -> bool {
            false
        }

        async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
            assert_eq!(options.prompt, "");
            assert!(options.interactive);
            let (output_tx, output_rx) = mpsc::channel(8);
            let (input_tx, mut input_rx) = mpsc::channel(4);
            let (kill_tx, _kill_rx) = oneshot::channel();
            let observed_input_tx = self.observed_input_tx.clone();

            tokio::spawn(async move {
                if let Some(ExecutorInput::Text(text)) = input_rx.recv().await {
                    let _ = observed_input_tx.send(text);
                    let _ = output_tx
                        .send(ExecutorOutput::Completed { exit_code: 0 })
                        .await;
                }
            });

            Ok(ExecutorHandle::new(
                4343,
                AgentKind::Letta,
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

    #[async_trait]
    impl Executor for FailingSpawnExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Letta
        }

        fn name(&self) -> &str {
            "FailingSpawnExecutor"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/tmp/failing-spawn-executor")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        fn supports_direct_terminal_ui(&self) -> bool {
            true
        }

        async fn spawn(&self, _options: SpawnOptions) -> Result<ExecutorHandle> {
            Err(anyhow!("{}", self.error))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            Vec::new()
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
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
                    runtime: Some("direct".to_string()),
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

    async fn reopen_test_state(root: &Path) -> Arc<AppState> {
        let repo = root.join("repo");
        let config = ConductorConfig {
            workspace: root.to_path_buf(),
            preferences: PreferencesConfig {
                coding_agent: "codex".to_string(),
                ..PreferencesConfig::default()
            },
            projects: BTreeMap::from([(
                "demo".to_string(),
                ProjectConfig {
                    path: repo.to_string_lossy().to_string(),
                    agent: Some("codex".to_string()),
                    runtime: Some("direct".to_string()),
                    default_branch: "main".to_string(),
                    ..ProjectConfig::default()
                },
            )]),
            ..ConductorConfig::default()
        };
        let db = Database::in_memory()
            .await
            .expect("test db should initialize");
        AppState::new(root.join("conductor.yaml"), config, db).await
    }

    async fn register_test_dispatcher_runtime(
        state: &Arc<AppState>,
        thread_id: &str,
    ) -> DispatcherRuntimeHandle {
        let (input_tx, _input_rx) = mpsc::channel(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        state
            .store_dispatcher_runtime(thread_id, input_tx, true, kill_tx)
            .await
    }

    #[test]
    fn prepare_dispatcher_runtime_env_sets_term_defaults() {
        let mut env = HashMap::new();
        prepare_dispatcher_runtime_env(&mut env);
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
    }

    #[test]
    fn set_parser_state_trims_commands_before_dirty_tracking() {
        let mut session = SessionRecord::new(
            "dispatcher-1".to_string(),
            "demo".to_string(),
            None,
            None,
            None,
            "codex".to_string(),
            None,
            None,
            "prompt".to_string(),
            None,
        );

        assert!(super::set_parser_state(
            &mut session,
            ACP_APPROVAL_REQUIRED,
            "Need approval",
            Some(" resume-turn ".to_string()),
        ));
        assert_eq!(
            session
                .metadata
                .get(super::PARSER_STATE_COMMAND_KEY)
                .map(String::as_str),
            Some("resume-turn")
        );

        assert!(!super::set_parser_state(
            &mut session,
            ACP_APPROVAL_REQUIRED,
            "Need approval",
            Some("resume-turn".to_string()),
        ));
    }

    #[test]
    fn mark_dispatcher_waiting_for_approval_tracks_summary_only_changes() {
        let mut session = SessionRecord::new(
            "dispatcher-1".to_string(),
            "demo".to_string(),
            None,
            None,
            None,
            "codex".to_string(),
            None,
            None,
            "prompt".to_string(),
            None,
        );
        session.status = SessionStatus::NeedsInput;
        session.activity = Some("waiting_input".to_string());
        session.summary = Some("Old summary".to_string());
        session
            .metadata
            .insert("summary".to_string(), "Old summary".to_string());
        session.metadata.insert(
            super::PARSER_STATE_KEY.to_string(),
            ACP_APPROVAL_REQUIRED.to_string(),
        );
        session.metadata.insert(
            super::PARSER_STATE_MESSAGE_KEY.to_string(),
            super::ACP_APPROVAL_READY_MESSAGE.to_string(),
        );

        assert!(super::mark_dispatcher_waiting_for_approval(&mut session));
        assert_eq!(
            session.summary.as_deref(),
            Some(super::ACP_APPROVAL_READY_MESSAGE)
        );
        assert_eq!(
            session.metadata.get("summary").map(String::as_str),
            Some(super::ACP_APPROVAL_READY_MESSAGE)
        );
    }

    #[test]
    fn prepare_dispatcher_runtime_env_preserves_existing_term() {
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
        assert!(dispatcher_uses_headless_turns(&AgentKind::Gemini));
        assert!(dispatcher_uses_headless_turns(&AgentKind::Pi));
        assert!(!dispatcher_uses_headless_turns(&AgentKind::ClaudeCode));

        assert!(dispatcher_supports_interactive_structured_output(
            &AgentKind::ClaudeCode
        ));
        assert!(dispatcher_supports_interactive_structured_output(
            &AgentKind::Gemini
        ));
        assert!(dispatcher_supports_interactive_structured_output(
            &AgentKind::GithubCopilot
        ));
        assert!(!dispatcher_supports_interactive_structured_output(
            &AgentKind::OpenCode
        ));
    }

    #[test]
    fn headless_dispatchers_ignore_persisted_resume_targets_including_codex() {
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
        assert_eq!(dispatcher_resume_target(&thread, &AgentKind::Pi), None);
        assert_eq!(
            dispatcher_resume_target(&thread, &AgentKind::QwenCode),
            None
        );
        assert_eq!(dispatcher_resume_target(&thread, &AgentKind::Gemini), None);
        assert_eq!(
            dispatcher_resume_target(&thread, &AgentKind::ClaudeCode),
            Some("session-123".to_string())
        );
    }

    #[tokio::test]
    async fn continuous_dispatcher_deltas_publish_inside_the_fixed_update_window() {
        let (root, state) = build_test_state("dispatcher-update-window").await;
        let mut updates = state.dispatcher_updates.subscribe();
        let probe_id = "continuous-stream-probe".to_string();
        let publisher_state = Arc::clone(&state);
        let publisher_id = probe_id.clone();
        let publisher = tokio::spawn(async move {
            for _ in 0..12 {
                publisher_state
                    .publish_dispatcher_update(&publisher_id)
                    .await;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        });

        timeout(Duration::from_millis(200), async {
            loop {
                if updates.recv().await.expect("dispatcher update channel") == probe_id {
                    break;
                }
            }
        })
        .await
        .expect("continuous deltas must publish inside the first fixed 50ms window");

        publisher.await.expect("publisher task");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn explicit_dispatcher_flush_coalesces_burst_queues_to_latest_state() {
        let (root, state) = build_test_state("dispatcher-flush-burst-coalesced").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.summary = Some("first queued state".to_string());
        }
        state.queue_dispatcher_flush(&thread.id).await;

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.summary = Some("second queued state".to_string());
        }
        state.queue_dispatcher_flush(&thread.id).await;

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.status = SessionStatus::NeedsInput;
            current.summary = Some("latest queued state".to_string());
        }
        state.queue_dispatcher_flush(&thread.id).await;

        state
            .flush_pending_dispatcher_snapshots()
            .await
            .expect("explicit flush should persist the latest state");

        let persisted = read_json::<SessionRecord>(&state.dispatcher_snapshot_path(&thread.id))
            .await
            .expect("persisted dispatcher snapshot");
        assert_eq!(persisted.status, SessionStatus::NeedsInput);
        assert_eq!(persisted.summary.as_deref(), Some("latest queued state"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn explicit_dispatcher_flush_persists_without_waiting_for_watchdog_debounce() {
        let (root, state) = build_test_state("dispatcher-flush-explicit-final").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let snapshot_path = state.dispatcher_snapshot_path(&thread.id);

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.summary = Some("final explicit flush state".to_string());
        }
        state.queue_dispatcher_flush(&thread.id).await;

        let persisted_before_flush = read_json::<SessionRecord>(&snapshot_path)
            .await
            .expect("initial dispatcher snapshot");
        assert_ne!(
            persisted_before_flush.summary.as_deref(),
            Some("final explicit flush state")
        );

        state
            .flush_pending_dispatcher_snapshots()
            .await
            .expect("explicit flush should persist immediately");

        let persisted_after_flush = read_json::<SessionRecord>(&snapshot_path)
            .await
            .expect("updated dispatcher snapshot");
        assert_eq!(
            persisted_after_flush.summary.as_deref(),
            Some("final explicit flush state")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn explicit_dispatcher_flush_survives_restart_and_reads_back_latest_state() {
        let (root, state) = build_test_state("dispatcher-flush-restart-readback").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.status = SessionStatus::NeedsInput;
            current.summary = Some("restart durable state".to_string());
        }
        state.queue_dispatcher_flush(&thread.id).await;
        state
            .flush_pending_dispatcher_snapshots()
            .await
            .expect("explicit flush should persist before restart");
        drop(state);

        let reloaded_state = reopen_test_state(&root).await;
        let reloaded_thread = reloaded_state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should reload from disk");
        assert_eq!(reloaded_thread.status, SessionStatus::NeedsInput);
        assert_eq!(
            reloaded_thread.summary.as_deref(),
            Some("restart durable state")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn explicit_dispatcher_flush_requeues_failed_snapshots_until_storage_recovers() {
        let (root, state) = build_test_state("dispatcher-flush-retry").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let store_dir = state.dispatcher_store_dir();
        let blocked_store = root.join("dispatchers-blocked");

        tokio::fs::rename(&store_dir, &blocked_store)
            .await
            .expect("dispatcher store should be movable");
        tokio::fs::write(&store_dir, b"blocked store")
            .await
            .expect("dispatcher store path should be blockable");

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.summary = Some("persist after retry".to_string());
        }
        state.queue_dispatcher_flush(&thread.id).await;

        let flush_error = state
            .flush_pending_dispatcher_snapshots()
            .await
            .expect_err("explicit flush should report storage failures");
        assert!(flush_error
            .to_string()
            .contains("Failed to persist 1 queued dispatcher snapshot"));
        assert!(state
            .pending_dispatcher_flushes
            .lock()
            .await
            .contains(&thread.id));

        tokio::fs::remove_file(&store_dir)
            .await
            .expect("blocking file should be removable");
        tokio::fs::rename(&blocked_store, &store_dir)
            .await
            .expect("dispatcher store should be restorable");

        state
            .flush_pending_dispatcher_snapshots()
            .await
            .expect("explicit flush should retry persisted snapshots after recovery");

        let persisted = read_json::<SessionRecord>(&state.dispatcher_snapshot_path(&thread.id))
            .await
            .expect("persisted dispatcher snapshot");
        assert_eq!(persisted.summary.as_deref(), Some("persist after retry"));
        assert!(!state
            .pending_dispatcher_flushes
            .lock()
            .await
            .contains(&thread.id));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn queued_snapshot_clones_current_state_after_write_guard() {
        let (root, state) = build_test_state("dispatcher-snapshot-race").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.status = SessionStatus::Working;
            current.summary = Some("stale streaming state".to_string());
        }

        let write_guard = state.dispatcher_snapshot_guard(&thread.id).await;
        let held_write = write_guard.lock().await;
        let queued_state = Arc::clone(&state);
        let queued_thread_id = thread.id.clone();
        let queued_write = tokio::spawn(async move {
            queued_state
                .persist_current_dispatcher_snapshot(&queued_thread_id)
                .await
        });
        tokio::task::yield_now().await;

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads.get_mut(&thread.id).expect("dispatcher state");
            current.status = SessionStatus::NeedsInput;
            current.summary = Some("final durable state".to_string());
        }
        drop(held_write);
        queued_write
            .await
            .expect("queued writer task")
            .expect("queued snapshot should persist");

        let persisted = read_json::<SessionRecord>(&state.dispatcher_snapshot_path(&thread.id))
            .await
            .expect("persisted dispatcher snapshot");
        assert_eq!(persisted.status, SessionStatus::NeedsInput);
        assert_eq!(persisted.summary.as_deref(), Some("final durable state"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn deleted_dispatcher_threads_are_not_repersisted_by_stale_snapshot_writes() {
        let (root, state) = build_test_state("dispatcher-delete-stale-persist-race").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let snapshot_path = state.dispatcher_snapshot_path(&thread.id);
        let stale_snapshot = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should exist");

        let write_guard = state.dispatcher_snapshot_guard(&thread.id).await;
        let held_write = write_guard.lock().await;
        let persist_state = Arc::clone(&state);
        let persist_thread = stale_snapshot.clone();
        let persist_task = tokio::spawn(async move {
            persist_state
                .persist_dispatcher_thread(&persist_thread)
                .await
        });
        tokio::task::yield_now().await;

        state
            .delete_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should be deleted");
        timeout(Duration::from_secs(1), async {
            loop {
                if !snapshot_path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dispatcher snapshot should be removed after delete");

        drop(held_write);
        persist_task
            .await
            .expect("stale persist task")
            .expect("stale persist should succeed without rewriting");

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(state.get_dispatcher_thread(&thread.id).await.is_none());
        assert!(!snapshot_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn deleted_dispatcher_threads_are_not_resurrected_by_queued_snapshot_flushes() {
        let (root, state) = build_test_state("dispatcher-delete-queued-flush-race").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let snapshot_path = state.dispatcher_snapshot_path(&thread.id);

        let write_guard = state.dispatcher_snapshot_guard(&thread.id).await;
        let held_write = write_guard.lock().await;
        state.queue_dispatcher_flush(&thread.id).await;
        tokio::time::sleep(Duration::from_millis(175)).await;

        state
            .delete_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should be deleted");
        timeout(Duration::from_secs(1), async {
            loop {
                if !snapshot_path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dispatcher snapshot should be removed after delete");

        drop(held_write);
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(state.get_dispatcher_thread(&thread.id).await.is_none());
        assert!(!snapshot_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn explicit_dispatcher_flush_teardown_skips_deleted_queued_threads() {
        let (root, state) = build_test_state("dispatcher-flush-teardown").await;
        let live_thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("live dispatcher thread should be created");
        let deleted_thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    force_new: true,
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("deleted dispatcher thread should be created");
        let live_snapshot_path = state.dispatcher_snapshot_path(&live_thread.id);
        let deleted_snapshot_path = state.dispatcher_snapshot_path(&deleted_thread.id);

        {
            let mut threads = state.dispatcher_threads.write().await;
            let current = threads
                .get_mut(&live_thread.id)
                .expect("live dispatcher state");
            current.summary = Some("live teardown state".to_string());
        }
        state.queue_dispatcher_flush(&live_thread.id).await;
        state.queue_dispatcher_flush(&deleted_thread.id).await;
        state
            .delete_dispatcher_thread(&deleted_thread.id)
            .await
            .expect("dispatcher thread should be deleted");
        timeout(Duration::from_secs(1), async {
            loop {
                if !deleted_snapshot_path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("deleted dispatcher snapshot should be removed before teardown flush");

        state
            .flush_pending_dispatcher_snapshots()
            .await
            .expect("explicit teardown flush should skip deleted threads");

        let live_persisted = timeout(Duration::from_secs(1), async {
            loop {
                if let Some(snapshot) = read_json::<SessionRecord>(&live_snapshot_path).await {
                    if snapshot.summary.as_deref() == Some("live teardown state") {
                        break snapshot;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("live dispatcher snapshot should converge after teardown flush");
        assert_eq!(
            live_persisted.summary.as_deref(),
            Some("live teardown state")
        );
        assert!(state
            .get_dispatcher_thread(&deleted_thread.id)
            .await
            .is_none());
        assert!(!deleted_snapshot_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn codex_thread_started_metadata_stays_telemetry_only() {
        let (root, state) = build_test_state("acp-codex-thread-started-telemetry").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        thread.agent = "codex".to_string();
        thread.metadata.insert(
            ACP_RESUME_TARGET_METADATA_KEY.to_string(),
            "stale-thread".to_string(),
        );
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");
        let runtime = register_test_dispatcher_runtime(&state, &thread.id).await;

        let mut metadata = HashMap::new();
        metadata.insert(
            "eventKind".to_string(),
            Value::String("thread_started".to_string()),
        );
        metadata.insert(
            "codexThreadId".to_string(),
            Value::String("thread-live".to_string()),
        );
        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                &runtime.runtime_id,
                ExecutorOutput::StructuredStatus {
                    text: String::new(),
                    metadata,
                },
            )
            .await
            .expect("thread started metadata should apply");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(
            updated.metadata.get("codexThreadId").map(String::as_str),
            Some("thread-live")
        );
        assert_eq!(
            updated
                .metadata
                .get(ACP_RESUME_TARGET_METADATA_KEY)
                .map(String::as_str),
            Some("stale-thread")
        );
        assert_eq!(dispatcher_resume_target(&updated, &AgentKind::Codex), None);
        assert!(updated.conversation.iter().all(|entry| {
            !entry.metadata.contains_key("codexThreadId")
                && !entry.metadata.contains_key("nativeResumeTarget")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn completed_dispatcher_turn_summary_ignores_older_assistant_messages() {
        let (root, state) = build_test_state("acp-complete-summary-scope").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        thread.agent = "codex".to_string();
        thread.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "assistant_message".to_string(),
            source: "runtime".to_string(),
            text: "older assistant".to_string(),
            created_at: Utc::now().to_rfc3339(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });
        thread.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "user_message".to_string(),
            source: "chat".to_string(),
            text: "latest prompt".to_string(),
            created_at: Utc::now().to_rfc3339(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });
        thread.summary = None;
        thread.metadata.remove("summary");
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");
        let runtime = register_test_dispatcher_runtime(&state, &thread.id).await;

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                &runtime.runtime_id,
                ExecutorOutput::Completed { exit_code: 0 },
            )
            .await
            .expect("completion should apply");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(
            updated.summary.as_deref(),
            Some("Dispatcher ready for the next turn")
        );
        assert_ne!(updated.summary.as_deref(), Some("older assistant"));

        let _ = fs::remove_dir_all(root);
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
                    runtime: Some("direct".to_string()),
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
        assert!(dispatcher_model_supported_for_agent("pi", "openai/gpt-5.5"));
        assert!(!dispatcher_model_supported_for_agent(
            "claude-code",
            "gpt-5.4"
        ));
    }

    #[test]
    fn dispatcher_model_normalization_remaps_stale_gemini_flash_id() {
        assert_eq!(
            normalize_dispatcher_model_for_agent("gemini", Some(GEMINI_STALE_FLASH_MODEL_ID)),
            Some(GEMINI_FLASH_MODEL_ID.to_string())
        );
        assert_eq!(
            normalize_dispatcher_model_for_agent("gemini", Some("gemini-3.1-pro-preview")),
            Some("gemini-3.1-pro-preview".to_string())
        );
    }

    #[tokio::test]
    async fn dispatcher_runtime_preferences_remap_stale_gemini_flash_id() {
        let (root, state) = build_test_state("acp-gemini-stale-flash-model").await;
        let thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    dispatcher_agent: Some("gemini".to_string()),
                    implementation_agent: Some("gemini".to_string()),
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should be created");

        let updated = state
            .update_dispatcher_runtime_preferences(
                &thread.id,
                Some(GEMINI_STALE_FLASH_MODEL_ID.to_string()),
                None,
            )
            .await
            .expect("stale Gemini flash model should normalize to the live CLI model");

        assert_eq!(updated.model.as_deref(), Some(GEMINI_FLASH_MODEL_ID));
        assert_eq!(
            updated.metadata.get("model").map(String::as_str),
            Some(GEMINI_FLASH_MODEL_ID)
        );
        assert_eq!(
            updated
                .metadata
                .get(ACP_IMPLEMENTATION_MODEL_METADATA_KEY)
                .map(String::as_str),
            Some(GEMINI_FLASH_MODEL_ID)
        );

        let _ = fs::remove_dir_all(root);
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

        assert!(normalize_loaded_dispatcher_thread(&mut thread, false));
        assert_eq!(
            thread.conversation[0].attachments,
            vec!["notes/spec.md".to_string()]
        );
    }

    #[tokio::test]
    async fn load_dispatchers_from_disk_preserves_live_pid_when_termination_disabled() {
        let (root, state) = build_test_state("dispatcher-load-live-pid").await;
        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep child should spawn");
        let pid = child.id().expect("sleep child should have pid");

        let mut thread = SessionRecord::new(
            "dispatcher-load-live-pid".to_string(),
            "demo".to_string(),
            None,
            None,
            Some(root.join("repo").to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "dispatcher prompt".to_string(),
            None,
        );
        thread.status = SessionStatus::Working;
        thread.activity = Some("working".to_string());
        thread.pid = Some(pid);
        thread
            .metadata
            .insert("sessionKind".to_string(), ACP_SESSION_KIND.to_string());
        thread
            .metadata
            .insert("role".to_string(), "orchestrator".to_string());

        let snapshot = state.dispatcher_snapshot_path(&thread.id);
        fs::write(
            &snapshot,
            serde_json::to_string_pretty(&thread).expect("thread should serialize"),
        )
        .expect("dispatcher snapshot should persist");

        state
            .load_dispatchers_from_disk_with_pid_termination(false)
            .await;

        assert!(super::is_process_alive(pid));
        let loaded = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("loaded thread should exist");
        assert_eq!(loaded.pid, Some(pid));
        assert_eq!(loaded.status, SessionStatus::Working);
        assert_eq!(loaded.activity.as_deref(), Some("working"));
        let persisted: SessionRecord = serde_json::from_str(
            &fs::read_to_string(&snapshot).expect("dispatcher snapshot should still exist"),
        )
        .expect("snapshot should deserialize");
        assert_eq!(persisted.pid, Some(pid));
        assert_eq!(persisted.status, SessionStatus::Working);

        let _ = child.kill().await;
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn load_dispatchers_from_disk_terminates_live_process_when_requested() {
        let (root, state) = build_test_state("dispatcher-load-stale-pid").await;
        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep child should spawn");
        let pid = child.id().expect("sleep child should have pid");

        let mut thread = SessionRecord::new(
            "dispatcher-load-stale-pid".to_string(),
            "demo".to_string(),
            None,
            None,
            Some(root.join("repo").to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "dispatcher prompt".to_string(),
            None,
        );
        thread.status = SessionStatus::Working;
        thread.activity = Some("working".to_string());
        thread.pid = Some(pid);
        thread
            .metadata
            .insert("sessionKind".to_string(), ACP_SESSION_KIND.to_string());
        thread
            .metadata
            .insert("role".to_string(), "orchestrator".to_string());

        let snapshot = state.dispatcher_snapshot_path(&thread.id);
        fs::write(
            &snapshot,
            serde_json::to_string_pretty(&thread).expect("thread should serialize"),
        )
        .expect("dispatcher snapshot should persist");

        state
            .load_dispatchers_from_disk_with_pid_termination(true)
            .await;

        let status = timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("stale child should terminate")
            .expect("child wait should succeed");
        assert!(
            !status.success(),
            "stale child should not exit cleanly after termination"
        );

        let loaded = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("loaded thread should exist");
        assert_eq!(loaded.pid, None);
        assert_eq!(loaded.status, SessionStatus::Idle);
        assert_eq!(loaded.activity.as_deref(), Some("idle"));

        let _ = child.kill().await;
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_loaded_dispatcher_thread_restores_pending_plan_reviews_to_needs_input() {
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

        assert!(normalize_loaded_dispatcher_thread(&mut thread, false));
        assert_eq!(thread.status, SessionStatus::NeedsInput);
        assert_eq!(thread.activity.as_deref(), Some("waiting_input"));
        assert_eq!(
            thread
                .metadata
                .get(ACP_APPROVAL_STATE_METADATA_KEY)
                .map(String::as_str),
            Some(ACP_APPROVAL_REQUIRED)
        );
        assert_eq!(
            thread.metadata.get("parserState").map(String::as_str),
            Some("approval_required")
        );
    }

    #[test]
    fn normalize_loaded_dispatcher_thread_restores_working_plan_reviews_to_needs_input() {
        let mut thread = SessionRecord::new(
            "dispatcher-load-approval-working".to_string(),
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
        thread.status = SessionStatus::Working;
        thread.activity = Some("active".to_string());
        thread.summary = Some("Runtime still winding down".to_string());
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

        assert!(normalize_loaded_dispatcher_thread(&mut thread, false));
        assert_eq!(thread.status, SessionStatus::NeedsInput);
        assert_eq!(thread.activity.as_deref(), Some("waiting_input"));
        assert_eq!(
            thread.summary.as_deref(),
            Some(super::ACP_APPROVAL_READY_MESSAGE)
        );
        assert_eq!(
            thread.metadata.get("summary").map(String::as_str),
            Some(super::ACP_APPROVAL_READY_MESSAGE)
        );
        assert_eq!(
            thread.metadata.get("parserState").map(String::as_str),
            Some("approval_required")
        );
    }

    #[test]
    fn runtime_preference_change_clears_stale_plan_approval_metadata() {
        let mut thread = SessionRecord::new(
            "dispatcher-pref-reset-approval".to_string(),
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
        thread.status = SessionStatus::NeedsInput;
        thread.activity = Some("waiting_input".to_string());
        thread.summary = Some("Plan ready".to_string());
        thread.metadata.insert(
            ACP_APPROVAL_STATE_METADATA_KEY.to_string(),
            ACP_APPROVAL_REQUIRED.to_string(),
        );
        thread
            .metadata
            .insert("parserState".to_string(), "approval_required".to_string());

        prepare_dispatcher_for_runtime_preference_change(&mut thread);

        assert_eq!(thread.status, SessionStatus::Idle);
        assert_eq!(thread.activity.as_deref(), Some("idle"));
        assert_eq!(
            thread.summary.as_deref(),
            Some("Dispatcher ready for the next turn")
        );
        assert!(!thread
            .metadata
            .contains_key(ACP_APPROVAL_STATE_METADATA_KEY));
        assert!(!thread.metadata.contains_key("parserState"));
    }

    #[tokio::test]
    async fn headless_plan_only_dispatcher_turn_waits_for_explicit_approval() {
        let (root, state) = build_test_state("acp-headless-plan-only").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        state.executors.write().await.insert(
            AgentKind::Codex,
            Arc::new(DelayedHeadlessExecutor {
                assistant_text: "## Proposed plan\n\n1. Create a task.\n2. Ask for approval."
                    .to_string(),
                delay: Duration::from_millis(200),
            }),
        );

        state
            .send_to_dispatcher_thread(
                &thread.id,
                DispatcherTurnRequest::plain(
                    "plan only".to_string(),
                    Vec::new(),
                    None,
                    None,
                    "chat",
                ),
            )
            .await
            .expect("dispatcher send should succeed");

        let updated = timeout(Duration::from_secs(3), async {
            loop {
                let updated = state
                    .get_dispatcher_thread(&thread.id)
                    .await
                    .expect("dispatcher thread should still exist");
                let has_reply = updated.conversation.iter().any(|entry| {
                    entry.kind == "assistant_message" && entry.text.contains("Proposed plan")
                });
                if has_reply && updated.status == SessionStatus::NeedsInput {
                    break updated;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("plan-only runtime should eventually wait for approval");

        assert_eq!(updated.status, SessionStatus::NeedsInput);
        assert_eq!(updated.activity.as_deref(), Some("waiting_input"));
        assert_eq!(
            updated
                .metadata
                .get(ACP_APPROVAL_STATE_METADATA_KEY)
                .map(String::as_str),
            Some(ACP_APPROVAL_REQUIRED)
        );
        assert_eq!(
            updated.metadata.get("parserState").map(String::as_str),
            Some("approval_required")
        );
        assert!(updated
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("approval"));

        let _ = fs::remove_dir_all(root);
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
                delay: Duration::from_millis(1_500),
            }),
        );

        timeout(
            Duration::from_millis(750),
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

        let updated = timeout(Duration::from_secs(3), async {
            loop {
                let updated = state
                    .get_dispatcher_thread(&thread.id)
                    .await
                    .expect("dispatcher thread should still exist");
                let has_reply = updated.conversation.iter().any(|entry| {
                    entry.kind == "assistant_message"
                        && entry.text.contains("headless assistant reply")
                });
                if has_reply && updated.status == SessionStatus::Idle {
                    break updated;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("headless runtime should eventually emit the assistant reply and reach Idle");
        assert_eq!(updated.status, SessionStatus::Idle);
        assert_eq!(updated.activity.as_deref(), Some("idle"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn interactive_prompt_after_attach_dispatcher_receives_first_turn() {
        let (root, state) = build_test_state("acp-prompt-after-attach").await;
        let thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    dispatcher_agent: Some("letta".to_string()),
                    implementation_agent: Some("letta".to_string()),
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should be created");
        let (observed_input_tx, mut observed_input_rx) = mpsc::unbounded_channel();
        state.executors.write().await.insert(
            AgentKind::Letta,
            Arc::new(PromptAfterAttachExecutor { observed_input_tx }),
        );

        state
            .send_to_dispatcher_thread(
                &thread.id,
                DispatcherTurnRequest::plain(
                    "Ship through Letta".to_string(),
                    Vec::new(),
                    None,
                    None,
                    "chat",
                ),
            )
            .await
            .expect("dispatcher send should succeed");

        let prompt = timeout(Duration::from_secs(3), observed_input_rx.recv())
            .await
            .expect("interactive prompt should be sent after runtime attach")
            .expect("interactive prompt channel should remain open");
        assert!(prompt.contains("Ship through Letta"));
        assert!(prompt.to_ascii_lowercase().contains("letta"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn stale_runtime_replacement_failure_persists_errored_dispatcher_and_clears_runtime_state(
    ) {
        let (root, state) = build_test_state("acp-stale-runtime-recovery").await;
        let mut thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    dispatcher_agent: Some("letta".to_string()),
                    implementation_agent: Some("letta".to_string()),
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should be created");
        thread.status = SessionStatus::NeedsInput;
        thread.activity = Some("waiting_input".to_string());
        thread.metadata.insert(
            ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY.to_string(),
            "codex".to_string(),
        );
        thread.metadata.insert(
            ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY.to_string(),
            "gpt-5.4".to_string(),
        );
        thread
            .metadata
            .insert("startedAt".to_string(), Utc::now().to_rfc3339());
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");

        let (input_tx, _input_rx) = mpsc::channel(1);
        let (kill_tx, kill_rx) = oneshot::channel();
        let _runtime_handle = state
            .store_dispatcher_runtime(&thread.id, input_tx, true, kill_tx)
            .await;

        state.executors.write().await.insert(
            AgentKind::Letta,
            Arc::new(FailingSpawnExecutor {
                error: "Error: Missing Letta binary\n    at spawn (file:///tmp/letta.js:1:1)"
                    .to_string(),
            }),
        );

        let error = state
            .send_to_dispatcher_thread(
                &thread.id,
                DispatcherTurnRequest::plain(
                    "Retry the dispatcher".to_string(),
                    Vec::new(),
                    None,
                    None,
                    "chat",
                ),
            )
            .await
            .expect_err("runtime recovery should fail");
        assert!(
            error.to_string().contains("Missing Letta binary"),
            "unexpected send error: {error}"
        );

        timeout(Duration::from_secs(1), kill_rx)
            .await
            .expect("stale runtime should be interrupted")
            .expect("kill signal should be sent");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(updated.status, SessionStatus::Errored);
        assert_eq!(updated.activity.as_deref(), Some("exited"));
        assert_eq!(updated.pid, None);
        assert_eq!(
            updated.metadata.get("error").map(String::as_str),
            Some("Failed to recover dispatcher runtime: Missing Letta binary")
        );
        assert_eq!(
            updated.summary.as_deref(),
            Some("Failed to recover dispatcher runtime: Missing Letta binary")
        );
        assert!(!updated
            .metadata
            .contains_key(ACP_RUNTIME_LAUNCH_AGENT_METADATA_KEY));
        assert!(!updated
            .metadata
            .contains_key(ACP_RUNTIME_LAUNCH_MODEL_METADATA_KEY));
        assert!(!updated.metadata.contains_key("startedAt"));
        assert!(!state.dispatcher_runtime_attached(&thread.id).await);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn runtime_events_refresh_session_memory_artifacts() {
        let (root, state) = build_test_state("acp-runtime-memory-sync").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        let runtime = register_test_dispatcher_runtime(&state, &thread.id).await;

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                &runtime.runtime_id,
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
    async fn stale_runtime_events_do_not_override_replacement_runtime_state() {
        let (root, state) = build_test_state("acp-stale-runtime-events").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        thread.status = SessionStatus::Working;
        thread.activity = Some("active".to_string());
        thread.summary = Some("current runtime".to_string());
        thread.output = "current output".to_string();
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");

        let (old_input_tx, _old_input_rx) = mpsc::channel(1);
        let (old_kill_tx, _old_kill_rx) = oneshot::channel();
        let old_runtime = state
            .store_dispatcher_runtime(&thread.id, old_input_tx, true, old_kill_tx)
            .await;

        let (new_input_tx, _new_input_rx) = mpsc::channel(1);
        let (new_kill_tx, _new_kill_rx) = oneshot::channel();
        let new_runtime = state
            .store_dispatcher_runtime(&thread.id, new_input_tx, true, new_kill_tx)
            .await;

        for event in [
            ExecutorOutput::Stdout("stale stdout".to_string()),
            ExecutorOutput::Stderr("stale stderr".to_string()),
            ExecutorOutput::Failed {
                error: "killed".to_string(),
                exit_code: None,
            },
            ExecutorOutput::Failed {
                error: "stale failure".to_string(),
                exit_code: Some(1),
            },
            ExecutorOutput::Completed { exit_code: 1 },
        ] {
            state
                .apply_dispatcher_runtime_event(&thread.id, &old_runtime.runtime_id, event)
                .await
                .expect("stale runtime event should be ignored");
        }

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(updated.status, SessionStatus::Working);
        assert_eq!(updated.activity.as_deref(), Some("active"));
        assert_eq!(updated.summary.as_deref(), Some("current runtime"));
        assert_eq!(updated.output, "current output");
        assert!(!updated.metadata.contains_key("lastStderr"));
        assert!(!updated.metadata.contains_key("exitCode"));
        assert!(!updated.metadata.contains_key("finishedAt"));

        let active_runtime = state
            .dispatcher_runtime_handle(&thread.id)
            .await
            .expect("replacement runtime should remain attached");
        assert_eq!(active_runtime.runtime_id, new_runtime.runtime_id);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn retired_runtime_events_are_ignored_once_no_active_handle_remains() {
        let (root, state) = build_test_state("acp-retired-runtime-no-handle").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");
        thread.status = SessionStatus::Working;
        thread.activity = Some("active".to_string());
        thread.summary = Some("replacement pending".to_string());
        thread.output = "current output".to_string();
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("dispatcher thread should persist");

        let retired_runtime = register_test_dispatcher_runtime(&state, &thread.id).await;
        state.clear_dispatcher_runtime(&thread.id).await;

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                &retired_runtime.runtime_id,
                ExecutorOutput::Failed {
                    error: "stale failure".to_string(),
                    exit_code: Some(1),
                },
            )
            .await
            .expect("retired runtime event should be ignored");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(updated.status, SessionStatus::Working);
        assert_eq!(updated.activity.as_deref(), Some("active"));
        assert_eq!(updated.summary.as_deref(), Some("replacement pending"));
        assert_eq!(updated.output, "current output");
        assert!(!updated.metadata.contains_key("error"));
        assert!(!updated.metadata.contains_key("exitCode"));
        assert!(!updated.metadata.contains_key("finishedAt"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn busy_dispatcher_becomes_sendable_after_runtime_preference_change() {
        let (root, state) = build_test_state("acp-pref-change-sendable").await;
        let mut thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        thread.status = SessionStatus::Working;
        thread.activity = Some("active".to_string());
        thread.summary = Some("current runtime".to_string());
        thread.output = "current output".to_string();
        thread.pid = Some(4242);
        thread
            .metadata
            .insert("startedAt".to_string(), Utc::now().to_rfc3339());
        state
            .replace_dispatcher_thread(thread.clone())
            .await
            .expect("busy dispatcher thread should persist");

        let (input_tx, _input_rx) = mpsc::channel(1);
        let (kill_tx, mut kill_rx) = oneshot::channel();
        let retired_runtime = state
            .store_dispatcher_runtime(&thread.id, input_tx, true, kill_tx)
            .await;
        assert!(state.dispatcher_runtime_attached(&thread.id).await);

        state.executors.write().await.insert(
            AgentKind::Codex,
            Arc::new(DelayedHeadlessExecutor {
                assistant_text: "slow reply".to_string(),
                delay: Duration::from_secs(5),
            }),
        );

        let updated = state
            .update_dispatcher_preferences(
                &thread.id,
                DispatcherPreferencesPatch {
                    dispatcher_model: Some("gpt-5.4".to_string()),
                    ..DispatcherPreferencesPatch::default()
                },
            )
            .await
            .expect("dispatcher preferences should update");

        assert_eq!(updated.status, SessionStatus::Idle);
        assert_eq!(updated.activity.as_deref(), Some("idle"));
        assert_eq!(
            updated.summary.as_deref(),
            Some("Dispatcher ready for the next turn")
        );
        assert_eq!(updated.pid, None);
        assert_eq!(updated.model.as_deref(), Some("gpt-5.4"));
        assert!(!updated.metadata.contains_key("startedAt"));
        assert!(!updated.metadata.contains_key("lastStderr"));
        assert!(!updated.metadata.contains_key("exitCode"));
        assert!(!updated.metadata.contains_key("finishedAt"));
        assert!(!state.dispatcher_runtime_attached(&thread.id).await);
        timeout(Duration::from_secs(1), &mut kill_rx)
            .await
            .expect("retired runtime should be interrupted")
            .expect("retired runtime kill signal should be delivered");

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                &retired_runtime.runtime_id,
                ExecutorOutput::Failed {
                    error: "killed".to_string(),
                    exit_code: None,
                },
            )
            .await
            .expect("retired runtime event should be ignored");

        timeout(
            Duration::from_millis(750),
            state.send_to_dispatcher_thread(
                &thread.id,
                DispatcherTurnRequest::plain(
                    "Second turn".to_string(),
                    Vec::new(),
                    None,
                    None,
                    "chat",
                ),
            ),
        )
        .await
        .expect("second dispatcher send should not block")
        .expect("dispatcher should become sendable again");

        let resent = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(resent.status, SessionStatus::Working);
        assert_eq!(resent.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(resent.activity.as_deref(), Some("active"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn dispatcher_turn_start_clears_stale_last_stderr() {
        let (root, state) = build_test_state("acp-turn-clears-stderr").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        state.executors.write().await.insert(
            AgentKind::Codex,
            Arc::new(DelayedHeadlessExecutor {
                assistant_text: "slow reply".to_string(),
                delay: Duration::from_secs(5),
            }),
        );

        let mut stale = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should exist");
        stale
            .metadata
            .insert("lastStderr".to_string(), "stale stderr".to_string());
        stale
            .metadata
            .insert("error".to_string(), "stale stderr".to_string());
        stale.summary = Some("stale stderr".to_string());
        stale
            .metadata
            .insert("summary".to_string(), "stale stderr".to_string());
        state
            .replace_dispatcher_thread(stale)
            .await
            .expect("stale dispatcher thread should persist");

        state
            .send_to_dispatcher_thread(
                &thread.id,
                DispatcherTurnRequest::plain(
                    "New turn".to_string(),
                    Vec::new(),
                    None,
                    None,
                    "chat",
                ),
            )
            .await
            .expect("dispatcher turn should start");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(updated.status, SessionStatus::Working);
        assert_eq!(updated.activity.as_deref(), Some("active"));
        assert!(!updated.metadata.contains_key("lastStderr"));
        assert!(!updated.metadata.contains_key("error"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn dispatcher_transition_guard_blocks_turn_start_until_runtime_resets_finish() {
        let (root, state) = build_test_state("acp-transition-guard-send").await;
        let thread = state
            .create_project_dispatcher_thread("demo", CreateDispatcherThreadOptions::default())
            .await
            .expect("dispatcher thread should be created");

        state.executors.write().await.insert(
            AgentKind::Codex,
            Arc::new(DelayedHeadlessExecutor {
                assistant_text: "guarded reply".to_string(),
                delay: Duration::from_secs(5),
            }),
        );

        let transition_guard = state.dispatcher_transition_guard(&thread.id).await;
        let transition_lock = transition_guard.lock().await;

        let state_for_send = Arc::clone(&state);
        let thread_id = thread.id.clone();
        let mut send_task = tokio::spawn(async move {
            state_for_send
                .send_to_dispatcher_thread(
                    &thread_id,
                    DispatcherTurnRequest::plain(
                        "Blocked turn".to_string(),
                        Vec::new(),
                        None,
                        None,
                        "chat",
                    ),
                )
                .await
        });

        assert!(
            timeout(Duration::from_millis(150), &mut send_task)
                .await
                .is_err(),
            "turn start should wait for an in-flight dispatcher transition"
        );

        let still_idle = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(still_idle.status, SessionStatus::Idle);

        drop(transition_lock);

        send_task
            .await
            .expect("send task should join cleanly")
            .expect("dispatcher send should succeed once the transition completes");

        let updated = state
            .get_dispatcher_thread(&thread.id)
            .await
            .expect("dispatcher thread should remain available");
        assert_eq!(updated.status, SessionStatus::Working);
        assert_eq!(updated.activity.as_deref(), Some("active"));

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

        let updated = state
            .update_dispatcher_preferences(
                &thread.id,
                DispatcherPreferencesPatch {
                    dispatcher_agent: Some("letta-code".to_string()),
                    implementation_agent: Some("letta-code".to_string()),
                    openclaw_config: OpenClawDispatcherConfigPatch::default(),
                    ..DispatcherPreferencesPatch::default()
                },
            )
            .await
            .expect("dispatcher preferences should accept letta aliases");

        assert_eq!(updated.agent, "letta");
        assert_eq!(
            updated
                .metadata
                .get(ACP_IMPLEMENTATION_AGENT_METADATA_KEY)
                .map(String::as_str),
            Some("letta")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn create_dispatcher_thread_rejects_explicit_unsupported_dispatcher_agent() {
        let (root, state) = build_test_state("acp-dispatcher-invalid-create").await;

        let error = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    dispatcher_agent: Some("cursor-cli".to_string()),
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect_err("unsupported dispatcher agent should be rejected");

        assert!(
            error
                .to_string()
                .contains("Unsupported dispatcher agent `cursor-cli`"),
            "unexpected error: {error}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn implementation_only_preference_updates_do_not_mutate_dispatcher_runtime() {
        let (root, state) = build_test_state("acp-dispatcher-impl-only-patch").await;
        let thread = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    dispatcher_agent: Some("codex".to_string()),
                    dispatcher_model: Some("gpt-5.4".to_string()),
                    dispatcher_reasoning_effort: Some("high".to_string()),
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should be created");

        let updated = state
            .update_dispatcher_preferences(
                &thread.id,
                DispatcherPreferencesPatch {
                    implementation_agent: Some("cursor-cli".to_string()),
                    implementation_model: Some("auto".to_string()),
                    implementation_reasoning_effort: Some("medium".to_string()),
                    ..DispatcherPreferencesPatch::default()
                },
            )
            .await
            .expect("implementation-only preferences should update");

        assert_eq!(updated.agent, "codex");
        assert_eq!(updated.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(updated.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            updated
                .metadata
                .get(ACP_IMPLEMENTATION_AGENT_METADATA_KEY)
                .map(String::as_str),
            Some("cursor-cli")
        );
        assert_eq!(
            updated
                .metadata
                .get(ACP_IMPLEMENTATION_MODEL_METADATA_KEY)
                .map(String::as_str),
            Some("auto")
        );
        assert_eq!(
            updated
                .metadata
                .get(ACP_IMPLEMENTATION_REASONING_METADATA_KEY)
                .map(String::as_str),
            Some("medium")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn dispatcher_preferences_store_openclaw_runtime_config() {
        let (root, state) = build_test_state("acp-openclaw-config").await;
        let gateway_token = ["gateway", "-token-", "123"].concat();
        let session_key = ["external:", "issue", ":123"].concat();
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
    async fn omitted_dispatcher_agent_prefers_project_then_global_then_codex() {
        let (root, state) = build_test_state("acp-dispatcher-agent-fallbacks").await;

        {
            let mut config = state.config.write().await;
            config.preferences.coding_agent = "claude-code".to_string();
            config
                .projects
                .get_mut("demo")
                .expect("demo project should exist")
                .agent = Some("gemini".to_string());
        }
        let project_preferred = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    force_new: true,
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should use the supported project agent");
        assert_eq!(project_preferred.agent, "gemini");

        {
            let mut config = state.config.write().await;
            config
                .projects
                .get_mut("demo")
                .expect("demo project should exist")
                .agent = Some("cursor-cli".to_string());
        }
        let global_preferred = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    force_new: true,
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should fall back to the global coding agent");
        assert_eq!(global_preferred.agent, "claude-code");

        {
            let mut config = state.config.write().await;
            config.preferences.coding_agent = "cursor-cli".to_string();
        }
        let codex_fallback = state
            .create_project_dispatcher_thread(
                "demo",
                CreateDispatcherThreadOptions {
                    force_new: true,
                    ..CreateDispatcherThreadOptions::default()
                },
            )
            .await
            .expect("dispatcher thread should fall back to codex");
        assert_eq!(codex_fallback.agent, "codex");

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
        let runtime = register_test_dispatcher_runtime(&state, &thread.id).await;

        state
            .apply_dispatcher_runtime_event(
                &thread.id,
                &runtime.runtime_id,
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
    async fn headless_runtime_with_closed_input_is_cleared() {
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

        assert!(!state.dispatcher_runtime_attached(&thread.id).await);
        assert!(state.dispatcher_runtime_input(&thread.id).await.is_none());
        assert!(!state.dispatcher_runtime_attached(&thread.id).await);

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
