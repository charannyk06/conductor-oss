use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::spawn_process;

/// OpenAI Codex CLI executor.
#[derive(Clone)]
pub struct CodexExecutor {
    binary: PathBuf,
}

impl CodexExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["codex"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for CodexExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn name(&self) -> &str {
        "Codex"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("--version").output().await?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = spawn_process(&self.binary, &args, &options.cwd, &options.env).await?;
        let output_rx = wrap_parsed_output(self.clone(), handle.output_rx);

        Ok(ExecutorHandle::new(
            handle.pid,
            self.kind(),
            output_rx,
            handle.input_tx,
            handle.kill_tx,
        )
        .with_terminal_io(handle.terminal_rx, handle.resize_tx))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        if options.structured_output {
            let mut args = vec![
                "exec".to_string(),
                "--color".to_string(),
                "never".to_string(),
            ];

            if options.resume_target.is_some() {
                args.push("resume".to_string());
            }

            args.push("--json".to_string());

            if options.skip_permissions {
                args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }

            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
            }

            args.extend(options.sanitized_extra_args());

            if let Some(resume_target) = &options.resume_target {
                args.push(resume_target.clone());
                if options.prompt.trim().is_empty() {
                    args.push("-".to_string());
                } else {
                    args.push(options.prompt.clone());
                }
            } else {
                // codex exec takes the prompt as a positional argument in headless mode.
                args.push(options.prompt.clone());
            }

            return args;
        }

        if options.interactive {
            let mut args = vec!["--no-alt-screen".to_string()];

            if let Some(resume_target) = &options.resume_target {
                args.push("resume".to_string());

                if let Some(model) = &options.model {
                    args.push("--model".to_string());
                    args.push(model.clone());
                }

                if let Some(reasoning_effort) = &options.reasoning_effort {
                    args.push("-c".to_string());
                    args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
                }

                if options.skip_permissions {
                    args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
                }

                args.extend(options.sanitized_extra_args());
                args.push(resume_target.clone());
                return args;
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }

            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
            }

            if options.skip_permissions {
                args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
            }

            args.extend(options.sanitized_extra_args());
            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "exec".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "--json".to_string(),
        ];

        if options.skip_permissions {
            args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
        }

        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(reasoning_effort) = &options.reasoning_effort {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
        }

        args.extend(options.sanitized_extra_args());

        // codex exec takes the prompt as a positional argument in headless mode.
        args.push(options.prompt.clone());

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return ExecutorOutput::Stdout(String::new());
        }

        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if let Some(event_type) = value.get("type").and_then(|v| v.as_str()) {
                match event_type {
                    "agent_message" => {
                        if let Some(text) = extract_text(&value) {
                            return ExecutorOutput::Stdout(text);
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "agent_message_delta" => {
                        if let Some(text) = extract_text(&value) {
                            return ExecutorOutput::Stdout(text);
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "thread.started" => {
                        if let Some(thread_id) = value
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                        {
                            let mut metadata = HashMap::new();
                            metadata.insert(
                                "eventKind".to_string(),
                                Value::String("thread_started".to_string()),
                            );
                            metadata.insert(
                                "codexThreadId".to_string(),
                                Value::String(thread_id.to_string()),
                            );
                            return ExecutorOutput::StructuredStatus {
                                text: String::new(),
                                metadata,
                            };
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "turn.started" | "turn.completed" | "task.started" => {
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "item.started" => {
                        if let Some(item) = value.get("item") {
                            match item.get("type").and_then(|v| v.as_str()) {
                                Some("command_execution") => {
                                    if let Some(command) = item
                                        .get("command")
                                        .and_then(|v| v.as_str())
                                        .map(str::trim)
                                        .filter(|v| !v.is_empty())
                                    {
                                        return ExecutorOutput::StructuredStatus {
                                            text: "Command".to_string(),
                                            metadata: tool_metadata(
                                                "command",
                                                "Command",
                                                "running",
                                                vec![command.to_string()],
                                            ),
                                        };
                                    }
                                }
                                Some("reasoning") => {
                                    return ExecutorOutput::StructuredStatus {
                                        text: "Thinking".to_string(),
                                        metadata: tool_metadata(
                                            "thinking",
                                            "Thinking",
                                            "running",
                                            Vec::new(),
                                        ),
                                    };
                                }
                                Some("mcp_tool_call") => {
                                    return ExecutorOutput::StructuredStatus {
                                        text: tool_title_from_item(item),
                                        metadata: tool_metadata(
                                            &tool_kind_from_item(item),
                                            &tool_title_from_item(item),
                                            "running",
                                            tool_content_from_item(item),
                                        ),
                                    };
                                }
                                _ => {}
                            }
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "item.completed" => {
                        if let Some(item) = value.get("item") {
                            match item.get("type").and_then(|v| v.as_str()) {
                                Some("agent_message") => {
                                    if let Some(text) = extract_text(item) {
                                        return ExecutorOutput::Stdout(text);
                                    }
                                }
                                Some("reasoning") => return ExecutorOutput::Stdout(String::new()),
                                Some("command_execution") => {
                                    return ExecutorOutput::Stdout(String::new())
                                }
                                Some("mcp_tool_call") => {
                                    return ExecutorOutput::Stdout(String::new())
                                }
                                _ => {}
                            }
                        }
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "error" => {
                        let error = value
                            .get("message")
                            .and_then(|v| v.as_str())
                            .or_else(|| value.get("error").and_then(|v| v.as_str()))
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .unwrap_or("Codex failed")
                            .to_string();
                        return ExecutorOutput::Failed {
                            error,
                            exit_code: Some(1),
                        };
                    }
                    _ => return ExecutorOutput::Stdout(String::new()),
                }
            }

            if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
                match method {
                    "message" => {
                        if let Some(content) = value
                            .get("params")
                            .and_then(|p| p.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            return ExecutorOutput::Stdout(content.to_string());
                        }
                    }
                    "done" => return ExecutorOutput::Completed { exit_code: 0 },
                    _ => return ExecutorOutput::Stdout(String::new()),
                }
            }

            return ExecutorOutput::Stdout(String::new());
        }

        if is_internal_codex_log_line(trimmed) {
            return ExecutorOutput::Stdout(String::new());
        }

        ExecutorOutput::Stdout(trimmed.to_string())
    }
}

fn is_internal_codex_log_line(line: &str) -> bool {
    let mut parts = line.split_whitespace();
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

fn looks_like_iso8601_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && value.ends_with('Z')
}

fn tool_title_from_item(item: &Value) -> String {
    if let Some(tool) = item
        .get("tool")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return tool
            .split(['_', '-'])
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                let lower = segment.to_ascii_lowercase();
                match lower.as_str() {
                    "mcp" => "MCP".to_string(),
                    _ => {
                        let mut chars = lower.chars();
                        match chars.next() {
                            Some(first) => {
                                format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                            }
                            None => String::new(),
                        }
                    }
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }

    "Tool".to_string()
}

fn tool_kind_from_item(item: &Value) -> String {
    item.get("tool")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("tool")
        .to_ascii_lowercase()
}

fn tool_content_from_item(item: &Value) -> Vec<String> {
    let mut content = Vec::new();
    if let Some(server) = item
        .get("server")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        content.push(format!("server: {server}"));
    }
    if let Some(arguments) = item.get("arguments") {
        if let Some(path) = arguments
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            content.push(path.to_string());
        } else if let Some(pattern) = arguments
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            content.push(pattern.to_string());
        } else if let Ok(serialized) = serde_json::to_string(arguments) {
            if !serialized.trim().is_empty() && serialized != "{}" {
                content.push(serialized);
            }
        }
    }
    content
}

fn tool_metadata(
    tool_kind: &str,
    tool_title: &str,
    tool_status: &str,
    tool_content: Vec<String>,
) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert("toolKind".to_string(), Value::String(tool_kind.to_string()));
    metadata.insert(
        "toolTitle".to_string(),
        Value::String(tool_title.to_string()),
    );
    metadata.insert(
        "toolStatus".to_string(),
        Value::String(tool_status.to_string()),
    );
    metadata.insert(
        "toolContent".to_string(),
        Value::Array(tool_content.into_iter().map(Value::String).collect()),
    );
    metadata
}

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Some(text.to_string());
    }

    if let Some(message) = value.get("message") {
        if let Some(text) = extract_text(message) {
            return Some(text);
        }
    }

    let content = value.get("content").and_then(|v| v.as_array())?;
    let text = content
        .iter()
        .filter_map(|item| {
            item.get("text")
                .and_then(|v| v.as_str())
                .or_else(|| item.as_str())
                .map(str::trim)
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_started_mcp_tool_call_emits_structured_status() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let line = r#"{"type":"item.started","item":{"type":"mcp_tool_call","tool":"read_text_file","server":"filesystem","arguments":{"path":"/tmp/demo.txt"}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Read Text File");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("read_text_file")
        );
    }

    #[test]
    fn parse_thread_started_emits_resume_target_metadata() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let output =
            executor.parse_output(r#"{"type":"thread.started","thread_id":"session-123"}"#);

        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert!(text.is_empty());
        assert_eq!(
            metadata.get("eventKind").and_then(Value::as_str),
            Some("thread_started")
        );
        assert_eq!(
            metadata.get("codexThreadId").and_then(Value::as_str),
            Some("session-123")
        );
    }

    #[test]
    fn build_args_includes_reasoning_effort_override() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"high\"".to_string()));
    }

    #[test]
    fn build_args_resumes_native_session_without_inline_prompt() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "continue".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("medium".to_string()),
            skip_permissions: true,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: Some("session-123".to_string()),
        });

        assert_eq!(args.first().map(String::as_str), Some("--no-alt-screen"));
        assert!(args.contains(&"resume".to_string()));
        assert!(args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(!args.contains(&"--yolo".to_string()));
        assert!(args.contains(&"session-123".to_string()));
        assert!(!args.contains(&"continue".to_string()));
    }

    #[test]
    fn build_args_structured_output_uses_exec_json_in_interactive_mode() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: true,
            resume_target: None,
        });

        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(args.contains(&"--json".to_string()));
        assert!(!args.contains(&"--output-format".to_string()));
        assert!(!args.contains(&"--no-alt-screen".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("hello"));
    }

    #[test]
    fn build_args_structured_resume_reads_follow_up_from_stdin() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: String::new(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: Some("medium".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: true,
            resume_target: Some("session-123".to_string()),
        });

        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(args.contains(&"resume".to_string()));
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"session-123".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(!args.contains(&"--output-format".to_string()));
    }

    #[test]
    fn parse_output_ignores_internal_codex_logs() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let line = "2026-03-09T01:31:02.130169Z WARN codex_core::mcp_connection_manager: Failed to list resources for MCP server 'filesystem': resources/list failed: Mcp error: -32601: Method not found";

        let output = executor.parse_output(line);
        let ExecutorOutput::Stdout(text) = output else {
            panic!("expected stdout suppression");
        };
        assert!(text.is_empty());
    }

    #[test]
    fn parse_output_ignores_sqlx_tracing_logs() {
        let executor = CodexExecutor::new(PathBuf::from("/usr/bin/codex"));
        let line = "2026-03-09T01:40:13.738303Z WARN sqlx::query: slow statement: execution time exceeded alert threshold";

        let output = executor.parse_output(line);
        let ExecutorOutput::Stdout(text) = output else {
            panic!("expected stdout suppression");
        };
        assert!(text.is_empty());
    }
}
