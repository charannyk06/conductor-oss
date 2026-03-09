use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::spawn_process_no_stdin;

#[derive(Clone)]
pub struct CopilotExecutor {
    binary: PathBuf,
}

impl CopilotExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["github-copilot", "copilot", "gh-copilot"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for CopilotExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::GithubCopilot
    }
    fn name(&self) -> &str {
        "GitHub Copilot"
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
        let handle =
            spawn_process_no_stdin(&self.binary, &args, &options.cwd, &options.env).await?;
        let output_rx = wrap_parsed_output(self.clone(), handle.output_rx);
        Ok(ExecutorHandle::new(
            handle.pid,
            self.kind(),
            output_rx,
            handle.input_tx,
            handle.kill_tx,
        ))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        if options.interactive {
            let mut args = Vec::new();
            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "-p".to_string(),
            options.prompt.clone(),
            "--output-format".to_string(),
            "json".to_string(),
            "--stream".to_string(),
            "on".to_string(),
            "--allow-all-tools".to_string(),
        ];
        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if options.skip_permissions {
            args.push("--allow-all".to_string());
        }
        args.extend(options.sanitized_extra_args());
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

        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return ExecutorOutput::Stdout(String::new());
        };

        match kind {
            "user.message" | "assistant.turn_start" | "assistant.turn_end" => {
                ExecutorOutput::Composite(Vec::new())
            }
            "assistant.message_delta" => {
                let text = value
                    .get("data")
                    .and_then(|data| data.get("deltaContent"))
                    .and_then(Value::as_str)
                    .map(str::trim_end)
                    .unwrap_or("");
                ExecutorOutput::Stdout(text.to_string())
            }
            "assistant.reasoning" => {
                let detail = value
                    .get("data")
                    .and_then(extract_copilot_text)
                    .unwrap_or_else(|| "Thinking".to_string());
                ExecutorOutput::StructuredStatus {
                    text: "Thinking".to_string(),
                    metadata: tool_metadata("thinking", "Thinking", "running", vec![detail]),
                }
            }
            "assistant.reasoning_delta" | "assistant.message" => {
                ExecutorOutput::Composite(Vec::new())
            }
            "tool.execution_start" => {
                let data = value.get("data").unwrap_or(&Value::Null);
                let tool_name = data
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                ExecutorOutput::StructuredStatus {
                    text: title_case(tool_name),
                    metadata: tool_metadata(
                        tool_name,
                        &title_case(tool_name),
                        "running",
                        tool_summary(data.get("arguments")),
                    ),
                }
            }
            "tool.execution_complete" => {
                let data = value.get("data").unwrap_or(&Value::Null);
                let tool_name = data
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let status = if data.get("success").and_then(Value::as_bool).unwrap_or(true) {
                    "completed"
                } else {
                    "failed"
                };
                let mut content = tool_summary(data.get("result"));
                if content.is_empty() {
                    content = tool_summary(data.get("arguments"));
                }
                ExecutorOutput::StructuredStatus {
                    text: title_case(tool_name),
                    metadata: tool_metadata(tool_name, &title_case(tool_name), status, content),
                }
            }
            "result" => {
                let exit_code = value
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .unwrap_or_default() as i32;
                if exit_code == 0 {
                    ExecutorOutput::Completed { exit_code }
                } else {
                    ExecutorOutput::Failed {
                        error: "GitHub Copilot failed".to_string(),
                        exit_code: Some(exit_code),
                    }
                }
            }
            _ => ExecutorOutput::Composite(Vec::new()),
        }
    }
}

fn extract_copilot_text(data: &Value) -> Option<String> {
    for key in ["content", "text", "reasoning", "deltaContent"] {
        if let Some(value) = data
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
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
        for key in [
            "command",
            "description",
            "intent",
            "content",
            "detailedContent",
        ] {
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
    fn parse_message_delta_emits_stdout() {
        let executor = CopilotExecutor::new(PathBuf::from("/usr/bin/copilot"));
        let line =
            r#"{"type":"assistant.message_delta","data":{"deltaContent":"Hello from Copilot"}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Stdout(text) = output else {
            panic!("expected stdout output");
        };
        assert_eq!(text, "Hello from Copilot");
    }

    #[test]
    fn parse_tool_execution_start_emits_structured_status() {
        let executor = CopilotExecutor::new(PathBuf::from("/usr/bin/copilot"));
        let line = r#"{"type":"tool.execution_start","data":{"toolName":"bash","arguments":{"command":"pwd"}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Bash");
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("running")
        );
    }
}
