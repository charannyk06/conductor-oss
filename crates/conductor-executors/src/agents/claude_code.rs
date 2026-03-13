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

                if let Some(model) = &options.model {
                    args.push("--model".to_string());
                    args.push(model.clone());
                }

                if let Some(reasoning_effort) = &options.reasoning_effort {
                    args.push("--effort".to_string());
                    args.push(reasoning_effort.clone());
                }

                args.extend(options.sanitized_extra_args());
                return args;
            }

            if options.skip_permissions {
                args.push("--dangerously-skip-permissions".to_string());
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }

            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("--effort".to_string());
                args.push(reasoning_effort.clone());
            }

            args.extend(options.sanitized_extra_args());
            if !options.prompt.trim().is_empty() {
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

        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(reasoning_effort) = &options.reasoning_effort {
            args.push("--effort".to_string());
            args.push(reasoning_effort.clone());
        }

        // Add extra args.
        args.extend(options.sanitized_extra_args());

        // Add the prompt as the final argument.
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
                "system" | "rate_limit_event" | "user" => {
                    return ExecutorOutput::Composite(Vec::new());
                }
                "assistant" => {
                    return ExecutorOutput::Composite(extract_assistant_events(&value));
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
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array());

    let Some(content) = content else {
        return Vec::new();
    };

    let mut events = Vec::new();
    for block in content {
        match block.get("type").and_then(|value| value.as_str()) {
            Some("text") => {
                if let Some(text) = block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    events.push(ExecutorOutput::Stdout(text.to_string()));
                }
            }
            Some("thinking") => {
                let detail = block
                    .get("thinking")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Thinking");
                events.push(ExecutorOutput::StructuredStatus {
                    text: "Thinking".to_string(),
                    metadata: tool_metadata(
                        "thinking",
                        "Thinking",
                        "running",
                        vec![detail.to_string()],
                    ),
                });
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
                events.push(ExecutorOutput::StructuredStatus {
                    text: name.to_string(),
                    metadata: tool_metadata(&normalize_tool_kind(name), name, "running", content),
                });
            }
            _ => {}
        }
    }

    events
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_assistant_tool_use_emits_structured_status() {
        let executor = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude"));
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#;

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
        assert!(args.contains(&"sonnet".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"medium".to_string()));
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
}
