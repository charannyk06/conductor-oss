use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{spawn_process, spawn_process_no_stdin};

/// Letta Code CLI — memory-first terminal agent (`npm i -g @letta-ai/letta-code`).
#[derive(Clone)]
pub struct LettaExecutor {
    binary: PathBuf,
}

impl LettaExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["letta", "letta-code"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for LettaExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Letta
    }

    fn name(&self) -> &str {
        "Letta Code"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("--version").output().await?;
        let text = String::from_utf8_lossy(&output.stdout);
        let alt = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{text}{alt}").trim().to_string();
        Ok(combined)
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

    /// Letta reads the first task after the PTY attaches; `-p` forces headless mode.
    fn accepts_prompt_on_launch_when_interactive(&self) -> bool {
        false
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

            if let Some(model) = options
                .model
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
            {
                args.push("--model".to_string());
                args.push(model.to_string());
            }

            if let Some(id) = options
                .resume_target
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                args.push("--conversation".to_string());
                args.push(id.to_string());
            }

            args.extend(options.sanitized_extra_args());
            return args;
        }

        let mut args = Vec::new();

        if let Some(model) = options
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            args.push("--model".to_string());
            args.push(model.to_string());
        }

        args.push("-p".to_string());
        args.push(options.prompt.clone());

        if let Some(id) = options
            .resume_target
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            args.push("--conversation".to_string());
            args.push(id.to_string());
        }

        args.extend(options.sanitized_extra_args());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            ExecutorOutput::Stdout(String::new())
        } else {
            ExecutorOutput::Stdout(trimmed.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::Duration;

    #[test]
    fn headless_invokes_prompt_flag() {
        let executor = LettaExecutor::new(PathBuf::from("/usr/bin/letta"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("."),
            prompt: "Ship the feature".to_string(),
            model: Some("sonnet".to_string()),
            reasoning_effort: None,
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: Some(Duration::from_secs(1)),
            interactive: false,
            structured_output: false,
            resume_target: Some("conv-1".to_string()),
        });

        assert!(args
            .windows(2)
            .any(|w| w[0] == "-p" && w[1] == "Ship the feature"));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"sonnet".to_string()));
        assert!(args.contains(&"--conversation".to_string()));
        assert!(args.contains(&"conv-1".to_string()));
    }

    #[test]
    fn interactive_skips_prompt_argv() {
        let executor = LettaExecutor::new(PathBuf::from("/usr/bin/letta"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("."),
            prompt: "Ignored on argv".to_string(),
            model: Some("gpt-5-codex".to_string()),
            reasoning_effort: None,
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: None,
        });

        assert!(!args.contains(&"-p".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"gpt-5-codex".to_string()));
    }
}
