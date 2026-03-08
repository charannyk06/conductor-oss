use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
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
        let output = Command::new(&self.binary)
            .arg("--version")
            .output()
            .await?;
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

        args.extend(options.extra_args.clone());

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
                    "agent_message_delta" | "thread.started" | "turn.started" | "turn.completed" | "task.started" => {
                        return ExecutorOutput::Stdout(String::new());
                    }
                    "item.started" => {
                        if let Some(item) = value.get("item") {
                            if item.get("type").and_then(|v| v.as_str()) == Some("command_execution") {
                                if let Some(command) = item.get("command").and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()) {
                                    return ExecutorOutput::Stdout(command.to_string());
                                }
                            }
                            if item.get("type").and_then(|v| v.as_str()) == Some("reasoning") {
                                return ExecutorOutput::Stdout("Thinking".to_string());
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
                                Some("command_execution") => return ExecutorOutput::Stdout(String::new()),
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

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()) {
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
