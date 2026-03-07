use serde_json::{json, Value};
use std::path::Path;

use super::types::{SessionRecord, DEFAULT_OUTPUT_LIMIT_BYTES, DEFAULT_SESSION_HISTORY_LIMIT};

pub fn session_to_dashboard_value(session: &SessionRecord) -> Value {
    json!({
        "id": session.id,
        "projectId": session.project_id,
        "status": session.status,
        "activity": session.activity,
        "branch": session.branch,
        "issueId": session.issue_id,
        "summary": session.summary,
        "createdAt": session.created_at,
        "lastActivityAt": session.last_activity_at,
        "pr": session.pr,
        "metadata": session.metadata,
    })
}

pub fn resolve_board_file(workspace_path: &Path, board_dir: &str, project_path: Option<&str>) -> String {
    let mut candidates = Vec::new();
    let trimmed = board_dir.trim();
    if !trimmed.is_empty() {
        if trimmed.ends_with(".md") {
            candidates.push(trimmed.to_string());
            candidates.push(format!("projects/{trimmed}"));
        } else {
            candidates.push(format!("{trimmed}/CONDUCTOR.md"));
            candidates.push(format!("projects/{trimmed}/CONDUCTOR.md"));
        }
    }
    if let Some(project_path_value) = project_path {
        let path = Path::new(project_path_value);
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            candidates.push(format!("{name}/CONDUCTOR.md"));
            candidates.push(format!("projects/{name}/CONDUCTOR.md"));
        }
    }
    candidates.push("CONDUCTOR.md".to_string());
    for candidate in &candidates {
        if workspace_path.join(candidate).exists() {
            return candidate.clone();
        }
    }
    candidates.into_iter().next().unwrap_or_else(|| "CONDUCTOR.md".to_string())
}

pub fn trim_lines_tail(output: &str, lines: usize) -> String {
    let mut collected = output.lines().rev().take(lines).collect::<Vec<_>>();
    collected.reverse();
    collected.join("\n")
}

pub fn build_normalized_chat_feed(session: &SessionRecord) -> Vec<Value> {
    let mut feed = Vec::new();

    if let Some(summary) = session.summary.as_ref().filter(|value| !value.trim().is_empty()) {
        feed.push(json!({
            "id": format!("status-{}", session.id),
            "kind": "status",
            "label": "Session",
            "text": format!("{}\n\nSession status: {}", summary, session.status),
            "createdAt": Value::Null,
            "attachments": [],
            "source": "session-status",
            "streaming": session.status == "working",
            "metadata": { "status": session.status },
        }));
    }

    for entry in &session.conversation {
        let kind = match entry.kind.as_str() {
            "user_message" => "user",
            "system_message" => "system",
            _ => "status",
        };
        let label = match entry.kind.as_str() {
            "user_message" if entry.source == "feedback" => "Feedback",
            "user_message" => "You",
            "system_message" if entry.source == "restore" => "Restored",
            "system_message" => "System",
            _ => "Session",
        };
        feed.push(json!({
            "id": entry.id,
            "kind": kind,
            "label": label,
            "text": entry.text,
            "createdAt": entry.created_at,
            "attachments": entry.attachments,
            "source": entry.source,
            "streaming": false,
            "metadata": entry.metadata,
        }));
    }

    let assistant_output = session.output.trim();
    if !assistant_output.is_empty() {
        feed.push(json!({
            "id": format!("assistant-{}", session.id),
            "kind": "assistant",
            "label": "Assistant",
            "text": assistant_output,
            "createdAt": Value::Null,
            "attachments": [],
            "source": "runtime-output",
            "streaming": session.status == "working",
            "metadata": {},
        }));
    }

    if feed.len() > DEFAULT_SESSION_HISTORY_LIMIT {
        feed = feed.split_off(feed.len() - DEFAULT_SESSION_HISTORY_LIMIT);
    }

    feed
}

pub fn normalize_loaded_session(session: &mut SessionRecord) -> bool {
    let normalized_status = session.status.trim().to_lowercase();
    let normalized_activity = session
        .activity
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    if normalized_status != "working" && normalized_status != "running" && normalized_activity != "active" {
        return false;
    }

    session.status = "errored".to_string();
    session.activity = Some("exited".to_string());
    if session.summary.as_ref().map(|value| value.trim().is_empty()).unwrap_or(true) {
        session.summary = Some("Interrupted after backend restart".to_string());
    }
    if session.metadata.get("summary").map(|value| value.trim().is_empty()).unwrap_or(true) {
        session
            .metadata
            .insert("summary".to_string(), "Interrupted after backend restart".to_string());
    }
    true
}

pub fn append_output(session: &mut SessionRecord, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if !session.output.is_empty() {
        session.output.push('\n');
    }
    session.output.push_str(line.trim_end());
    if session.output.len() > DEFAULT_OUTPUT_LIMIT_BYTES {
        let start = session.output.len().saturating_sub(DEFAULT_OUTPUT_LIMIT_BYTES);
        session.output = session.output[start..].to_string();
    }
}

pub fn is_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "merged" | "killed" | "cleanup" | "done" | "terminated" | "errored"
    )
}
