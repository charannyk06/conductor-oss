use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::executor::{Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::spawn_process;

/// OpenAI Codex CLI executor.
pub struct CodexExecutor {
    binary: PathBuf,
}

impl CodexExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        which::which("codex").ok().map(Self::new)
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

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = spawn_process(&self.binary, &args, &options.cwd, &options.env).await?;

        Ok(ExecutorHandle::new(
            handle.pid,
            self.kind(),
            handle.output_rx,
            handle.input_tx,
            handle.kill_tx,
        ))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        let mut args = vec![
            "exec".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "--json".to_string(),
        ];

        if options.skip_permissions {
            args.push("--full-auto".to_string());
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
        if let Ok(value) = serde_json::from_str::<Value>(line) {
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
                    "thread.started" | "turn.started" | "turn.completed" | "task.started" => {
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

        ExecutorOutput::Stdout(line.trim().to_string())
    }
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
        });

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"high\"".to_string()));
    }
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
