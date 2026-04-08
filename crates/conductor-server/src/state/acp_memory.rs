//! ACP memory types and rendering for dispatcher sessions.
//!
//! Handles project memory (long-term directives, task refs) and session memory
//! (heartbeat state, recent conversation, board activity).

use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::acp_dispatcher::ACP_ACTIVE_SKILLS_METADATA_KEY;
use super::types::ConversationEntry;

pub(crate) const ACP_MEMORY_VERSION: u8 = 1;
pub(crate) const ACP_SHORT_TERM_LIMIT: usize = 8;
pub(crate) const ACP_LONG_TERM_LIMIT: usize = 24;
pub(crate) const ACP_RECENT_BOARD_ACTIVITY_LIMIT: usize = 8;
pub(crate) const ACP_MAX_NOTE_CHARS: usize = 320;
pub(crate) const ACP_HEARTBEAT_INTERVAL: ChronoDuration = ChronoDuration::minutes(15);

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

pub(crate) fn clip_text(value: &str, max_chars: usize) -> String {
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

pub(crate) fn conversation_note(entry: &ConversationEntry) -> Option<AcpMemoryNote> {
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

pub(crate) fn extract_task_refs(value: &str) -> Vec<String> {
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

pub(crate) fn should_promote_to_long_term_memory(message: &str) -> bool {
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

pub(crate) fn render_project_memory_markdown(memory: &AcpProjectMemoryState) -> String {
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

pub(crate) fn render_session_memory_markdown(memory: &AcpSessionMemoryState) -> String {
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

pub(crate) fn update_active_skills_metadata(
    session: &mut super::SessionRecord,
    active_skills: &[String],
) {
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
        session.metadata.insert(
            ACP_ACTIVE_SKILLS_METADATA_KEY.to_string(),
            serialized,
        );
    } else {
        session
            .metadata
            .remove(ACP_ACTIVE_SKILLS_METADATA_KEY);
    }
}
