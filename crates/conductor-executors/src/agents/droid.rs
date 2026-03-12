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
pub struct DroidExecutor {
    binary: PathBuf,
}

impl DroidExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["droid"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for DroidExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Droid
    }
    fn name(&self) -> &str {
        "Droid"
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
        if options.interactive {
            let mut args = Vec::new();

            if options.structured_output {
                args.push("--output-format".to_string());
                args.push("json".to_string());
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }

            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("--reasoning-effort".to_string());
                args.push(reasoning_effort.clone());
            }

            if options.skip_permissions {
                args.push("--skip-permissions-unsafe".to_string());
            }

            args.extend(options.sanitized_extra_args());

            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "exec".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
        ];
        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if let Some(reasoning_effort) = &options.reasoning_effort {
            args.push("--reasoning-effort".to_string());
            args.push(reasoning_effort.clone());
        }
        if options.skip_permissions {
            args.push("--skip-permissions-unsafe".to_string());
        }
        args.extend(options.sanitized_extra_args());
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return ExecutorOutput::Stdout(String::new());
        }

        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            return ExecutorOutput::Stdout(trimmed.to_string());
        };

        let subtype = value
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || subtype.eq_ignore_ascii_case("failure")
        {
            let error = extract_droid_text(&value).unwrap_or_else(|| "Droid failed".to_string());
            if error.to_ascii_lowercase().contains("authentication failed") {
                return ExecutorOutput::NeedsInput(
                    "Droid authentication required. Export FACTORY_API_KEY or log into Factory before retrying."
                        .to_string(),
                );
            }
            return ExecutorOutput::Failed {
                error,
                exit_code: Some(1),
            };
        }

        match value.get("type").and_then(Value::as_str) {
            Some("assistant") | Some("message") => {
                if let Some(text) = extract_droid_text(&value) {
                    return ExecutorOutput::Stdout(text);
                }
                ExecutorOutput::Stdout(String::new())
            }
            Some("tool_use") | Some("tool.execution_start") => {
                let tool_name = value
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("name").and_then(Value::as_str))
                    .unwrap_or("tool");
                ExecutorOutput::StructuredStatus {
                    text: title_case(tool_name),
                    metadata: tool_metadata(
                        tool_name,
                        &title_case(tool_name),
                        "running",
                        tool_summary(value.get("parameters").or_else(|| value.get("arguments"))),
                    ),
                }
            }
            Some("tool.execution_complete") => {
                let tool_name = value
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("name").and_then(Value::as_str))
                    .unwrap_or("tool");
                ExecutorOutput::StructuredStatus {
                    text: title_case(tool_name),
                    metadata: tool_metadata(
                        tool_name,
                        &title_case(tool_name),
                        "completed",
                        tool_summary(value.get("result")),
                    ),
                }
            }
            Some("result") => ExecutorOutput::Completed { exit_code: 0 },
            _ => ExecutorOutput::Stdout(String::new()),
        }
    }
}

fn extract_droid_text(value: &Value) -> Option<String> {
    for candidate in [
        value.get("result"),
        value.get("message"),
        value.get("content"),
        value.get("text"),
        value.get("data").and_then(|data| data.get("content")),
    ] {
        if let Some(text) = candidate
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn title_case(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn tool_summary(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };

    if let Some(record) = value.as_object() {
        for key in ["command", "description", "path", "query", "url", "content"] {
            if let Some(text) = record
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return vec![text.to_string()];
            }
        }
    }

    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| vec![text.to_string()])
        .or_else(|| {
            serde_json::to_string(value)
                .ok()
                .filter(|text| !text.trim().is_empty() && text != "{}")
                .map(|text| vec![text])
        })
        .unwrap_or_default()
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
    fn parse_auth_failure_requests_input() {
        let executor = DroidExecutor::new(PathBuf::from("/usr/bin/droid"));
        let line = r#"{"type":"result","subtype":"failure","is_error":true,"result":"Authentication failed. Please log into Factory or set a valid FACTORY_API_KEY."}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::NeedsInput(prompt) = output else {
            panic!("expected needs-input output");
        };
        assert!(prompt.contains("FACTORY_API_KEY"));
    }
}
