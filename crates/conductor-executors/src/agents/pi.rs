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
pub struct PiExecutor {
    binary: PathBuf,
}

impl PiExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["pi"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for PiExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Pi
    }

    fn name(&self) -> &str {
        "Pi"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("--version").output().await?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = if options.structured_output || !options.interactive {
            spawn_process_no_stdin(&self.binary, &args, &options.cwd, &options.env).await?
        } else {
            spawn_process(&self.binary, &args, &options.cwd, &options.env).await?
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
        let mut args = Vec::new();

        if options.structured_output {
            args.push("--mode".to_string());
            args.push("json".to_string());
        } else if !options.interactive {
            args.push("-p".to_string());
        }

        if let Some(model) = normalize_cli_value(options.model.as_deref()) {
            args.push("--model".to_string());
            args.push(model);
        }

        if let Some(thinking) = normalize_thinking_level(options.reasoning_effort.as_deref()) {
            args.push("--thinking".to_string());
            args.push(thinking);
        }

        args.extend(options.sanitized_extra_args());

        if let Some(resume_target) = normalize_cli_value(options.resume_target.as_deref()) {
            args.push("--session".to_string());
            args.push(resume_target);
        }

        if !options.prompt.trim().is_empty() {
            args.push(options.prompt.clone());
        }

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return ExecutorOutput::Stdout(String::new());
        }

        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return parse_pi_event(&value);
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("no models available")
            || lower.contains("api key") && lower.contains("missing")
            || lower.contains("authentication") && lower.contains("required")
            || lower.contains("run") && lower.contains("login")
        {
            return ExecutorOutput::NeedsInput(
                "Pi needs a configured provider or login. Run `pi` once locally to finish setup."
                    .to_string(),
            );
        }

        if lower.starts_with("error:") || lower.starts_with("failed:") {
            return ExecutorOutput::Failed {
                error: trimmed.to_string(),
                exit_code: Some(1),
            };
        }

        ExecutorOutput::Stdout(trimmed.to_string())
    }
}

fn normalize_cli_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_thinking_level(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let mapped = match normalized.as_str() {
        "none" | "off" => "off",
        "minimal" | "min" => "minimal",
        "low" => "low",
        "medium" | "med" => "medium",
        "high" => "high",
        "xhigh" | "extra-high" | "extra_high" | "extra high" | "max" => "xhigh",
        other => other,
    };
    Some(mapped.to_string())
}

fn parse_pi_event(value: &Value) -> ExecutorOutput {
    match value.get("type").and_then(Value::as_str) {
        Some("session") => parse_session_header(value),
        Some("message_update") => parse_message_update(value),
        Some("tool_execution_start") => parse_tool_status(value, "running"),
        Some("tool_execution_update") => parse_tool_status(value, "running"),
        Some("tool_execution_end") => {
            let is_error = value
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            parse_tool_status(value, if is_error { "failed" } else { "completed" })
        }
        Some("compaction_start") => ExecutorOutput::StructuredStatus {
            text: "Compacting".to_string(),
            metadata: tool_metadata("compaction", "Compacting", "running", Vec::new()),
        },
        Some("auto_retry_start") => ExecutorOutput::StructuredStatus {
            text: "Retrying".to_string(),
            metadata: tool_metadata(
                "retry",
                "Retrying",
                "running",
                value
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .map(|message| vec![message.to_string()])
                    .unwrap_or_default(),
            ),
        },
        Some("agent_start")
        | Some("agent_end")
        | Some("turn_start")
        | Some("turn_end")
        | Some("message_start")
        | Some("message_end")
        | Some("queue_update")
        | Some("compaction_end")
        | Some("auto_retry_end") => ExecutorOutput::Stdout(String::new()),
        _ => ExecutorOutput::Stdout(String::new()),
    }
}

fn parse_session_header(value: &Value) -> ExecutorOutput {
    let Some(session_id) = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ExecutorOutput::Stdout(String::new());
    };

    let mut metadata = HashMap::new();
    metadata.insert(
        "eventKind".to_string(),
        Value::String("native_resume_target".to_string()),
    );
    metadata.insert(
        "nativeResumeTarget".to_string(),
        Value::String(session_id.to_string()),
    );
    ExecutorOutput::StructuredStatus {
        text: String::new(),
        metadata,
    }
}

fn parse_message_update(value: &Value) -> ExecutorOutput {
    let event = value.get("assistantMessageEvent").unwrap_or(&Value::Null);
    match event.get("type").and_then(Value::as_str) {
        Some("text_delta") => event
            .get("delta")
            .and_then(Value::as_str)
            .map(|text| ExecutorOutput::Stdout(text.to_string()))
            .unwrap_or_else(|| ExecutorOutput::Stdout(String::new())),
        Some("thinking_start") | Some("thinking_delta") | Some("thinking_end") => {
            let detail = event
                .get("delta")
                .or_else(|| event.get("content"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Thinking");
            ExecutorOutput::StructuredStatus {
                text: "Thinking".to_string(),
                metadata: tool_metadata(
                    "thinking",
                    "Thinking",
                    "running",
                    vec![detail.to_string()],
                ),
            }
        }
        Some("error") => ExecutorOutput::Failed {
            error: event
                .get("errorMessage")
                .or_else(|| event.get("message"))
                .or_else(|| event.get("reason"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Pi failed")
                .to_string(),
            exit_code: Some(1),
        },
        _ => ExecutorOutput::Stdout(String::new()),
    }
}

fn parse_tool_status(value: &Value, status: &str) -> ExecutorOutput {
    let tool_name = value
        .get("toolName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("tool");
    let title = tool_title(tool_name);
    let mut content = tool_content(value);
    if status == "failed" && content.is_empty() {
        content.push("Tool failed".to_string());
    }

    ExecutorOutput::StructuredStatus {
        text: title.clone(),
        metadata: tool_metadata(&normalize_tool_kind(tool_name), &title, status, content),
    }
}

fn tool_content(value: &Value) -> Vec<String> {
    let mut content = Vec::new();

    for root_key in ["args", "partialResult", "result"] {
        let Some(root) = value.get(root_key) else {
            continue;
        };
        collect_text_from_value(root, &mut content);
        if !content.is_empty() {
            return content;
        }
    }

    content
}

fn collect_text_from_value(value: &Value, content: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                content.push(trimmed.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text_from_value(item, content);
                if !content.is_empty() {
                    return;
                }
            }
        }
        Value::Object(map) => {
            for key in [
                "command",
                "description",
                "path",
                "filePath",
                "file_path",
                "query",
                "url",
                "text",
            ] {
                if let Some(text) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    content.push(text.to_string());
                    return;
                }
            }

            if let Some(items) = map.get("content").and_then(Value::as_array) {
                for item in items {
                    collect_text_from_value(item, content);
                    if !content.is_empty() {
                        return;
                    }
                }
            }
        }
        _ => {}
    }
}

fn tool_title(tool_name: &str) -> String {
    tool_name
        .split(['_', '-'])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let lower = segment.to_ascii_lowercase();
            match lower.as_str() {
                "mcp" => "MCP".to_string(),
                _ => {
                    let mut chars = lower.chars();
                    match chars.next() {
                        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                        None => String::new(),
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_tool_kind(tool_name: &str) -> String {
    tool_name.trim().to_ascii_lowercase()
}

fn tool_metadata(
    kind: &str,
    title: &str,
    status: &str,
    content: Vec<String>,
) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert("toolKind".to_string(), Value::String(kind.to_string()));
    metadata.insert("toolTitle".to_string(), Value::String(title.to_string()));
    metadata.insert("toolStatus".to_string(), Value::String(status.to_string()));
    if !content.is_empty() {
        metadata.insert(
            "toolContent".to_string(),
            Value::Array(content.into_iter().map(Value::String).collect()),
        );
    }
    metadata
}
