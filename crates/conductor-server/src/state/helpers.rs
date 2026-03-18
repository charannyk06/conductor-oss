use serde_json::{json, Value};
use std::collections::HashMap;
use std::iter::Peekable;
use std::path::Path;

use super::types::{
    SessionRecord, SessionStatus, DEFAULT_OUTPUT_LIMIT_BYTES, DEFAULT_SESSION_HISTORY_LIMIT,
};
use super::{DETACHED_PID_METADATA_KEY, RUNTIME_MODE_METADATA_KEY};

const SPAWN_REQUEST_METADATA_KEY: &str = "spawnRequest";
const RECOVERY_STATE_METADATA_KEY: &str = "recoveryState";
const RECOVERY_ACTION_METADATA_KEY: &str = "recoveryAction";
const RECOVERY_COUNT_METADATA_KEY: &str = "restartRecoveryCount";
const RECOVERED_AT_METADATA_KEY: &str = "lastRecoveredAt";
const DASHBOARD_METADATA_MAX_VALUE_BYTES: usize = 2048;
const LEGACY_DIRECT_RUNTIME_SUMMARY: &str =
    "Legacy direct terminal session is no longer supported. Archive it and start a fresh ttyd session.";
const LEGACY_TMUX_RUNTIME_SUMMARY: &str = "Archived legacy tmux session after tmux runtime removal";

fn dashboard_metadata_allowlist() -> &'static [&'static str] {
    &[
        "agent",
        "agentCwd",
        "briefPath",
        "ciStatus",
        "cost",
        "devServerLog",
        "devServerPort",
        "devServerUrl",
        "finishedAt",
        "lastStderr",
        "mergeReadiness",
        "model",
        "parentTaskId",
        "prBaseRef",
        "prDraft",
        "prHeadRef",
        "prState",
        "prTitle",
        "previewUrl",
        "queueDepth",
        "queuePosition",
        "reasoningEffort",
        "recoveryAction",
        "recoveryState",
        "reviewDecision",
        "startedAt",
        "summary",
        "taskId",
        "taskRef",
        "worktree",
    ]
}

fn trim_dashboard_metadata_value(value: &str) -> String {
    if value.len() <= DASHBOARD_METADATA_MAX_VALUE_BYTES {
        return value.to_string();
    }

    let mut end = 0usize;
    for (index, _) in value.char_indices() {
        if index > DASHBOARD_METADATA_MAX_VALUE_BYTES {
            break;
        }
        end = index;
    }
    if end == 0 {
        end = DASHBOARD_METADATA_MAX_VALUE_BYTES.min(value.len());
    }

    let mut trimmed = value[..end].to_string();
    trimmed.push_str("...");
    trimmed
}

pub(crate) fn dashboard_session_metadata(
    metadata: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut filtered = HashMap::new();
    for key in dashboard_metadata_allowlist() {
        let Some(value) = metadata.get(*key) else {
            continue;
        };
        if value.trim().is_empty() {
            continue;
        }
        filtered.insert((*key).to_string(), trim_dashboard_metadata_value(value));
    }
    filtered
}

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
        "workspacePath": session.workspace_path,
        "agent": session.agent,
        "model": session.model,
        "reasoningEffort": session.reasoning_effort,
        "pr": session.pr,
        "metadata": dashboard_session_metadata(&session.metadata),
    })
}

pub fn resolve_board_file(
    workspace_path: &Path,
    board_dir: &str,
    project_path: Option<&str>,
) -> String {
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
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| "CONDUCTOR.md".to_string())
}

pub fn trim_lines_tail(output: &str, lines: usize) -> String {
    let mut collected = output.lines().rev().take(lines).collect::<Vec<_>>();
    collected.reverse();
    collected.join("\n")
}

fn is_filtered_control(ch: char) -> bool {
    ch.is_control() && ch != '\n' && ch != '\t'
}

fn consume_csi<I>(chars: &mut Peekable<I>)
where
    I: Iterator<Item = char>,
{
    for next in chars.by_ref() {
        let code = next as u32;
        if (0x40..=0x7e).contains(&code) {
            break;
        }
    }
}

fn consume_osc<I>(chars: &mut Peekable<I>)
where
    I: Iterator<Item = char>,
{
    let mut previous_was_escape = false;
    for next in chars.by_ref() {
        if next == '\u{0007}' {
            break;
        }
        if previous_was_escape && next == '\\' {
            break;
        }
        previous_was_escape = next == '\u{001b}';
    }
}

pub(crate) fn sanitize_terminal_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\u{001b}' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    consume_csi(&mut chars);
                }
                Some(']') => {
                    chars.next();
                    consume_osc(&mut chars);
                }
                _ => {}
            },
            '\r' => {}
            other if is_filtered_control(other) => {}
            other => result.push(other),
        }
    }

    result
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

fn is_streaming_status(status: &SessionStatus) -> bool {
    matches!(status, SessionStatus::Working)
}

fn is_failed_session_status(status: &SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Errored | SessionStatus::Killed | SessionStatus::Terminated
    )
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
    let mut tail_start = current.len().saturating_sub(512);
    while tail_start < current.len() && !current.is_char_boundary(tail_start) {
        tail_start += 1;
    }
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
        Some(
            "system"
                | "assistant"
                | "user"
                | "tool_use"
                | "result"
                | "input_request"
                | "rate_limit_event"
        )
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
    for line in trimmed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if !is_runtime_transport_event_line(line) {
            return false;
        }
        saw_event = true;
    }
    saw_event
}

fn is_runtime_internal_noise_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    let mut parts = trimmed.split_whitespace();
    let Some(timestamp) = parts.next() else {
        return false;
    };
    let Some(level) = parts.next() else {
        return false;
    };
    if !looks_like_iso8601_timestamp(timestamp) {
        return false;
    }
    if !matches!(level, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR") {
        return false;
    }

    let Some(target) = parts.next() else {
        return false;
    };
    if target.ends_with(':') && target.contains("::") {
        return true;
    }

    let remainder = std::iter::once(target)
        .chain(parts)
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    remainder.contains("failed to list resources for mcp server")
        || remainder.contains("failed to list resource templates for mcp server")
        || remainder.contains("mcp error: -32601: method not found")
}

fn is_runtime_internal_noise_text(text: &str) -> bool {
    let mut saw_noise = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if !is_runtime_internal_noise_line(line) {
            return false;
        }
        saw_noise = true;
    }
    saw_noise
}

fn is_opencode_terminal_noise_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed == "Commands:"
        || trimmed.starts_with("opencode ")
        || trimmed.contains("start opencode tui")
        || trimmed.contains("manage MCP (Model Context Protocol) servers")
        || trimmed.chars().all(|ch| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '█' | '▀'
                        | '▄'
                        | '▌'
                        | '▐'
                        | '▖'
                        | '▗'
                        | '▘'
                        | '▝'
                        | '▙'
                        | '▛'
                        | '▜'
                        | '▟'
                )
        })
}

fn is_amp_terminal_noise_line(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("no api key found")
        || lower.contains("starting login flow")
        || lower.contains("ampcode.com/auth/cli-login")
        || lower.contains("paste your code here")
}

fn is_cursor_terminal_noise_line(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("press any key to sign in") || lower.contains("cursor agent")
}

fn should_filter_runtime_line(session: &SessionRecord, line: &str) -> bool {
    if is_runtime_transport_event_line(line) || is_runtime_internal_noise_line(line) {
        return true;
    }

    (session.agent.trim().eq_ignore_ascii_case("opencode") && is_opencode_terminal_noise_line(line))
        || (session.agent.trim().eq_ignore_ascii_case("amp") && is_amp_terminal_noise_line(line))
        || (session.agent.trim().eq_ignore_ascii_case("cursor-cli")
            && is_cursor_terminal_noise_line(line))
}

fn looks_like_iso8601_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && value.ends_with('Z')
}

fn build_runtime_output_entries(session: &SessionRecord) -> Vec<Value> {
    let mut entries = Vec::new();
    let mut assistant_text = String::new();
    let mut assistant_index = 0usize;
    let mut status_index = 0usize;
    let is_streaming = matches!(session.status, SessionStatus::Working);

    let flush_assistant = |streaming: bool,
                           entries: &mut Vec<Value>,
                           assistant_text: &mut String,
                           assistant_index: &mut usize| {
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

        if should_filter_runtime_line(session, line) {
            continue;
        }

        if matches!(line, "codex" | "qwen" | "gemini" | "claude") {
            continue;
        }

        if is_runtime_status_line(line) {
            flush_assistant(
                false,
                &mut entries,
                &mut assistant_text,
                &mut assistant_index,
            );
            let metadata = runtime_tool_metadata(line).unwrap_or_else(|| json!({}));
            let kind = if metadata.get("toolTitle").is_some() {
                "tool"
            } else {
                "status"
            };
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

    flush_assistant(
        is_streaming,
        &mut entries,
        &mut assistant_text,
        &mut assistant_index,
    );
    entries
}

fn push_runtime_assistant_segments(
    feed: &mut Vec<Value>,
    session: &SessionRecord,
    entry: &super::types::ConversationEntry,
    streaming: bool,
) {
    let mut assistant_text = String::new();
    let mut segment_index = 0usize;

    let flush_assistant =
        |feed: &mut Vec<Value>, assistant_text: &mut String, segment_index: &mut usize| {
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

        if should_filter_runtime_line(session, normalized) {
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

        if !assistant_text.is_empty()
            && !assistant_text.ends_with('\n')
            && !assistant_text.ends_with("\n\n")
        {
            assistant_text.push('\n');
        }
        assistant_text.push_str(normalized);
    }

    flush_assistant(feed, &mut assistant_text, &mut segment_index);
}

fn build_session_status_entry(session: &SessionRecord, runtime_entries: &[Value]) -> Option<Value> {
    if matches!(session.status, SessionStatus::Working) {
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
                .find(|entry| {
                    entry.get("kind").and_then(|value| value.as_str()) == Some("assistant")
                })
                .and_then(|entry| entry.get("text").and_then(|value| value.as_str()))
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });

    let summary = session
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !is_runtime_internal_noise_text(value))
        .filter(|value| Some(*value) != last_assistant_text);
    let summary = if matches!(
        session.status,
        SessionStatus::NeedsInput | SessionStatus::Done
    ) && summary
        .map(|value| value.contains('\n') || value.len() > 280)
        .unwrap_or(false)
    {
        None
    } else {
        summary
    };

    if session.status == SessionStatus::Done && last_assistant_text.is_some() {
        return None;
    }

    let mut parts = Vec::new();
    if let Some(summary_text) = summary {
        parts.push(summary_text.to_string());
    }
    if (session.status != SessionStatus::Done || parts.is_empty())
        && !matches!(session.status, SessionStatus::Other(ref s) if s.is_empty())
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
                    && !is_runtime_internal_noise_text(&entry.text)
            })
            .map(|entry| entry.id.clone())
    } else {
        None
    };
    let has_structured_runtime_entries = session.conversation.iter().any(|entry| {
        matches!(entry.kind.as_str(), "assistant_message" | "status_message")
            && entry.source == "runtime"
            && !is_runtime_transport_dump(&entry.text)
            && !is_runtime_internal_noise_text(&entry.text)
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
        if entry.source == "runtime"
            && (is_runtime_transport_dump(&entry.text)
                || is_runtime_internal_noise_text(&entry.text))
        {
            continue;
        }

        if entry.kind == "assistant_message" && entry.source == "runtime" {
            push_runtime_assistant_segments(
                &mut feed,
                session,
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
    finalize_tool_statuses(&mut feed, &session.status);

    if feed.len() > DEFAULT_SESSION_HISTORY_LIMIT {
        feed = feed.split_off(feed.len() - DEFAULT_SESSION_HISTORY_LIMIT);
    }

    feed
}

fn finalize_tool_statuses(feed: &mut [Value], session_status: &SessionStatus) {
    let session_is_streaming = is_streaming_status(session_status);
    let session_failed = is_failed_session_status(session_status);

    for index in 0..feed.len() {
        let resolved_status = {
            let Some(entry) = feed.get(index) else {
                continue;
            };
            if entry.get("kind").and_then(Value::as_str) != Some("tool") {
                continue;
            }
            let Some(metadata) = entry.get("metadata").and_then(Value::as_object) else {
                continue;
            };
            let Some(status) = metadata.get("toolStatus").and_then(Value::as_str) else {
                continue;
            };
            let normalized = status.trim().to_ascii_lowercase();
            if !matches!(normalized.as_str(), "running" | "working" | "pending") {
                continue;
            }

            let has_later_entry = feed
                .iter()
                .skip(index + 1)
                .any(|candidate| candidate.get("kind").and_then(Value::as_str).is_some());

            if has_later_entry {
                "success"
            } else if session_is_streaming {
                "running"
            } else if session_failed {
                "error"
            } else {
                "success"
            }
        };

        if let Some(metadata) = feed
            .get_mut(index)
            .and_then(|entry| entry.get_mut("metadata"))
            .and_then(Value::as_object_mut)
        {
            metadata.insert(
                "toolStatus".to_string(),
                Value::String(resolved_status.to_string()),
            );
        }
    }
}

pub fn normalize_loaded_session(session: &mut SessionRecord) -> bool {
    let normalized_activity = session
        .activity
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let has_spawn_request = session
        .metadata
        .get(SPAWN_REQUEST_METADATA_KEY)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let has_workspace = session
        .workspace_path
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || session
            .metadata
            .get("worktree")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    let now = chrono::Utc::now().to_rfc3339();

    if session.status == SessionStatus::Queued {
        let mut changed = false;
        if session
            .activity
            .as_deref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            session.activity = Some("idle".to_string());
            changed = true;
        }
        if session
            .summary
            .as_ref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            session.summary = Some("Queued for launch".to_string());
            session
                .metadata
                .insert("summary".to_string(), "Queued for launch".to_string());
            changed = true;
        }
        return changed;
    }

    if session.status == SessionStatus::Spawning && has_spawn_request {
        requeue_recovered_session(
            session,
            &now,
            "Recovered after backend restart and requeued for launch",
        );
        return true;
    }

    let is_active_status = matches!(session.status, SessionStatus::Working);
    let is_active_activity =
        normalized_activity == "active" && !is_terminal_status(&session.status);

    match session
        .metadata
        .get(RUNTIME_MODE_METADATA_KEY)
        .map(String::as_str)
    {
        Some("tmux") => {
            session.status = SessionStatus::Archived;
            session.activity = Some("exited".to_string());
            session.last_activity_at = now.clone();
            session.summary = Some(LEGACY_TMUX_RUNTIME_SUMMARY.to_string());
            session.metadata.insert(
                "summary".to_string(),
                LEGACY_TMUX_RUNTIME_SUMMARY.to_string(),
            );
            session
                .metadata
                .insert("archivedAt".to_string(), now.clone());
            session.pid = None;
            return true;
        }
        Some("direct") => {
            // Direct runtime is legacy — archive immediately.
            session.status = SessionStatus::Archived;
            session.activity = Some("exited".to_string());
            session.last_activity_at = now.clone();
            session.summary = Some(LEGACY_DIRECT_RUNTIME_SUMMARY.to_string());
            session.metadata.insert(
                "summary".to_string(),
                LEGACY_DIRECT_RUNTIME_SUMMARY.to_string(),
            );
            session
                .metadata
                .insert("archivedAt".to_string(), now.clone());
            session.pid = None;
            return true;
        }
        // Non-ttyd active sessions cannot be recovered — archive them so they
        // don't clutter the dashboard after a restart/reinstall.
        None | Some("") if is_active_status || is_active_activity => {
            session.status = SessionStatus::Archived;
            session.activity = Some("exited".to_string());
            session.last_activity_at = now.clone();
            session.summary =
                Some("Session archived after backend restart (pre-ttyd runtime)".to_string());
            session.metadata.insert(
                "summary".to_string(),
                "Session archived after backend restart (pre-ttyd runtime)".to_string(),
            );
            session
                .metadata
                .insert("archivedAt".to_string(), now.clone());
            session.pid = None;
            return true;
        }
        _ => {}
    }

    if is_active_status && has_spawn_request && !has_workspace && session.pid.unwrap_or(0) == 0 {
        requeue_recovered_session(
            session,
            &now,
            "Recovered after backend restart and requeued before launch completed",
        );
        return true;
    }

    if !is_active_status && !is_active_activity {
        return false;
    }

    session.status = SessionStatus::Stuck;
    session.activity = Some("blocked".to_string());
    session.last_activity_at = now.clone();
    record_restart_recovery(session, &now);

    if let Some(pid) = session
        .pid
        .filter(|pid| *pid > 0)
        .filter(|pid| super::workspace::is_process_alive(*pid))
    {
        session
            .metadata
            .insert(DETACHED_PID_METADATA_KEY.to_string(), pid.to_string());
        session.metadata.insert(
            RECOVERY_STATE_METADATA_KEY.to_string(),
            "detached_runtime".to_string(),
        );
        session.metadata.insert(
            RECOVERY_ACTION_METADATA_KEY.to_string(),
            "kill_or_archive_before_resume".to_string(),
        );
        session.summary =
            Some("Backend restarted while the agent may still be running. Kill or archive before resuming.".to_string());
    } else {
        session.pid = None;
        session.metadata.remove(DETACHED_PID_METADATA_KEY);
        session.metadata.insert(
            RECOVERY_STATE_METADATA_KEY.to_string(),
            "resume_required".to_string(),
        );
        session.metadata.insert(
            RECOVERY_ACTION_METADATA_KEY.to_string(),
            "resume".to_string(),
        );
        session.summary =
            Some("Backend restarted. Send a message to resume in the same workspace.".to_string());
    }
    session.metadata.insert(
        "summary".to_string(),
        session.summary.clone().unwrap_or_default(),
    );
    true
}

fn requeue_recovered_session(session: &mut SessionRecord, recovered_at: &str, summary: &str) {
    session.status = SessionStatus::Queued;
    session.activity = Some("idle".to_string());
    session.pid = None;
    session.last_activity_at = recovered_at.to_string();
    session.summary = Some(summary.to_string());
    session.metadata.insert(
        RECOVERY_STATE_METADATA_KEY.to_string(),
        "requeued_after_restart".to_string(),
    );
    session.metadata.insert(
        RECOVERY_ACTION_METADATA_KEY.to_string(),
        "wait_for_launch".to_string(),
    );
    session
        .metadata
        .insert("summary".to_string(), summary.to_string());
    session.metadata.remove(DETACHED_PID_METADATA_KEY);
    record_restart_recovery(session, recovered_at);
}

fn record_restart_recovery(session: &mut SessionRecord, recovered_at: &str) {
    let count = session
        .metadata
        .get(RECOVERY_COUNT_METADATA_KEY)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
        + 1;
    session
        .metadata
        .insert(RECOVERY_COUNT_METADATA_KEY.to_string(), count.to_string());
    session.metadata.insert(
        RECOVERED_AT_METADATA_KEY.to_string(),
        recovered_at.to_string(),
    );
}

pub fn append_output(session: &mut SessionRecord, line: &str) {
    let sanitized = sanitize_terminal_text(line);
    let normalized = sanitized.trim_end();
    if normalized.trim().is_empty() {
        return;
    }
    if !session.output.is_empty() {
        session.output.push('\n');
    }
    session.output.push_str(normalized);
    if session.output.len() > DEFAULT_OUTPUT_LIMIT_BYTES {
        let start = session
            .output
            .len()
            .saturating_sub(DEFAULT_OUTPUT_LIMIT_BYTES);
        // Find the next valid UTF-8 char boundary to avoid panicking on multi-byte chars.
        let mut safe_start = start;
        while safe_start < session.output.len() && !session.output.is_char_boundary(safe_start) {
            safe_start += 1;
        }
        session.output.drain(..safe_start);
    }
}

pub fn is_terminal_status(status: &SessionStatus) -> bool {
    status.is_terminal()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ConversationEntry;
    use chrono::Utc;
    use std::collections::HashMap;

    #[test]
    fn sanitize_terminal_text_strips_ansi_and_control_sequences() {
        let input = "\u{001b}[90m{\"type\":\"assistant\"}\u{001b}[0m\u{0008}";
        assert_eq!(sanitize_terminal_text(input), "{\"type\":\"assistant\"}");
    }

    #[test]
    fn finalize_tool_statuses_marks_completed_tool_calls_success() {
        let mut feed = vec![
            json!({
                "kind": "tool",
                "metadata": { "toolStatus": "running" }
            }),
            json!({
                "kind": "assistant",
                "metadata": {}
            }),
        ];

        finalize_tool_statuses(&mut feed, &SessionStatus::Done);

        assert_eq!(
            feed[0]
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("toolStatus"))
                .and_then(Value::as_str),
            Some("success")
        );
    }

    #[test]
    fn finalize_tool_statuses_marks_last_tool_error_for_failed_sessions() {
        let mut feed = vec![json!({
            "kind": "tool",
            "metadata": { "toolStatus": "running" }
        })];

        finalize_tool_statuses(&mut feed, &SessionStatus::Errored);

        assert_eq!(
            feed[0]
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("toolStatus"))
                .and_then(Value::as_str),
            Some("error")
        );
    }

    #[test]
    fn finalize_tool_statuses_keeps_last_tool_running_for_active_sessions() {
        let mut feed = vec![json!({
            "kind": "tool",
            "metadata": { "toolStatus": "running" }
        })];

        finalize_tool_statuses(&mut feed, &SessionStatus::Working);

        assert_eq!(
            feed[0]
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| metadata.get("toolStatus"))
                .and_then(Value::as_str),
            Some("running")
        );
    }

    #[test]
    fn build_normalized_chat_feed_drops_runtime_internal_log_noise() {
        let mut session = SessionRecord::new(
            "session-logs".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        session.conversation.push(ConversationEntry {
            id: "runtime-log".to_string(),
            kind: "assistant_message".to_string(),
            text: "2026-03-09T01:31:02.130169Z WARN codex_core::mcp_connection_manager: Failed to list resources for MCP server 'filesystem': resources/list failed: Mcp error: -32601: Method not found".to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: "runtime".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });
        session.conversation.push(ConversationEntry {
            id: "runtime-assistant".to_string(),
            kind: "assistant_message".to_string(),
            text: "I'm switching to shell inspection now.".to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: "runtime".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });

        let feed = build_normalized_chat_feed(&session);
        let texts = feed
            .iter()
            .filter_map(|entry| entry.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(texts
            .iter()
            .any(|text| text.contains("shell inspection now")));
        assert!(texts
            .iter()
            .all(|text| !text.contains("codex_core::mcp_connection_manager")));
    }

    #[test]
    fn build_normalized_chat_feed_drops_sqlx_runtime_log_noise() {
        let mut session = SessionRecord::new(
            "session-sqlx-logs".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        session.conversation.push(ConversationEntry {
            id: "runtime-log".to_string(),
            kind: "assistant_message".to_string(),
            text: "2026-03-09T01:40:13.738303Z WARN sqlx::query: slow statement: execution time exceeded alert threshold summary=\"INSERT INTO threads ( ...\"".to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: "runtime".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });
        session.conversation.push(ConversationEntry {
            id: "runtime-assistant".to_string(),
            kind: "assistant_message".to_string(),
            text: "I have the project layout and I'm reading the main components now.".to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: "runtime".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });

        let feed = build_normalized_chat_feed(&session);
        let texts = feed
            .iter()
            .filter_map(|entry| entry.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(texts.iter().any(|text| text.contains("project layout")));
        assert!(texts.iter().all(|text| !text.contains("sqlx::query")));
    }

    #[test]
    fn build_normalized_chat_feed_drops_opencode_help_dump_noise() {
        let mut session = SessionRecord::new(
            "session-opencode-help".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
            "opencode".to_string(),
            None,
            None,
            "Review repo".to_string(),
            None,
        );
        session.status = SessionStatus::Working;
        session.conversation.push(ConversationEntry {
            id: "runtime-help".to_string(),
            kind: "assistant_message".to_string(),
            text: "Commands:\nopencode completion          generate shell completion script\nopencode mcp                 manage MCP (Model Context Protocol) servers".to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: "runtime".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });
        session.conversation.push(ConversationEntry {
            id: "runtime-assistant".to_string(),
            kind: "assistant_message".to_string(),
            text: "I’m reviewing the repository layout now.".to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: "runtime".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });

        let feed = build_normalized_chat_feed(&session);
        let texts = feed
            .iter()
            .filter_map(|entry| entry.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(texts
            .iter()
            .any(|text| text.contains("reviewing the repository layout")));
        assert!(texts
            .iter()
            .all(|text| !text.contains("generate shell completion script")));
        assert!(texts
            .iter()
            .all(|text| !text.contains("manage MCP (Model Context Protocol) servers")));
    }

    #[test]
    fn normalize_loaded_session_requeues_recoverable_spawning_sessions() {
        let mut session = SessionRecord::new(
            "session-1".to_string(),
            "demo".to_string(),
            None,
            None,
            None,
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            None,
        );
        session.status = SessionStatus::Spawning;
        session.activity = Some("active".to_string());
        session.metadata.insert(
            SPAWN_REQUEST_METADATA_KEY.to_string(),
            "{\"projectId\":\"demo\"}".to_string(),
        );

        let changed = normalize_loaded_session(&mut session);

        assert!(changed);
        assert_eq!(session.status, SessionStatus::Queued);
        assert_eq!(session.activity.as_deref(), Some("idle"));
        assert_eq!(
            session
                .metadata
                .get(RECOVERY_STATE_METADATA_KEY)
                .map(String::as_str),
            Some("requeued_after_restart")
        );
    }

    #[test]
    fn dashboard_session_metadata_filters_internal_keys_and_caps_large_values() {
        let oversized = "x".repeat(DASHBOARD_METADATA_MAX_VALUE_BYTES + 128);
        let mut metadata = HashMap::from([
            ("agent".to_string(), "codex".to_string()),
            ("summary".to_string(), oversized),
            (
                "spawnRequest".to_string(),
                "{\"prompt\":\"very large\"}".to_string(),
            ),
        ]);
        metadata.insert("taskId".to_string(), "task-123".to_string());

        let filtered = dashboard_session_metadata(&metadata);

        assert_eq!(filtered.get("agent").map(String::as_str), Some("codex"));
        assert_eq!(filtered.get("taskId").map(String::as_str), Some("task-123"));
        assert!(!filtered.contains_key("spawnRequest"));
        let summary = filtered
            .get("summary")
            .expect("summary should be preserved");
        assert!(summary.len() <= DASHBOARD_METADATA_MAX_VALUE_BYTES + 3);
        assert!(summary.ends_with("..."));
    }

    #[test]
    fn normalize_loaded_session_archives_active_sessions_without_ttyd_runtime() {
        // Sessions without runtimeMode="ttyd" that were active are now archived
        // at restart so they don't pollute the dashboard as stale Stuck entries.
        let mut session = SessionRecord::new(
            "session-2".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            Some(u32::MAX),
        );
        session.status = SessionStatus::Working;
        session.activity = Some("active".to_string());

        let changed = normalize_loaded_session(&mut session);

        assert!(changed);
        assert_eq!(session.status, SessionStatus::Archived);
        assert_eq!(session.activity.as_deref(), Some("exited"));
        assert_eq!(session.pid, None);
        assert!(session.metadata.contains_key("archivedAt"));
    }

    #[test]
    fn normalize_loaded_session_archives_legacy_tmux_runtime_sessions() {
        let mut session = SessionRecord::new(
            "legacy-session".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
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
            .insert(RUNTIME_MODE_METADATA_KEY.to_string(), "tmux".to_string());

        let changed = normalize_loaded_session(&mut session);

        assert!(changed);
        assert_eq!(session.status, SessionStatus::Archived);
        assert_eq!(session.activity.as_deref(), Some("exited"));
        assert_eq!(
            session.summary.as_deref(),
            Some("Archived legacy tmux session after tmux runtime removal")
        );
        assert!(session.metadata.contains_key("archivedAt"));
        assert_eq!(session.pid, None);
    }

    #[test]
    fn normalize_loaded_session_flags_legacy_direct_runtime_sessions() {
        let mut session = SessionRecord::new(
            "legacy-direct-session".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
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
            .insert(RUNTIME_MODE_METADATA_KEY.to_string(), "direct".to_string());

        let changed = normalize_loaded_session(&mut session);

        assert!(changed);
        // Direct runtime sessions are now archived immediately (not left as Stuck)
        assert_eq!(session.status, SessionStatus::Archived);
        assert_eq!(session.activity.as_deref(), Some("exited"));
        assert_eq!(
            session.summary.as_deref(),
            Some(LEGACY_DIRECT_RUNTIME_SUMMARY)
        );
        assert!(session.metadata.contains_key("archivedAt"));
        assert_eq!(session.pid, None);
    }

    #[test]
    fn normalize_loaded_session_archives_non_ttyd_active_session_even_with_live_pid() {
        // Non-ttyd sessions without runtimeMode are archived regardless of PID
        // because the old runtime cannot be resumed.
        let mut session = SessionRecord::new(
            "session-3".to_string(),
            "demo".to_string(),
            None,
            None,
            Some("/tmp/demo".to_string()),
            "codex".to_string(),
            None,
            None,
            "Investigate".to_string(),
            Some(std::process::id()),
        );
        session.status = SessionStatus::Working;
        session.activity = Some("active".to_string());

        let changed = normalize_loaded_session(&mut session);

        assert!(changed);
        assert_eq!(session.status, SessionStatus::Archived);
        assert_eq!(session.activity.as_deref(), Some("exited"));
        assert!(session.metadata.contains_key("archivedAt"));
    }
}
