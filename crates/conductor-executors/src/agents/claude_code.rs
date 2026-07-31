use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{spawn_process, spawn_process_no_stdin};

/// Claude Code CLI executor.
#[derive(Clone)]
pub struct ClaudeCodeExecutor {
    binary: PathBuf,
}

fn normalize_claude_model(model: Option<&str>) -> Option<String> {
    let value = model.map(str::trim).filter(|value| !value.is_empty())?;
    let normalized = value.to_ascii_lowercase();
    match normalized.as_str() {
        "sonnet" | "sonnet-4" | "claude-sonnet-4" => Some("claude-sonnet-4-6".to_string()),
        "opus" | "opus-4" | "claude-opus-4" => Some("claude-opus-4-6".to_string()),
        "haiku" | "haiku-4" | "haiku-4-5" | "claude-haiku-4" => {
            Some("claude-haiku-4-5".to_string())
        }
        model if model.starts_with("claude-") => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_claude_reasoning_effort(reasoning_effort: Option<&str>) -> Option<String> {
    let value = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_ascii_lowercase();
    let normalized = match value.as_str() {
        "minimal" | "min" | "off" | "none" | "low" => "low",
        "medium" | "med" => "medium",
        "high" => "high",
        "max" | "xhigh" | "extra-high" | "extra_high" | "extra high" => "max",
        _ => return None,
    };
    Some(normalized.to_string())
}

fn push_claude_model_arg(args: &mut Vec<String>, model: Option<&str>) {
    if let Some(model) = normalize_claude_model(model) {
        args.push("--model".to_string());
        args.push(model);
    }
}

fn push_claude_reasoning_arg(args: &mut Vec<String>, reasoning_effort: Option<&str>) {
    if let Some(reasoning_effort) = normalize_claude_reasoning_effort(reasoning_effort) {
        args.push("--effort".to_string());
        args.push(reasoning_effort);
    }
}

impl ClaudeCodeExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    /// Try to find claude in PATH.
    pub fn discover() -> Option<Self> {
        discover_binary(&["claude", "claude-code"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for ClaudeCodeExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn name(&self) -> &str {
        "Claude Code"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("--version").output().await?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = if options.interactive {
            spawn_process(&self.binary, &args, &options.cwd, &options.env).await?
        } else {
            spawn_process_no_stdin(&self.binary, &args, &options.cwd, &options.env).await?
        };
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
        let sanitized_extra_args = options.sanitized_extra_args();
        let needs_prompt_separator = sanitized_extra_args.iter().any(|arg| arg == "--mcp-config");
        if options.interactive {
            let mut args = Vec::new();

            if options.structured_output {
                args.push("--print".to_string());
                args.push("--output-format".to_string());
                args.push("stream-json".to_string());
                args.push("--include-partial-messages".to_string());
                args.push("--verbose".to_string());
            }

            if let Some(resume_target) = &options.resume_target {
                args.push("--resume".to_string());
                args.push(resume_target.clone());

                if options.skip_permissions {
                    args.push("--dangerously-skip-permissions".to_string());
                }

                push_claude_model_arg(&mut args, options.model.as_deref());
                push_claude_reasoning_arg(&mut args, options.reasoning_effort.as_deref());

                args.extend(sanitized_extra_args);
                return args;
            }

            if options.skip_permissions {
                args.push("--dangerously-skip-permissions".to_string());
            }

            push_claude_model_arg(&mut args, options.model.as_deref());
            push_claude_reasoning_arg(&mut args, options.reasoning_effort.as_deref());

            args.extend(sanitized_extra_args);
            if !options.prompt.trim().is_empty() {
                if needs_prompt_separator {
                    args.push("--".to_string());
                }
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "--print".to_string(),
            "--input-format".to_string(),
            "text".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--include-partial-messages".to_string(),
            "--verbose".to_string(),
        ];

        if options.skip_permissions {
            args.push("--dangerously-skip-permissions".to_string());
        }

        push_claude_model_arg(&mut args, options.model.as_deref());
        push_claude_reasoning_arg(&mut args, options.reasoning_effort.as_deref());

        // Add extra args.
        args.extend(sanitized_extra_args);

        // Add the prompt as the final argument.
        if needs_prompt_separator {
            args.push("--".to_string());
        }
        args.push(options.prompt.clone());

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        parse_claude_stream_json_output(line, "Claude Code failed")
    }
}

pub(crate) fn parse_claude_stream_json_output(line: &str, default_error: &str) -> ExecutorOutput {
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        if let Some(msg_type) = value.get("type").and_then(|t| t.as_str()) {
            match msg_type {
                "system" => {
                    if let Some(session_id) = value
                        .get("session_id")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        return ExecutorOutput::StructuredStatus {
                            text: String::new(),
                            metadata: native_resume_target_metadata(session_id),
                        };
                    }
                    return ExecutorOutput::Composite(Vec::new());
                }
                "rate_limit_event" => {
                    return ExecutorOutput::Composite(Vec::new());
                }
                "user" => return ExecutorOutput::Composite(extract_user_events(&value)),
                "assistant" => {
                    return ExecutorOutput::Composite(extract_assistant_events(&value));
                }
                "stream_event" => {
                    return ExecutorOutput::Composite(extract_stream_event_outputs(
                        value.get("event").unwrap_or(&Value::Null),
                    ));
                }
                "result" => {
                    if value
                        .get("is_error")
                        .and_then(|flag| flag.as_bool())
                        .unwrap_or(false)
                    {
                        let error = value
                            .get("result")
                            .and_then(|result| result.as_str())
                            .map(str::trim)
                            .filter(|result| !result.is_empty())
                            .unwrap_or(default_error)
                            .to_string();
                        return ExecutorOutput::Failed {
                            error,
                            exit_code: Some(1),
                        };
                    }
                    return ExecutorOutput::Completed { exit_code: 0 };
                }
                "input_request" => {
                    let prompt = value
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Input needed")
                        .to_string();
                    return ExecutorOutput::NeedsInput(prompt);
                }
                _ => {
                    return ExecutorOutput::Composite(Vec::new());
                }
            }
        }
    }

    ExecutorOutput::Stdout(line.to_string())
}

fn extract_assistant_events(value: &Value) -> Vec<ExecutorOutput> {
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array())
    else {
        return Vec::new();
    };

    extract_content_block_events(content)
}

fn extract_stream_event_outputs(event: &Value) -> Vec<ExecutorOutput> {
    match event.get("type").and_then(|value| value.as_str()) {
        Some("message_start") => event
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .map(|content| extract_content_block_events(content))
            .unwrap_or_default(),
        Some("content_block_start") => event
            .get("content_block")
            .map(|block| {
                let stable_id = event
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|index| format!("claude-block-{index}"));
                extract_content_block_event(block, stable_id.as_deref())
            })
            .unwrap_or_default(),
        Some("content_block_delta") => {
            let Some(delta) = event.get("delta") else {
                return Vec::new();
            };
            match delta.get("type").and_then(|value| value.as_str()) {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty())
                    .map(|text| vec![ExecutorOutput::AssistantDelta(text.to_string())])
                    .unwrap_or_default(),
                // A single thinking block can produce thousands of fragments.
                // The block-start event owns one lean running card; the final
                // assistant snapshot supplies one bounded detail value.
                Some("thinking_delta") => Vec::new(),
                _ => Vec::new(),
            }
        }
        Some("message_delta" | "message_stop" | "content_block_stop" | "ping" | "error") => {
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn extract_content_block_events(content: &[Value]) -> Vec<ExecutorOutput> {
    let mut events = Vec::new();
    for (index, block) in content.iter().enumerate() {
        let stable_id = format!("claude-block-{index}");
        events.extend(extract_content_block_event(block, Some(&stable_id)));
    }

    events
}

fn extract_content_block_event(block: &Value, fallback_id: Option<&str>) -> Vec<ExecutorOutput> {
    match block.get("type").and_then(|value| value.as_str()) {
        Some("text") => block
            .get("text")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|text| vec![ExecutorOutput::Stdout(text.to_string())])
            .unwrap_or_default(),
        Some("thinking") => {
            let detail = block
                .get("thinking")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Thinking");
            let detail = detail.chars().take(4_000).collect::<String>();
            let mut metadata = tool_metadata("thinking", "Thinking", "running", vec![detail]);
            insert_tool_call_id(&mut metadata, fallback_id);
            vec![ExecutorOutput::StructuredStatus {
                text: "Thinking".to_string(),
                metadata,
            }]
        }
        Some("tool_use") => {
            let name = block
                .get("name")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Tool");
            let detail = tool_input_summary(block.get("input"));
            let content = detail.into_iter().collect::<Vec<_>>();
            let mut metadata = tool_metadata(&normalize_tool_kind(name), name, "running", content);
            insert_tool_call_id(
                &mut metadata,
                block
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .or(fallback_id),
            );
            vec![ExecutorOutput::StructuredStatus {
                text: name.to_string(),
                metadata,
            }]
        }
        _ => Vec::new(),
    }
}

fn extract_user_events(value: &Value) -> Vec<ExecutorOutput> {
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|block| {
            let tool_call_id = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let status = if block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "error"
            } else {
                "success"
            };
            let mut metadata = HashMap::new();
            metadata.insert(
                "toolCallId".to_string(),
                Value::String(tool_call_id.to_string()),
            );
            metadata.insert("toolStatus".to_string(), Value::String(status.to_string()));
            if let Some(summary) = tool_result_summary(block.get("content")) {
                metadata.insert(
                    "toolContent".to_string(),
                    Value::Array(vec![Value::String(summary)]),
                );
            }
            Some(ExecutorOutput::StructuredStatus {
                text: String::new(),
                metadata,
            })
        })
        .collect()
}

fn tool_result_summary(content: Option<&Value>) -> Option<String> {
    let content = content?;
    let raw = match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| item.as_str().map(ToOwned::to_owned))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => serde_json::to_string(other).ok()?,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(4_000).collect())
    }
}

fn native_resume_target_metadata(session_id: &str) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert(
        "eventKind".to_string(),
        Value::String("native_resume_target".to_string()),
    );
    metadata.insert(
        "nativeResumeTarget".to_string(),
        Value::String(session_id.to_string()),
    );
    metadata
}

fn normalize_tool_kind(name: &str) -> String {
    let lower = name.trim().to_ascii_lowercase();
    match lower.as_str() {
        "bash" => "command".to_string(),
        "read" => "read".to_string(),
        "write" => "write".to_string(),
        "edit" => "edit".to_string(),
        "multiedit" => "multiedit".to_string(),
        "glob" => "glob".to_string(),
        "grep" => "grep".to_string(),
        "task" => "task".to_string(),
        "todowrite" => "todowrite".to_string(),
        other => other.replace([' ', '/'], "-"),
    }
}

fn tool_input_summary(input: Option<&Value>) -> Option<String> {
    let input = input?;

    for key in [
        "command",
        "path",
        "file_path",
        "query",
        "pattern",
        "url",
        "prompt",
    ] {
        if let Some(value) = input
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }

    serde_json::to_string(input)
        .ok()
        .filter(|value| !value.trim().is_empty())
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

fn insert_tool_call_id(metadata: &mut HashMap<String, Value>, tool_call_id: Option<&str>) {
    if let Some(tool_call_id) = tool_call_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        metadata.insert(
            "toolCallId".to_string(),
            Value::String(tool_call_id.to_string()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_assistant_tool_use_emits_structured_status() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls -la"}}]}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Composite(events) = output else {
            panic!("expected composite output");
        };
        assert_eq!(events.len(), 1);
        let ExecutorOutput::StructuredStatus { text, metadata } = &events[0] else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Bash");
        assert_eq!(
            metadata.get("toolTitle").and_then(Value::as_str),
            Some("Bash")
        );
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            metadata.get("toolCallId").and_then(Value::as_str),
            Some("toolu_1")
        );
    }

    #[test]
    fn parse_user_tool_result_emits_metadata_only_completion() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"command output","is_error":false}]}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Composite(events) = output else {
            panic!("expected composite output");
        };
        let ExecutorOutput::StructuredStatus { text, metadata } = &events[0] else {
            panic!("expected structured completion");
        };
        assert!(text.is_empty());
        assert_eq!(
            metadata.get("toolCallId").and_then(Value::as_str),
            Some("toolu_1")
        );
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("success")
        );
    }

    #[test]
    fn thinking_delta_does_not_expand_tool_card_per_token() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" next"}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Composite(events) = output else {
            panic!("expected composite output");
        };
        assert!(events.is_empty());
    }

    #[test]
    fn parse_assistant_thinking_emits_status() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Inspecting files"}]}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Composite(events) = output else {
            panic!("expected composite output");
        };
        let ExecutorOutput::StructuredStatus { text, metadata } = &events[0] else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Thinking");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("thinking")
        );
    }

    #[test]
    fn build_args_includes_reasoning_effort_override() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("sonnet".to_string()),
            reasoning_effort: Some("medium".to_string()),
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
        assert!(args.contains(&"claude-sonnet-4-6".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"medium".to_string()));
    }

    #[test]
    fn build_args_normalizes_reasoning_aliases_to_claude_supported_levels() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("opus".to_string()),
            reasoning_effort: Some("xhigh".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.contains(&"claude-opus-4-6".to_string()));
        assert!(args.contains(&"max".to_string()));
        assert!(!args.contains(&"xhigh".to_string()));
    }

    #[test]
    fn build_args_resumes_native_session_without_inline_prompt() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "continue".to_string(),
            model: Some("sonnet".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: true,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: Some("123e4567-e89b-12d3-a456-426614174000".to_string()),
        });

        assert!(args.starts_with(&[
            "--resume".to_string(),
            "123e4567-e89b-12d3-a456-426614174000".to_string(),
        ]));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(!args.contains(&"continue".to_string()));
    }

    #[test]
    fn build_args_interactive_direct_terminal_omits_structured_flags() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: None,
            reasoning_effort: None,
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: None,
        });

        assert_eq!(args, vec!["hello".to_string()]);
    }

    #[test]
    fn build_args_mcp_config_inserts_separator_before_prompt() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "say exactly bridge dispatch smoke test".to_string(),
            model: Some("claude-sonnet-4-6".to_string()),
            reasoning_effort: Some("medium".to_string()),
            skip_permissions: true,
            extra_args: vec![
                "--mcp-config".to_string(),
                "{\"mcpServers\":{\"conductor\":{}}}".to_string(),
            ],
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.windows(2).any(|window| {
            window
                == [
                    "--mcp-config".to_string(),
                    "{\"mcpServers\":{\"conductor\":{}}}".to_string(),
                ]
        }));
        assert!(args.ends_with(&[
            "--".to_string(),
            "say exactly bridge dispatch smoke test".to_string(),
        ]));
    }

    #[test]
    fn parse_stream_event_text_delta_emits_assistant_delta() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Composite(events) = output else {
            panic!("expected composite output");
        };
        assert!(matches!(
            events.first(),
            Some(ExecutorOutput::AssistantDelta(text)) if text == "partial"
        ));
    }

    #[test]
    fn parse_system_session_start_emits_resume_target_metadata() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"system","subtype":"session_start","session_id":"session-123"}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { metadata, .. } = output else {
            panic!("expected structured status");
        };
        assert_eq!(
            metadata.get("nativeResumeTarget").and_then(Value::as_str),
            Some("session-123")
        );
    }
}
