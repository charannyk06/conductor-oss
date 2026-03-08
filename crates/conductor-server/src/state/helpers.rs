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

fn is_command_like_line(line: &str) -> bool {
    let normalized = line.trim();
    if normalized.is_empty() {
        return false;
    }

    if normalized.contains("&&")
        || normalized.starts_with("/bin/")
        || normalized.starts_with("bash -lc ")
        || normalized.starts_with("zsh -lc ")
        || normalized.contains(" -lc '")
        || normalized.contains(" -lc \"")
    {
        return true;
    }

    // Reject lines that look like natural language sentences (contain multiple words
    // with common prose indicators) to avoid misclassifying LLM explanations.
    let word_count = normalized.split_whitespace().count();
    if word_count > 8 {
        return false;
    }

    let first = normalized
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(|char: char| char == '$' || char == '`');

    matches!(
        first,
        "git"
            | "pnpm"
            | "npm"
            | "npx"
            | "yarn"
            | "cargo"
            | "bun"
            | "node"
            | "ls"
            | "cd"
            | "cat"
            | "rg"
            | "find"
            | "sed"
            | "touch"
            | "mkdir"
            | "rm"
            | "cp"
            | "mv"
            | "gh"
            | "python"
            | "uv"
    )
}

pub(super) fn is_runtime_status_line(line: &str) -> bool {
    let normalized = line.trim();
    if normalized.is_empty() {
        return false;
    }

    let lower = normalized.to_lowercase();
    lower == "thinking"
        || lower.starts_with("thinking ")
        || lower.starts_with("searched ")
        || runtime_tool_metadata(normalized).is_some()
}

fn is_streaming_status(status: &str) -> bool {
    matches!(status.trim().to_lowercase().as_str(), "working" | "running")
}

pub(super) fn runtime_tool_metadata(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();

    if let Some(tool_name) = trimmed
        .strip_prefix("[tool:")
        .and_then(|value| value.strip_suffix(']'))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(json!({
            "toolKind": "tool_use",
            "toolTitle": tool_name,
            "toolStatus": "running",
            "toolContent": [trimmed],
        }));
    }

    if lower == "thinking" || lower.starts_with("thinking ") {
        let detail = trimmed
            .strip_prefix("Thinking")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(trimmed);
        return Some(json!({
            "toolKind": "thinking",
            "toolTitle": "Thinking",
            "toolStatus": "running",
            "toolContent": [detail],
        }));
    }

    if lower.starts_with("web search") {
        let detail = trimmed
            .strip_prefix("Web Search")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(trimmed);
        return Some(json!({
            "toolKind": "websearch",
            "toolTitle": "Web Search",
            "toolStatus": "running",
            "toolContent": [detail],
        }));
    }

    if lower.starts_with("websearch") {
        let detail = trimmed
            .strip_prefix("WebSearch")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(trimmed);
        return Some(json!({
            "toolKind": "websearch",
            "toolTitle": "Web Search",
            "toolStatus": "running",
            "toolContent": [detail],
        }));
    }

    if lower.starts_with("web fetch") || lower.starts_with("webfetch") {
        let detail = trimmed
            .strip_prefix("Web Fetch")
            .or_else(|| trimmed.strip_prefix("WebFetch"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(trimmed);
        return Some(json!({
            "toolKind": "webfetch",
            "toolTitle": "Web Fetch",
            "toolStatus": "running",
            "toolContent": [detail],
        }));
    }

    let head = trimmed
        .split(|char: char| char.is_whitespace() || char == '(' || char == ':')
        .next()
        .unwrap_or_default()
        .trim();

    let known_tool = match head.to_ascii_lowercase().as_str() {
        "read" => Some(("read", "Read")),
        "write" => Some(("write", "Write")),
        "edit" => Some(("edit", "Edit")),
        "multiedit" => Some(("multiedit", "MultiEdit")),
        "grep" => Some(("grep", "Grep")),
        "glob" => Some(("glob", "Glob")),
        "ls" => Some(("ls", "LS")),
        "bash" => Some(("bash", "Bash")),
        "task" => Some(("task", "Task")),
        "todowrite" => Some(("todowrite", "TodoWrite")),
        "webfetch" => Some(("webfetch", "WebFetch")),
        "websearch" => Some(("websearch", "WebSearch")),
        "search" => Some(("search", "Search")),
        "find" => Some(("find", "Find")),
        "open" => Some(("open", "Open")),
        _ => None,
    };

    if let Some((tool_kind, tool_title)) = known_tool {
        return Some(json!({
            "toolKind": tool_kind,
            "toolTitle": tool_title,
            "toolStatus": "running",
            "toolContent": [trimmed],
        }));
    }

    if trimmed.starts_with("Running ")
        || trimmed.starts_with("Executed ")
        || trimmed.starts_with("Tool ")
        || is_command_like_line(trimmed)
    {
        return Some(json!({
            "toolKind": "command",
            "toolTitle": trimmed,
            "toolStatus": "running",
            "toolContent": [trimmed],
        }));
    }

    None
}

pub(super) fn merge_assistant_fragment(current: &mut String, fragment: &str) {
    let trimmed = fragment.trim();
    if trimmed.is_empty() {
        return;
    }

    if current.is_empty() {
        current.push_str(trimmed);
        return;
    }

    if current == trimmed || current.ends_with(trimmed) {
        return;
    }
    // Cap contains check to last 512 bytes to avoid O(n*m) on large buffers.
    let tail_start = current.len().saturating_sub(512);
    let check_region = &current[tail_start..];
    if check_region.contains(trimmed) {
        return;
    }

    if trimmed.starts_with(current.as_str()) {
        current.clear();
        current.push_str(trimmed);
        return;
    }

    current.push('\n');
    current.push_str(trimmed);
}

fn is_runtime_transport_event_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') || !trimmed.contains("\"type\"") {
        return false;
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };

    matches!(
        value.get("type").and_then(Value::as_str),
        Some("system" | "assistant" | "user" | "tool_use" | "result" | "input_request" | "rate_limit_event")
    )
}

fn is_runtime_transport_dump(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.starts_with("{\"type\":\"")
        && (trimmed.contains("\"session_id\":\"")
            || trimmed.contains("\"tool_use_result\":")
            || trimmed.contains("\"parent_tool_use_id\":")
            || trimmed.contains("\"rate_limit_info\":"))
    {
        return true;
    }

    let mut saw_event = false;
    for line in trimmed.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !is_runtime_transport_event_line(line) {
            return false;
        }
        saw_event = true;
    }
    saw_event
}

fn build_runtime_output_entries(session: &SessionRecord) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut assistant_text = String::new();
    let mut assistant_index = 0usize;
    let mut status_index = 0usize;
    let is_streaming = matches!(session.status.trim().to_lowercase().as_str(), "working" | "running");

    let flush_assistant = |streaming: bool, entries: &mut Vec<Value>, assistant_text: &mut String, assistant_index: &mut usize| {
        let text = assistant_text.trim();
        if text.is_empty() {
            assistant_text.clear();
            return;
        }

        entries.push(json!({
            "id": format!("assistant-{}-{assistant_index}", session.id),
            "kind": "assistant",
            "label": "Assistant",
            "text": text,
            "createdAt": Value::Null,
            "attachments": [],
            "source": "runtime-output",
            "streaming": streaming,
            "metadata": {},
        }));
        *assistant_index += 1;
        assistant_text.clear();
    };

    for raw_line in session.output.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("[stderr]") {
            continue;
        }

        if is_runtime_transport_event_line(line) {
            continue;
        }

        if matches!(line, "codex" | "qwen" | "gemini" | "claude") {
            continue;
        }

        if is_runtime_status_line(line) {
            flush_assistant(false, &mut entries, &mut assistant_text, &mut assistant_index);
            let metadata = runtime_tool_metadata(line).unwrap_or_else(|| json!({}));
            let kind = if metadata.get("toolTitle").is_some() { "tool" } else { "status" };
            entries.push(json!({
                "id": format!("runtime-status-{}-{status_index}", session.id),
                "kind": kind,
                "label": "Session",
                "text": line,
                "createdAt": Value::Null,
                "attachments": [],
                "source": "runtime-output",
                "streaming": false,
                "metadata": metadata,
            }));
            status_index += 1;
            continue;
        }

        merge_assistant_fragment(&mut assistant_text, line);
    }

    flush_assistant(is_streaming, &mut entries, &mut assistant_text, &mut assistant_index);
    entries
}

fn push_runtime_assistant_segments(
    feed: &mut Vec<Value>,
    entry: &super::types::ConversationEntry,
    streaming: bool,
) {
    let mut assistant_text = String::new();
    let mut segment_index = 0usize;

    let flush_assistant = |feed: &mut Vec<Value>, assistant_text: &mut String, segment_index: &mut usize| {
        let text = assistant_text.trim();
        if text.is_empty() {
            assistant_text.clear();
            return;
        }

        feed.push(json!({
            "id": format!("{}-assistant-{segment_index}", entry.id),
            "kind": "assistant",
            "label": "Assistant",
            "text": text,
            "createdAt": entry.created_at,
            "attachments": entry.attachments,
            "source": entry.source,
            "streaming": streaming,
            "metadata": entry.metadata,
        }));
        *segment_index += 1;
        assistant_text.clear();
    };

    for raw_line in entry.text.lines() {
        let trimmed_end = raw_line.trim_end();
        let normalized = trimmed_end.trim();

        if normalized.is_empty() {
            if !assistant_text.is_empty() && !assistant_text.ends_with("\n\n") {
                assistant_text.push_str("\n\n");
            }
            continue;
        }

        if let Some(metadata) = runtime_tool_metadata(normalized) {
            flush_assistant(feed, &mut assistant_text, &mut segment_index);
            feed.push(json!({
                "id": format!("{}-tool-{segment_index}", entry.id),
                "kind": "tool",
                "label": "Tool",
                "text": normalized,
                "createdAt": entry.created_at,
                "attachments": [],
                "source": entry.source,
                "streaming": false,
                "metadata": metadata,
            }));
            segment_index += 1;
            continue;
        }

        if !assistant_text.is_empty() && !assistant_text.ends_with('\n') && !assistant_text.ends_with("\n\n") {
            assistant_text.push('\n');
        }
        assistant_text.push_str(normalized);
    }

    flush_assistant(feed, &mut assistant_text, &mut segment_index);
}

fn build_session_status_entry(session: &SessionRecord, runtime_entries: &[Value]) -> Option<Value> {
    let normalized_status = session.status.trim().to_lowercase();
    if normalized_status == "working" || normalized_status == "running" {
        return None;
    }

    let last_assistant_text = session
        .conversation
        .iter()
        .rev()
        .find(|entry| entry.kind == "assistant_message")
        .map(|entry| entry.text.trim())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            runtime_entries
                .iter()
                .rev()
                .find(|entry| entry.get("kind").and_then(|value| value.as_str()) == Some("assistant"))
                .and_then(|entry| entry.get("text").and_then(|value| value.as_str()))
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });

    let summary = session
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| Some(*value) != last_assistant_text);
    let summary = if matches!(normalized_status.as_str(), "needs_input" | "done")
        && summary
            .map(|value| value.contains('\n') || value.len() > 280)
            .unwrap_or(false)
    {
        None
    } else {
        summary
    };

    if normalized_status == "done" && last_assistant_text.is_some() {
        return None;
    }

    let mut parts = Vec::new();
    if let Some(summary_text) = summary {
        parts.push(summary_text.to_string());
    }
    if (normalized_status != "done" || parts.is_empty())
        && !session.status.trim().is_empty()
    {
        parts.push(format!("Session status: {}", session.status));
    }

    if parts.is_empty() {
        return None;
    }

    Some(json!({
        "id": format!("status-{}", session.id),
        "kind": "status",
        "label": "Session",
        "text": parts.join("\n\n"),
        "createdAt": Value::Null,
        "attachments": [],
        "source": "session-status",
        "streaming": false,
        "metadata": { "status": session.status },
    }))
}

pub fn build_normalized_chat_feed(session: &SessionRecord) -> Vec<Value> {
    let mut feed = Vec::new();
    let is_streaming = is_streaming_status(&session.status);
    let last_runtime_assistant_id = if is_streaming {
        session
            .conversation
            .iter()
            .rev()
            .find(|entry| {
                entry.kind == "assistant_message"
                    && entry.source == "runtime"
                    && !is_runtime_transport_dump(&entry.text)
            })
            .map(|entry| entry.id.clone())
    } else {
        None
    };
    let has_structured_runtime_entries = session
        .conversation
        .iter()
        .any(|entry| {
            matches!(entry.kind.as_str(), "assistant_message" | "status_message")
                && entry.source == "runtime"
                && !is_runtime_transport_dump(&entry.text)
        });
    let runtime_entries = if has_structured_runtime_entries {
        Vec::new()
    } else {
        build_runtime_output_entries(session)
    };
    if let Some(status_entry) = build_session_status_entry(session, &runtime_entries) {
        feed.push(status_entry);
    }

    for entry in &session.conversation {
        if entry.source == "runtime" && is_runtime_transport_dump(&entry.text)
        {
            continue;
        }

        if entry.kind == "assistant_message" && entry.source == "runtime" {
            push_runtime_assistant_segments(
                &mut feed,
                entry,
                last_runtime_assistant_id.as_deref() == Some(entry.id.as_str()),
            );
            continue;
        }

        let kind = match entry.kind.as_str() {
            "user_message" => "user",
            "assistant_message" => "assistant",
            "system_message" => "system",
            "tool_message" => "tool",
            "status_message" => "status",
            _ => "status",
        };
        let tool_kind_present = entry.metadata.contains_key("toolTitle");
        let label = match entry.kind.as_str() {
            "user_message" if entry.source == "feedback" => "Feedback",
            "user_message" => "You",
            "assistant_message" => "Assistant",
            "system_message" if entry.source == "restore" => "Restored",
            "system_message" => "System",
            "tool_message" => "Tool",
            "status_message" if tool_kind_present => "Tool",
            "status_message" => "Session",
            _ => "Session",
        };
        feed.push(json!({
            "id": entry.id,
            "kind": if entry.kind == "status_message" && tool_kind_present { "tool" } else { kind },
            "label": label,
            "text": entry.text,
            "createdAt": entry.created_at,
            "attachments": entry.attachments,
            "source": entry.source,
            "streaming": entry.kind == "assistant_message"
                && entry.source == "runtime"
                && last_runtime_assistant_id.as_deref() == Some(entry.id.as_str()),
            "metadata": entry.metadata,
        }));
    }
    feed.extend(runtime_entries);

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

    let is_active_status = normalized_status == "working" || normalized_status == "running";
    let is_active_activity = normalized_activity == "active" && !is_terminal_status(&session.status);
    if !is_active_status && !is_active_activity {
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
        // Find the next valid UTF-8 char boundary to avoid panicking on multi-byte chars.
        let mut safe_start = start;
        while safe_start < session.output.len() && !session.output.is_char_boundary(safe_start) {
            safe_start += 1;
        }
        session.output.drain(..safe_start);
    }
}

pub fn is_terminal_status(status: &str) -> bool {
    use super::types::SessionStatus;
    SessionStatus::from(status).is_terminal()
}
