use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::claude_code::parse_claude_stream_json_output;
use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{spawn_process, spawn_process_no_stdin};

#[derive(Clone)]
pub struct CcrExecutor {
    binary: PathBuf,
}

impl CcrExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["ccr"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for CcrExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Ccr
    }

    fn name(&self) -> &str {
        "Claude Code Router"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("version").output().await?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
        ))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        if options.interactive {
            let mut args = vec!["code".to_string()];

            if options.structured_output {
                args.push("--print".to_string());
                args.push("--output-format".to_string());
                args.push("stream-json".to_string());
                args.push("--include-partial-messages".to_string());
                args.push("--verbose".to_string());
            }

            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            if let Some(reasoning_effort) = &options.reasoning_effort {
                args.push("--effort".to_string());
                args.push(reasoning_effort.clone());
            }
            if options.skip_permissions {
                args.push("--dangerously-skip-permissions".to_string());
            }
            args.extend(options.sanitized_extra_args());
            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "code".to_string(),
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

        args.extend(options.sanitized_extra_args());
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("missing model in request body") {
            return ExecutorOutput::NeedsInput(
                "CCR is installed but not configured with a routed model. Run `ccr model` or configure ~/.claude-code-router/config.json, then retry."
                    .to_string(),
            );
        }
        if lower.starts_with("api error:") {
            return ExecutorOutput::Failed {
                error: trimmed.to_string(),
                exit_code: Some(1),
            };
        }

        parse_claude_stream_json_output(trimmed, "Claude Code Router failed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_missing_model_error_requests_input() {
        let executor = CcrExecutor::new(PathBuf::from("/usr/bin/ccr"));
        let output =
            executor.parse_output(r#"API Error: 400 {"error":"Missing model in request body"}"#);
        let ExecutorOutput::NeedsInput(prompt) = output else {
            panic!("expected needs-input output");
        };
        assert!(prompt.contains("ccr model"));
    }
}
