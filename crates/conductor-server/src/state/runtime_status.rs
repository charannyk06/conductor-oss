use chrono::{DateTime, Utc};
use conductor_core::types::AgentKind;
use glob::glob;
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tokio::task;

use super::types::SessionRecord;

const CODEX_TAIL_PATTERN: &str = ".codex/sessions/**/*.jsonl";
const CODEX_TAIL_BYTES: u64 = 262_144;
const CLAUDE_TAIL_BYTES: u64 = 262_144;
const GEMINI_SESSION_PREFIX: &str = "session-";
const QWEN_TAIL_PATTERN: &str = ".qwen/projects/**/chats/*.jsonl";
const QWEN_TAIL_BYTES: u64 = 262_144;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeStatus {
    pub agent: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: Option<String>,
    pub source: RuntimeStatusSource,
    pub context_window: RuntimeStatusContextWindow,
    pub usage: RuntimeStatusUsage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusSource {
    pub kind: String,
    pub label: String,
    pub path: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusContextWindow {
    pub max_tokens: Option<u64>,
    pub source: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub tool_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub tokens_left: Option<u64>,
    pub percent_used: Option<f64>,
    pub percent_left: Option<f64>,
}

impl SessionRuntimeStatus {
    fn fallback(session: &SessionRecord) -> Option<Self> {
        let cwd = session_cwd(session);
        let model = session
            .model
            .clone()
            .or_else(|| session.metadata.get("model").cloned())
            .and_then(trimmed_or_none);
        let reasoning_effort = session
            .reasoning_effort
            .clone()
            .or_else(|| session.metadata.get("reasoningEffort").cloned())
            .and_then(trimmed_or_none);

        if session.agent.trim().is_empty()
            && model.is_none()
            && reasoning_effort.is_none()
            && cwd.is_none()
        {
            return None;
        }

        Some(Self {
            agent: session.agent.trim().to_string(),
            model,
            reasoning_effort,
            cwd,
            updated_at: None,
            source: RuntimeStatusSource {
                kind: "session_metadata".to_string(),
                label: "Session metadata".to_string(),
                path: None,
                note: Some("Live CLI telemetry is not available for this session yet.".to_string()),
            },
            context_window: RuntimeStatusContextWindow {
                max_tokens: None,
                source: "unavailable".to_string(),
                note: Some(
                    "This CLI did not expose a context window for the active session.".to_string(),
                ),
            },
            usage: RuntimeStatusUsage::default(),
        })
    }

    fn apply_usage(&mut self) {
        let Some(total_tokens) = self.usage.total_tokens else {
            return;
        };
        let Some(max_tokens) = self.context_window.max_tokens else {
            return;
        };
        if max_tokens == 0 {
            return;
        }

        let bounded_total = total_tokens.min(max_tokens);
        let tokens_left = max_tokens.saturating_sub(bounded_total);
        let percent_used = ((bounded_total as f64 / max_tokens as f64) * 100.0).clamp(0.0, 100.0);
        self.usage.tokens_left = Some(tokens_left);
        self.usage.percent_used = Some(percent_used);
        self.usage.percent_left = Some((100.0 - percent_used).clamp(0.0, 100.0));
    }
}

pub async fn build_session_runtime_status(session: &SessionRecord) -> Option<SessionRuntimeStatus> {
    let session = session.clone();
    task::spawn_blocking(move || build_session_runtime_status_sync(&session))
        .await
        .ok()
        .flatten()
}

pub async fn resolve_native_resume_target(agent_kind: AgentKind, cwd: String) -> Option<String> {
    task::spawn_blocking(move || resolve_native_resume_target_sync(agent_kind, &cwd))
        .await
        .ok()
        .flatten()
}

fn build_session_runtime_status_sync(session: &SessionRecord) -> Option<SessionRuntimeStatus> {
    let mut status = SessionRuntimeStatus::fallback(session)?;
    let cwd = status.cwd.clone();
    let agent_kind = AgentKind::parse(&session.agent);

    let runtime_status = match agent_kind {
        AgentKind::Codex => cwd.as_deref().and_then(read_codex_runtime_status),
        AgentKind::ClaudeCode => cwd.as_deref().and_then(read_claude_runtime_status),
        AgentKind::Gemini => cwd.as_deref().and_then(read_gemini_runtime_status),
        AgentKind::QwenCode => cwd.as_deref().and_then(read_qwen_runtime_status),
        _ => None,
    };

    if let Some(mut runtime_status) = runtime_status {
        if runtime_status.model.is_none() {
            runtime_status.model = status.model.clone();
        }
        if runtime_status.reasoning_effort.is_none() {
            runtime_status.reasoning_effort = status.reasoning_effort.clone();
        }
        runtime_status.apply_usage();
        return Some(runtime_status);
    }

    status.apply_usage();
    Some(status)
}

fn resolve_native_resume_target_sync(agent_kind: AgentKind, cwd: &str) -> Option<String> {
    match agent_kind {
        AgentKind::Codex => read_codex_resume_target(cwd),
        AgentKind::ClaudeCode => read_claude_resume_target(cwd),
        AgentKind::Gemini => read_gemini_resume_target(cwd),
        _ => None,
    }
}

fn read_codex_runtime_status(cwd: &str) -> Option<SessionRuntimeStatus> {
    read_codex_runtime_status_from_home(&home_dir()?, cwd)
}

fn read_codex_resume_target(cwd: &str) -> Option<String> {
    read_codex_resume_target_from_home(&home_dir()?, cwd)
}

fn read_codex_runtime_status_from_home(home: &Path, cwd: &str) -> Option<SessionRuntimeStatus> {
    let file_path = find_latest_matching_jsonl_in(home, CODEX_TAIL_PATTERN, |path| {
        codex_file_matches_cwd(path, cwd)
    })?;
    let modified_at = file_mtime_rfc3339(&file_path);

    let mut model = None;
    let mut usage = RuntimeStatusUsage::default();
    let mut context_window = RuntimeStatusContextWindow {
        max_tokens: None,
        source: "unavailable".to_string(),
        note: Some("Codex has not reported a context window yet.".to_string()),
    };

    let lines = parse_json_lines_from_tail(&file_path, CODEX_TAIL_BYTES);

    for value in lines.iter().rev() {
        match value.get("type").and_then(Value::as_str) {
            Some("turn_context") => {
                if model.is_none() {
                    model = value
                        .pointer("/payload/model")
                        .and_then(Value::as_str)
                        .and_then(trimmed_or_none);
                }
            }
            Some("event_msg")
                if value.pointer("/payload/type").and_then(Value::as_str)
                    == Some("token_count") =>
            {
                if usage.total_tokens.is_none() {
                    if let Some(info) = value.pointer("/payload/info") {
                        if let Some(total_usage) = info.get("total_token_usage") {
                            usage.input_tokens = json_u64(total_usage.get("input_tokens"));
                            usage.output_tokens = json_u64(total_usage.get("output_tokens"));
                            usage.cached_input_tokens =
                                json_u64(total_usage.get("cached_input_tokens"));
                            usage.reasoning_tokens =
                                json_u64(total_usage.get("reasoning_output_tokens"));
                            usage.total_tokens = json_u64(total_usage.get("total_tokens"));
                        }
                        if let Some(max_tokens) = json_u64(info.get("model_context_window")) {
                            context_window.max_tokens = Some(max_tokens);
                            context_window.source = "cli".to_string();
                            context_window.note =
                                Some("Reported directly by the active Codex session.".to_string());
                        }
                    }
                }
            }
            _ => {}
        }

        if model.is_some() && usage.total_tokens.is_some() {
            break;
        }
    }

    Some(SessionRuntimeStatus {
        agent: AgentKind::Codex.to_string(),
        model,
        reasoning_effort: None,
        cwd: Some(cwd.to_string()),
        updated_at: modified_at,
        source: RuntimeStatusSource {
            kind: "codex_session_file".to_string(),
            label: "Codex session log".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            note: None,
        },
        context_window,
        usage,
    })
}

fn read_codex_resume_target_from_home(home: &Path, cwd: &str) -> Option<String> {
    let file_path = find_latest_matching_jsonl_in(home, CODEX_TAIL_PATTERN, |path| {
        codex_file_matches_cwd(path, cwd)
    })?;
    extract_codex_resume_target(&file_path)
}

fn read_claude_runtime_status(cwd: &str) -> Option<SessionRuntimeStatus> {
    let home = home_dir()?;
    let project_dir = home
        .join(".claude")
        .join("projects")
        .join(claude_project_path(cwd));
    let file_path = find_latest_session_file(&project_dir)?;
    let modified_at = file_mtime_rfc3339(&file_path);
    let lines = parse_json_lines_from_tail(&file_path, CLAUDE_TAIL_BYTES);

    let mut model = None;
    let mut usage = RuntimeStatusUsage::default();

    for line in lines.iter().rev() {
        if line.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }

        if model.is_none() {
            model = line
                .pointer("/message/model")
                .and_then(Value::as_str)
                .and_then(trimmed_or_none);
        }

        if let Some(usage_value) = line.pointer("/message/usage") {
            let input_tokens = json_u64(usage_value.get("input_tokens"));
            let output_tokens = json_u64(usage_value.get("output_tokens"));
            let cache_read = json_u64(usage_value.get("cache_read_input_tokens"));
            let cache_creation = json_u64(usage_value.get("cache_creation_input_tokens"));
            usage.input_tokens = input_tokens;
            usage.output_tokens = output_tokens;
            usage.cached_input_tokens = Some(cache_read.unwrap_or(0) + cache_creation.unwrap_or(0));
            usage.total_tokens = Some(input_tokens.unwrap_or(0) + output_tokens.unwrap_or(0));
            break;
        }
    }

    let context_window = match model
        .as_deref()
        .and_then(|value| read_claude_context_window(&home, value))
    {
        Some(max_tokens) => RuntimeStatusContextWindow {
            max_tokens: Some(max_tokens),
            source: "cli_cache".to_string(),
            note: Some("Read from Claude Code's local stats cache.".to_string()),
        },
        None => RuntimeStatusContextWindow {
            max_tokens: None,
            source: "unavailable".to_string(),
            note: Some(
                "Claude Code's local session data exposed token usage, but not a context window."
                    .to_string(),
            ),
        },
    };

    Some(SessionRuntimeStatus {
        agent: AgentKind::ClaudeCode.to_string(),
        model,
        reasoning_effort: None,
        cwd: Some(cwd.to_string()),
        updated_at: modified_at,
        source: RuntimeStatusSource {
            kind: "claude_project_log".to_string(),
            label: "Claude project log".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            note: None,
        },
        context_window,
        usage,
    })
}

fn read_claude_resume_target(cwd: &str) -> Option<String> {
    let home = home_dir()?;
    let project_dir = home
        .join(".claude")
        .join("projects")
        .join(claude_project_path(cwd));
    let file_path = find_latest_session_file(&project_dir)?;
    file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .and_then(trimmed_or_none)
}

fn read_gemini_runtime_status(cwd: &str) -> Option<SessionRuntimeStatus> {
    read_gemini_runtime_status_from_base(&home_dir()?.join(".gemini"), cwd)
}

fn read_gemini_resume_target(cwd: &str) -> Option<String> {
    read_gemini_resume_target_from_base(&home_dir()?.join(".gemini"), cwd)
}

fn read_gemini_runtime_status_from_base(
    base_dir: &Path,
    cwd: &str,
) -> Option<SessionRuntimeStatus> {
    let alias = resolve_gemini_project_alias(base_dir, cwd)?;
    let chats_dir = base_dir.join("tmp").join(alias).join("chats");
    let file_path = find_latest_named_file(&chats_dir, GEMINI_SESSION_PREFIX, ".json")?;
    let modified_at = file_mtime_rfc3339(&file_path);
    let contents = fs::read_to_string(&file_path).ok()?;
    let value = serde_json::from_str::<Value>(&contents).ok()?;
    let messages = value.get("messages").and_then(Value::as_array)?;

    let mut model = None;
    let mut usage = RuntimeStatusUsage::default();

    for message in messages.iter().rev() {
        if message.get("type").and_then(Value::as_str) != Some("gemini") {
            continue;
        }

        if model.is_none() {
            model = message
                .get("model")
                .and_then(Value::as_str)
                .and_then(trimmed_or_none);
        }

        if let Some(tokens) = message.get("tokens") {
            let input_tokens = json_u64(tokens.get("input"));
            let output_tokens = json_u64(tokens.get("output"));
            let cached_tokens = json_u64(tokens.get("cached"));
            let reasoning_tokens = json_u64(tokens.get("thoughts"));
            let tool_tokens = json_u64(tokens.get("tool"));
            usage.input_tokens = input_tokens;
            usage.output_tokens = output_tokens;
            usage.cached_input_tokens = cached_tokens;
            usage.reasoning_tokens = reasoning_tokens;
            usage.tool_tokens = tool_tokens;
            usage.total_tokens = json_u64(tokens.get("total")).or_else(|| {
                Some(
                    input_tokens.unwrap_or(0)
                        + output_tokens.unwrap_or(0)
                        + cached_tokens.unwrap_or(0)
                        + reasoning_tokens.unwrap_or(0)
                        + tool_tokens.unwrap_or(0),
                )
            });
            break;
        }
    }

    Some(SessionRuntimeStatus {
        agent: AgentKind::Gemini.to_string(),
        model,
        reasoning_effort: None,
        cwd: Some(cwd.to_string()),
        updated_at: modified_at,
        source: RuntimeStatusSource {
            kind: "gemini_chat_file".to_string(),
            label: "Gemini chat file".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            note: None,
        },
        context_window: RuntimeStatusContextWindow {
            max_tokens: None,
            source: "unavailable".to_string(),
            note: Some(
                "Gemini's local chat file exposed token totals, but not a context window."
                    .to_string(),
            ),
        },
        usage,
    })
}

fn read_gemini_resume_target_from_base(base_dir: &Path, cwd: &str) -> Option<String> {
    let alias = resolve_gemini_project_alias(base_dir, cwd)?;
    let chats_dir = base_dir.join("tmp").join(alias).join("chats");
    find_latest_named_file(&chats_dir, GEMINI_SESSION_PREFIX, ".json").map(|_| "latest".to_string())
}

fn read_qwen_runtime_status(cwd: &str) -> Option<SessionRuntimeStatus> {
    read_qwen_runtime_status_from_home(&home_dir()?, cwd)
}

fn read_qwen_runtime_status_from_home(home: &Path, cwd: &str) -> Option<SessionRuntimeStatus> {
    let file_path = find_latest_matching_jsonl_in(home, QWEN_TAIL_PATTERN, |path| {
        jsonl_file_matches_cwd(path, cwd)
    })?;
    let modified_at = file_mtime_rfc3339(&file_path);
    let lines = parse_json_lines_from_tail(&file_path, QWEN_TAIL_BYTES);

    let mut model = None;
    let mut usage = RuntimeStatusUsage::default();

    for line in lines.iter().rev() {
        if line.get("type").and_then(Value::as_str) == Some("system")
            && line.get("subtype").and_then(Value::as_str) == Some("ui_telemetry")
        {
            let ui_event = line.pointer("/systemPayload/uiEvent");
            if ui_event
                .and_then(|value| value.get("event.name"))
                .and_then(Value::as_str)
                == Some("qwen-code.api_response")
            {
                model = ui_event
                    .and_then(|value| value.get("model"))
                    .and_then(Value::as_str)
                    .and_then(trimmed_or_none)
                    .or(model);

                let input_tokens =
                    ui_event.and_then(|value| json_u64(value.get("input_token_count")));
                let output_tokens =
                    ui_event.and_then(|value| json_u64(value.get("output_token_count")));
                let cached_tokens =
                    ui_event.and_then(|value| json_u64(value.get("cached_content_token_count")));
                let reasoning_tokens =
                    ui_event.and_then(|value| json_u64(value.get("thoughts_token_count")));
                let tool_tokens =
                    ui_event.and_then(|value| json_u64(value.get("tool_token_count")));
                usage.input_tokens = input_tokens;
                usage.output_tokens = output_tokens;
                usage.cached_input_tokens = cached_tokens;
                usage.reasoning_tokens = reasoning_tokens;
                usage.tool_tokens = tool_tokens;
                usage.total_tokens = ui_event
                    .and_then(|value| json_u64(value.get("total_token_count")))
                    .or_else(|| {
                        Some(
                            input_tokens.unwrap_or(0)
                                + output_tokens.unwrap_or(0)
                                + cached_tokens.unwrap_or(0)
                                + reasoning_tokens.unwrap_or(0)
                                + tool_tokens.unwrap_or(0),
                        )
                    });
                break;
            }
        }

        if model.is_none() {
            model = line
                .get("model")
                .and_then(Value::as_str)
                .and_then(trimmed_or_none);
        }
    }

    Some(SessionRuntimeStatus {
        agent: AgentKind::QwenCode.to_string(),
        model,
        reasoning_effort: None,
        cwd: Some(cwd.to_string()),
        updated_at: modified_at,
        source: RuntimeStatusSource {
            kind: "qwen_ui_telemetry".to_string(),
            label: "Qwen UI telemetry".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            note: None,
        },
        context_window: RuntimeStatusContextWindow {
            max_tokens: None,
            source: "unavailable".to_string(),
            note: Some(
                "Qwen's local UI telemetry exposed token totals, but not a context window."
                    .to_string(),
            ),
        },
        usage,
    })
}

fn session_cwd(session: &SessionRecord) -> Option<String> {
    session
        .metadata
        .get("agentCwd")
        .cloned()
        .or_else(|| session.workspace_path.clone())
        .and_then(trimmed_or_none)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn trimmed_or_none(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn file_mtime_rfc3339(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified).to_rfc3339())
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|candidate| {
        candidate.as_u64().or_else(|| {
            candidate
                .as_i64()
                .and_then(|number| u64::try_from(number).ok())
        })
    })
}

fn read_file_prefix(path: &Path, max_bytes: usize) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buffer = vec![0_u8; max_bytes];
    let bytes_read = file.read(&mut buffer).ok()?;
    buffer.truncate(bytes_read);
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

fn read_file_tail(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let offset = size.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return None;
    }

    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return None;
    }
    let mut content = String::from_utf8_lossy(&buffer).into_owned();
    if offset > 0 {
        if let Some(newline_index) = content.find('\n') {
            content = content[(newline_index + 1)..].to_string();
        }
    }
    Some(content)
}

fn parse_json_lines_from_tail(path: &Path, max_bytes: u64) -> Vec<Value> {
    read_file_tail(path, max_bytes)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect()
}

fn find_latest_matching_jsonl_in<F>(root: &Path, glob_pattern: &str, matcher: F) -> Option<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    let pattern = root.join(glob_pattern).to_string_lossy().to_string();
    let mut best_match: Option<(PathBuf, std::time::SystemTime)> = None;

    for entry in glob(&pattern).ok()?.flatten() {
        if !matcher(&entry) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&entry) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };

        if best_match
            .as_ref()
            .map(|(_, best_time)| modified > *best_time)
            .unwrap_or(true)
        {
            best_match = Some((entry, modified));
        }
    }

    best_match.map(|(path, _)| path)
}

fn codex_file_matches_cwd(path: &Path, cwd: &str) -> bool {
    let Some(prefix) = read_file_prefix(path, 4096) else {
        return false;
    };
    if !prefix.contains("\"session_meta\"") {
        return false;
    }

    prefix.contains(&format!("\"cwd\":\"{cwd}\""))
        || prefix.contains(&format!("\"cwd\": \"{cwd}\""))
}

fn extract_codex_resume_target(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut target = None;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let next_target = value
            .get("threadId")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/payload/id").and_then(Value::as_str))
            .and_then(trimmed_or_none);

        if next_target.is_some() {
            target = next_target;
        }
    }

    target
}

fn jsonl_file_matches_cwd(path: &Path, cwd: &str) -> bool {
    read_file_prefix(path, 4096)
        .map(|prefix| {
            prefix.contains(&format!("\"cwd\":\"{cwd}\""))
                || prefix.contains(&format!("\"cwd\": \"{cwd}\""))
        })
        .unwrap_or(false)
}

fn claude_project_path(cwd: &str) -> String {
    cwd.replace('\\', "/")
        .trim_start_matches('/')
        .chars()
        .filter_map(|ch| match ch {
            ':' => None,
            '/' | '.' => Some('-'),
            other => Some(other),
        })
        .collect()
}

fn find_latest_session_file(project_dir: &Path) -> Option<PathBuf> {
    let mut best_match: Option<(PathBuf, std::time::SystemTime)> = None;

    for entry in fs::read_dir(project_dir).ok()?.flatten() {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !file_name.ends_with(".jsonl") || file_name.starts_with("agent-") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if best_match
            .as_ref()
            .map(|(_, best_time)| modified > *best_time)
            .unwrap_or(true)
        {
            best_match = Some((path, modified));
        }
    }

    best_match.map(|(path, _)| path)
}

fn read_claude_context_window(home: &Path, model: &str) -> Option<u64> {
    let stats_path = home.join(".claude").join("stats-cache.json");
    let contents = fs::read_to_string(stats_path).ok()?;
    let value = serde_json::from_str::<Value>(&contents).ok()?;
    let max_tokens = value
        .pointer(&format!("/modelUsage/{model}/contextWindow"))
        .and_then(Value::as_u64)?;
    if max_tokens == 0 {
        None
    } else {
        Some(max_tokens)
    }
}

fn resolve_gemini_project_alias(base_dir: &Path, cwd: &str) -> Option<String> {
    let contents = fs::read_to_string(base_dir.join("projects.json")).ok()?;
    let value = serde_json::from_str::<Value>(&contents).ok()?;
    value
        .get("projects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(cwd))
        .and_then(Value::as_str)
        .and_then(trimmed_or_none)
}

fn find_latest_named_file(dir: &Path, prefix: &str, suffix: &str) -> Option<PathBuf> {
    let mut best_match: Option<(PathBuf, std::time::SystemTime)> = None;

    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !file_name.starts_with(prefix) || !file_name.ends_with(suffix) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if best_match
            .as_ref()
            .map(|(_, best_time)| modified > *best_time)
            .unwrap_or(true)
        {
            best_match = Some((path, modified));
        }
    }

    best_match.map(|(path, _)| path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_runtime_status_reads_latest_token_count() {
        let temp_dir = temp_test_dir("codex-runtime-status");
        let sessions_dir = temp_dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("03")
            .join("08");
        fs::create_dir_all(&sessions_dir).unwrap();
        let file_path = sessions_dir.join("session.jsonl");
        fs::write(
            &file_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/tmp/demo\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.4\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000,\"cached_input_tokens\":250,\"output_tokens\":200,\"reasoning_output_tokens\":10,\"total_tokens\":1460},\"model_context_window\":272000}}}\n"
            ),
        )
        .unwrap();

        let status = read_codex_runtime_status_from_home(&temp_dir, "/tmp/demo").unwrap();

        assert_eq!(status.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(status.context_window.max_tokens, Some(272000));
        assert_eq!(status.usage.total_tokens, Some(1460));
        assert_eq!(status.usage.cached_input_tokens, Some(250));
    }

    #[test]
    fn codex_resume_target_reads_latest_thread_id() {
        let temp_dir = temp_test_dir("codex-resume-target");
        let sessions_dir = temp_dir
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("03")
            .join("08");
        fs::create_dir_all(&sessions_dir).unwrap();
        let file_path = sessions_dir.join("session.jsonl");
        fs::write(
            &file_path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/tmp/demo\",\"id\":\"session-123\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.4\"}}\n"
            ),
        )
        .unwrap();

        let target = read_codex_resume_target_from_home(&temp_dir, "/tmp/demo");
        assert_eq!(target.as_deref(), Some("session-123"));
    }

    #[test]
    fn claude_project_path_normalizes_workspace_path() {
        assert_eq!(
            claude_project_path("/Users/demo/.worktrees/repo"),
            "Users-demo--worktrees-repo"
        );
    }

    #[test]
    fn gemini_runtime_status_reads_latest_message_tokens() {
        let temp_dir = temp_test_dir("gemini-runtime-status");
        let gemini_dir = temp_dir.join(".gemini");
        let chats_dir = gemini_dir.join("tmp").join("demo").join("chats");
        fs::create_dir_all(&chats_dir).unwrap();
        fs::write(
            gemini_dir.join("projects.json"),
            "{\"projects\":{\"/tmp/demo\":\"demo\"}}",
        )
        .unwrap();
        fs::write(
            chats_dir.join("session-1.json"),
            r#"{"messages":[{"type":"gemini","model":"gemini-3-flash-preview","tokens":{"input":1200,"output":150,"cached":400,"thoughts":25,"tool":10,"total":1785}}]}"#,
        )
        .unwrap();

        let status = read_gemini_runtime_status_from_base(&gemini_dir, "/tmp/demo").unwrap();

        assert_eq!(status.model.as_deref(), Some("gemini-3-flash-preview"));
        assert_eq!(status.usage.total_tokens, Some(1785));
        assert_eq!(status.usage.reasoning_tokens, Some(25));
        assert_eq!(status.usage.tool_tokens, Some(10));
    }

    #[test]
    fn claude_resume_target_reads_latest_session_file_stem() {
        let temp_dir = temp_test_dir("claude-resume-target");
        let project_dir = temp_dir
            .join(".claude")
            .join("projects")
            .join(claude_project_path("/tmp/demo"));
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(
            project_dir.join("11111111-1111-1111-1111-111111111111.jsonl"),
            "{}",
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        fs::write(
            project_dir.join("22222222-2222-2222-2222-222222222222.jsonl"),
            "{}",
        )
        .unwrap();

        let home = temp_dir.clone();
        let target = {
            let project_dir = home
                .join(".claude")
                .join("projects")
                .join(claude_project_path("/tmp/demo"));
            let file_path = find_latest_session_file(&project_dir).unwrap();
            file_path
                .file_stem()
                .and_then(|value| value.to_str())
                .and_then(trimmed_or_none)
        };

        assert_eq!(
            target.as_deref(),
            Some("22222222-2222-2222-2222-222222222222")
        );
    }

    #[test]
    fn gemini_resume_target_uses_latest_marker_for_project() {
        let temp_dir = temp_test_dir("gemini-resume-target");
        let gemini_dir = temp_dir.join(".gemini");
        let chats_dir = gemini_dir.join("tmp").join("demo").join("chats");
        fs::create_dir_all(&chats_dir).unwrap();
        fs::write(
            gemini_dir.join("projects.json"),
            "{\"projects\":{\"/tmp/demo\":\"demo\"}}",
        )
        .unwrap();
        fs::write(
            chats_dir.join("session-1.json"),
            r#"{"messages":[{"type":"gemini","model":"gemini-3-flash-preview"}]}"#,
        )
        .unwrap();

        let target = read_gemini_resume_target_from_base(&gemini_dir, "/tmp/demo");
        assert_eq!(target.as_deref(), Some("latest"));
    }

    #[test]
    fn qwen_runtime_status_reads_ui_telemetry_usage() {
        let temp_dir = temp_test_dir("qwen-runtime-status");
        let chats_dir = temp_dir
            .join(".qwen")
            .join("projects")
            .join("demo")
            .join("chats");
        fs::create_dir_all(&chats_dir).unwrap();
        fs::write(
            chats_dir.join("session.jsonl"),
            concat!(
                "{\"type\":\"system\",\"subtype\":\"ui_telemetry\",\"cwd\":\"/tmp/demo\",\"systemPayload\":{\"uiEvent\":{\"event.name\":\"qwen-code.api_response\",\"model\":\"coder-model\",\"input_token_count\":1400,\"output_token_count\":120,\"cached_content_token_count\":350,\"thoughts_token_count\":20,\"tool_token_count\":5,\"total_token_count\":1895}}}\n"
            ),
        )
        .unwrap();

        let status = read_qwen_runtime_status_from_home(&temp_dir, "/tmp/demo").unwrap();

        assert_eq!(status.model.as_deref(), Some("coder-model"));
        assert_eq!(status.usage.total_tokens, Some(1895));
        assert_eq!(status.usage.cached_input_tokens, Some(350));
    }

    fn temp_test_dir(label: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("{label}-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }
}
