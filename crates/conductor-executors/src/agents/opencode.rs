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

#[derive(Clone)]
pub struct OpenCodeExecutor {
    binary: PathBuf,
}

impl OpenCodeExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["opencode", "open-code", "open_code"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for OpenCodeExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }

    fn name(&self) -> &str {
        "OpenCode"
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
        if options.interactive && !options.structured_output {
            let mut args = Vec::new();

            if let Some(model) = &options.model {
                if let Some(model) = normalize_model_id(Some(model)) {
                    args.push("--model".to_string());
                    args.push(model);
                }
            }

            if let Some(reasoning_effort) = normalize_variant(options.reasoning_effort.as_deref()) {
                args.push("--variant".to_string());
                args.push(reasoning_effort);
            }

            args.extend(options.sanitized_extra_args());

            if let Some(resume_target) = &options.resume_target {
                args.push("--session".to_string());
                args.push(resume_target.clone());
            }

            if !options.prompt.trim().is_empty() {
                args.push("--prompt".to_string());
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "run".to_string(),
            "--format".to_string(),
            "json".to_string(),
            "--thinking".to_string(),
        ];

        if let Some(model) = &options.model {
            if let Some(model) = normalize_model_id(Some(model)) {
                args.push("--model".to_string());
                args.push(model);
            }
        }

        if let Some(reasoning_effort) = normalize_variant(options.reasoning_effort.as_deref()) {
            args.push("--variant".to_string());
            args.push(reasoning_effort);
        }

        args.extend(options.sanitized_extra_args());
        if let Some(resume_target) = &options.resume_target {
            args.push("--session".to_string());
            args.push(resume_target.clone());
        }
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return ExecutorOutput::Stdout(String::new());
        }

        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            if is_opencode_terminal_noise_line(trimmed) {
                return ExecutorOutput::Stdout(String::new());
            }
            return ExecutorOutput::Stdout(trimmed.to_string());
        };

        match value.get("type").and_then(Value::as_str) {
            Some("text") => extract_text_output(&value),
            Some("reasoning") => extract_reasoning_output(&value),
            Some("tool_use") => extract_tool_output(&value),
            Some("error") => ExecutorOutput::Failed {
                error: extract_error_message(&value)
                    .unwrap_or_else(|| "OpenCode failed".to_string()),
                exit_code: Some(1),
            },
            Some("step_start") | Some("step_finish") => ExecutorOutput::Stdout(String::new()),
            _ => ExecutorOutput::Stdout(String::new()),
        }
    }
}

fn normalize_variant(reasoning_effort: Option<&str>) -> Option<String> {
    let normalized = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_ascii_lowercase();

    let variant = match normalized.as_str() {
        "minimal" | "low" => "minimal",
        "medium" | "high" => "high",
        "xhigh" | "extra-high" | "extra_high" | "extra high" | "max" => "max",
        other => other,
    };

    Some(variant.to_string())
}

fn normalize_model_id(model: Option<&str>) -> Option<String> {
    let value = model
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    if value.contains('/') {
        Some(value.to_string())
    } else {
        None
    }
}

fn extract_text_output(value: &Value) -> ExecutorOutput {
    let Some(text) = value
        .get("part")
        .and_then(|part| part.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return ExecutorOutput::Stdout(String::new());
    };

    ExecutorOutput::Stdout(text.to_string())
}

fn extract_reasoning_output(value: &Value) -> ExecutorOutput {
    let detail = value
        .get("part")
        .and_then(|part| part.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("Thinking");

    ExecutorOutput::StructuredStatus {
        text: "Thinking".to_string(),
        metadata: tool_metadata("thinking", "Thinking", "running", vec![detail.to_string()]),
    }
}

fn extract_tool_output(value: &Value) -> ExecutorOutput {
    let Some(part) = value.get("part") else {
        return ExecutorOutput::Stdout(String::new());
    };

    let tool_name = part
        .get("tool")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
        .unwrap_or("tool");
    let title = tool_title(tool_name);
    let status = part
        .get("state")
        .and_then(|state| state.get("status"))
        .and_then(Value::as_str)
        .map(normalize_tool_status)
        .unwrap_or("running");

    ExecutorOutput::StructuredStatus {
        text: title.clone(),
        metadata: tool_metadata(
            &normalize_tool_kind(tool_name),
            &title,
            status,
            tool_content_from_part(part),
        ),
    }
}

fn extract_error_message(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .or_else(|| {
            value
                .get("part")
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn tool_content_from_part(part: &Value) -> Vec<String> {
    let mut content = Vec::new();

    if let Some(call_id) = part
        .get("callID")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content.push(format!("id: {call_id}"));
    }

    let state = part.get("state");
    let input = state.and_then(|value| value.get("input"));
    let metadata = state.and_then(|value| value.get("metadata"));

    for candidate in [
        input.and_then(|value| value.get("command")),
        input.and_then(|value| value.get("description")),
        input.and_then(|value| value.get("filePath")),
        input.and_then(|value| value.get("file_path")),
        input.and_then(|value| value.get("path")),
        input.and_then(|value| value.get("dir")),
        input.and_then(|value| value.get("query")),
        input.and_then(|value| value.get("url")),
        metadata.and_then(|value| value.get("description")),
        metadata.and_then(|value| value.get("preview")),
    ] {
        if let Some(text) = candidate
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            content.push(text.to_string());
            return content;
        }
    }

    if let Some(title) = state
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content.push(title.to_string());
        return content;
    }

    if let Some(input) = input {
        if let Ok(serialized) = serde_json::to_string(input) {
            if !serialized.trim().is_empty() && serialized != "{}" {
                content.push(serialized);
            }
        }
    }

    content
}

fn tool_title(tool_name: &str) -> String {
    tool_name
        .split(['_', '-'])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let lower = segment.to_ascii_lowercase();
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_tool_kind(tool_name: &str) -> String {
    tool_name.trim().to_ascii_lowercase()
}

fn normalize_tool_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "completed" | "complete" | "success" | "done" => "completed",
        "failed" | "error" | "errored" => "failed",
        _ => "running",
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_requests_json_run_stream() {
        let executor = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("."),
            prompt: "Review the repo".to_string(),
            model: Some("openai/gpt-5".to_string()),
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

        assert_eq!(args[0], "run");
        assert!(args.contains(&"--format".to_string()));
        assert!(args.contains(&"json".to_string()));
        assert!(args.contains(&"--thinking".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"openai/gpt-5".to_string()));
        assert!(args.contains(&"--variant".to_string()));
        assert!(args.contains(&"max".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("Review the repo"));
    }

    #[test]
    fn build_args_skips_invalid_model_format() {
        let executor = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("."),
            prompt: "Review the repo".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: None,
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(!args.contains(&"--model".to_string()));
        assert!(args.contains(&"--thinking".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("Review the repo"));
    }

    #[test]
    fn build_args_interactive_uses_prompt_flag_instead_of_project_positional() {
        let executor = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("."),
            prompt: "Inspect the failing tests".to_string(),
            model: Some("openai/gpt-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: false,
            extra_args: vec!["--agent".to_string(), "build".to_string()],
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: Some("session-123".to_string()),
        });

        assert!(!args.contains(&"run".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"--variant".to_string()));
        assert!(args.contains(&"high".to_string()));
        assert!(args.contains(&"--agent".to_string()));
        assert!(args.contains(&"build".to_string()));
        assert!(args.contains(&"--session".to_string()));
        assert!(args.contains(&"session-123".to_string()));
        assert_eq!(
            args.windows(2)
                .find(|pair| pair[0] == "--prompt")
                .map(|pair| pair[1].as_str()),
            Some("Inspect the failing tests")
        );
    }

    #[test]
    fn parse_text_event_emits_stdout() {
        let executor = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"));
        let line = r#"{"type":"text","part":{"text":"Hello!"}}"#;

        let output = executor.parse_output(line);
        assert!(matches!(output, ExecutorOutput::Stdout(ref text) if text == "Hello!"));
    }

    #[test]
    fn parse_reasoning_event_emits_structured_status() {
        let executor = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"));
        let line = r#"{"type":"reasoning","part":{"text":"**Planning**"}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Thinking");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("thinking")
        );
        assert_eq!(
            metadata
                .get("toolContent")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(Value::as_str),
            Some("**Planning**")
        );
    }

    #[test]
    fn parse_tool_use_event_emits_structured_status() {
        let executor = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"));
        let line = r#"{"type":"tool_use","part":{"callID":"call_123","tool":"bash","state":{"status":"completed","input":{"command":"ls -1","description":"Lists files"},"metadata":{"exit":0}}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Bash");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("bash")
        );
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            metadata
                .get("toolContent")
                .and_then(Value::as_array)
                .and_then(|values| values.get(1))
                .and_then(Value::as_str),
            Some("ls -1")
        );
    }
}
