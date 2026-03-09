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

/// Gemini CLI executor.
#[derive(Clone)]
pub struct GeminiExecutor {
    binary: PathBuf,
}

impl GeminiExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["gemini"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for GeminiExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Gemini
    }

    fn name(&self) -> &str {
        "Gemini"
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
            let mut args = vec![];

            if options.structured_output {
                args.push("--output-format".to_string());
                args.push("stream-json".to_string());
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            if options.skip_permissions {
                args.push("--yolo".to_string());
            }
            if let Some(resume_target) = &options.resume_target {
                args.push("--resume".to_string());
                args.push(resume_target.clone());
                return args;
            }
            if !options.prompt.trim().is_empty() {
                args.push("--prompt-interactive".to_string());
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![];

        if options.skip_permissions {
            args.push("--yolo".to_string());
        }

        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        args.push("--output-format".to_string());
        args.push("stream-json".to_string());

        args.extend(options.sanitized_extra_args());
        args.push("--prompt".to_string());
        args.push(options.prompt.clone());

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed == "Loaded cached credentials."
            || trimmed == "YOLO mode is enabled. All tool calls will be automatically approved."
        {
            return ExecutorOutput::Stdout(String::new());
        }

        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            match value.get("type").and_then(Value::as_str) {
                Some("init") | Some("tool_result") => return ExecutorOutput::Stdout(String::new()),
                Some("message") => {
                    if value.get("role").and_then(Value::as_str) == Some("assistant") {
                        if let Some(text) = value
                            .get("content")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|text| !text.is_empty())
                        {
                            return ExecutorOutput::Stdout(text.to_string());
                        }
                    }
                    return ExecutorOutput::Stdout(String::new());
                }
                Some("tool_use") => {
                    let tool_name = value
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .unwrap_or("tool");
                    return ExecutorOutput::StructuredStatus {
                        text: tool_title(tool_name),
                        metadata: tool_metadata(
                            &normalize_tool_kind(tool_name),
                            &tool_title(tool_name),
                            "running",
                            tool_content(
                                value.get("parameters"),
                                value.get("tool_id").and_then(Value::as_str),
                            ),
                        ),
                    };
                }
                Some("result") => {
                    if value.get("status").and_then(Value::as_str) == Some("success") {
                        return ExecutorOutput::Stdout(String::new());
                    }
                    let error = value
                        .get("error")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("message").and_then(Value::as_str))
                        .or_else(|| value.get("status").and_then(Value::as_str))
                        .map(str::trim)
                        .filter(|message| !message.is_empty())
                        .unwrap_or("Gemini failed")
                        .to_string();
                    return ExecutorOutput::Failed {
                        error,
                        exit_code: Some(1),
                    };
                }
                _ => return ExecutorOutput::Stdout(String::new()),
            }
        }

        ExecutorOutput::Stdout(trimmed.to_string())
    }
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

fn tool_content(parameters: Option<&Value>, tool_id: Option<&str>) -> Vec<String> {
    let mut content = Vec::new();

    if let Some(tool_id) = tool_id.map(str::trim).filter(|tool_id| !tool_id.is_empty()) {
        content.push(format!("id: {tool_id}"));
    }

    let Some(parameters) = parameters else {
        return content;
    };

    for key in [
        "command",
        "dir_path",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "objective",
        "prompt",
    ] {
        if let Some(value) = parameters
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            content.push(value.to_string());
            return content;
        }
    }

    if let Ok(serialized) = serde_json::to_string(parameters) {
        if !serialized.trim().is_empty() && serialized != "{}" {
            content.push(serialized);
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
    fn build_args_requests_stream_json() {
        let executor = GeminiExecutor::new(PathBuf::from("/usr/bin/gemini"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("gemini-3.1-pro-preview".to_string()),
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

        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
    }

    #[test]
    fn build_args_resumes_native_session_without_inline_prompt() {
        let executor = GeminiExecutor::new(PathBuf::from("/usr/bin/gemini"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "continue".to_string(),
            model: Some("gemini-3.1-pro-preview".to_string()),
            reasoning_effort: None,
            skip_permissions: true,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: Some("latest".to_string()),
        });

        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"latest".to_string()));
        assert!(args.contains(&"--yolo".to_string()));
        assert!(!args.contains(&"--prompt-interactive".to_string()));
    }

    #[test]
    fn parse_tool_use_emits_structured_status() {
        let executor = GeminiExecutor::new(PathBuf::from("/usr/bin/gemini"));
        let line = r#"{"type":"tool_use","tool_name":"list_directory","tool_id":"list_directory_1","parameters":{"dir_path":"."}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };

        assert_eq!(text, "List Directory");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("list_directory")
        );
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("running")
        );
    }

    #[test]
    fn parse_assistant_message_emits_stdout() {
        let executor = GeminiExecutor::new(PathBuf::from("/usr/bin/gemini"));
        let line = r#"{"type":"message","role":"assistant","content":"done","delta":true}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::Stdout(text) = output else {
            panic!("expected stdout");
        };

        assert_eq!(text, "done");
    }
}
