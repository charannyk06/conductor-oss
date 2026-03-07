use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::executor::{Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::spawn_process;

/// Claude Code CLI executor.
pub struct ClaudeCodeExecutor {
    binary: PathBuf,
}

impl ClaudeCodeExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    /// Try to find claude in PATH.
    pub fn discover() -> Option<Self> {
        which::which("claude").ok().map(|p| Self::new(p))
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
        let output = Command::new(&self.binary)
            .arg("--version")
            .output()
            .await?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
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
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
        ];

        if options.skip_permissions {
            args.push("--dangerously-skip-permissions".to_string());
        }

        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        // Add extra args.
        args.extend(options.extra_args.clone());

        // Add the prompt as the final argument.
        args.push(options.prompt.clone());

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        // Try to parse as JSON (stream-json format).
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(msg_type) = value.get("type").and_then(|t| t.as_str()) {
                match msg_type {
                    "assistant" => {
                        if let Some(content) = value.get("content").and_then(|c| c.as_str()) {
                            return ExecutorOutput::Stdout(content.to_string());
                        }
                    }
                    "tool_use" => {
                        let tool = value.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                        return ExecutorOutput::Stdout(format!("[tool: {tool}]"));
                    }
                    "result" => {
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
                    _ => {}
                }
            }
        }

        // Fallback: treat as plain stdout.
        ExecutorOutput::Stdout(line.to_string())
    }
}
