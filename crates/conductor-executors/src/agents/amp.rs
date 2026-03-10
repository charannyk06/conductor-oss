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
pub struct AmpExecutor {
    binary: PathBuf,
}

impl AmpExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["amp"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for AmpExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Amp
    }
    fn name(&self) -> &str {
        "Amp"
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
            let mut args = Vec::new();

            if options.structured_output {
                args.push("--stream-json".to_string());
                args.push("--stream-json-thinking".to_string());
            }

            if options.skip_permissions {
                args.push("--dangerously-allow-all".to_string());
            }

            if let Some(mode) = normalize_amp_mode(options.model.as_deref()) {
                args.push("--mode".to_string());
                args.push(mode.to_string());
            }

            args.extend(options.sanitized_extra_args());

            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        let mut args = vec![
            "-x".to_string(),
            "--stream-json".to_string(),
            "--stream-json-thinking".to_string(),
        ];
        if options.skip_permissions {
            args.push("--dangerously-allow-all".to_string());
        }
        if let Some(mode) = normalize_amp_mode(options.model.as_deref()) {
            args.push("--mode".to_string());
            args.push(mode.to_string());
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

        if is_amp_login_prompt(trimmed) {
            return ExecutorOutput::NeedsInput(
                "Amp login required. Run `amp login` or finish the browser sign-in flow."
                    .to_string(),
            );
        }

        parse_claude_stream_json_output(trimmed, "Amp failed")
    }
}

fn normalize_amp_mode(model: Option<&str>) -> Option<&'static str> {
    match model?.trim().to_ascii_lowercase().as_str() {
        "deep" => Some("deep"),
        "free" => Some("free"),
        "rush" => Some("rush"),
        "smart" => Some("smart"),
        _ => None,
    }
}

fn is_amp_login_prompt(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("no api key found")
        || lower.contains("starting login flow")
        || lower.contains("ampcode.com/auth/cli-login")
        || lower.contains("paste your code here")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_login_prompt_requests_input() {
        let executor = AmpExecutor::new(PathBuf::from("/usr/bin/amp"));
        let output = executor.parse_output("No API key found. Starting login flow...");
        let ExecutorOutput::NeedsInput(prompt) = output else {
            panic!("expected needs-input output");
        };
        assert!(prompt.contains("amp login"));
    }
}
