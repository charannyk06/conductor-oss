use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
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
        which::which("codex").ok().map(|p| Self::new(p))
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
        let mut args = vec![];

        if options.skip_permissions {
            args.push("--full-auto".to_string());
        }

        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        args.extend(options.extra_args.clone());

        // Codex takes prompt as positional argument.
        args.push(options.prompt.clone());

        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        // Codex outputs JSON-RPC messages.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
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
                    "done" => {
                        return ExecutorOutput::Completed { exit_code: 0 };
                    }
                    _ => {}
                }
            }
        }

        ExecutorOutput::Stdout(line.to_string())
    }
}
