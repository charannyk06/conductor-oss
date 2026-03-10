use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{spawn_process, spawn_process_no_stdin};

#[derive(Clone)]
pub struct QwenCodeExecutor {
    binary: PathBuf,
}

impl QwenCodeExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["qwen", "qwen-code"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for QwenCodeExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::QwenCode
    }
    fn name(&self) -> &str {
        "Qwen Code"
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
            let mut args = vec![];
            if options.skip_permissions {
                args.push("--yolo".to_string());
            }
            if let Some(model) = &options.model {
                args.push("--model".to_string());
                args.push(model.clone());
            }
            args.extend(options.sanitized_extra_args());
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
        args.extend(options.sanitized_extra_args());
        args.push("--prompt".to_string());
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        ExecutorOutput::Stdout(line.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn build_args_interactive_uses_prompt_interactive_flag() {
        let executor = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "review the workspace".to_string(),
            model: Some("qwen-max".to_string()),
            reasoning_effort: None,
            skip_permissions: true,
            extra_args: vec!["--safe-extra".to_string(), "--YOLO".to_string()],
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"qwen-max".to_string()));
        assert!(args.contains(&"--yolo".to_string()));
        assert!(args.contains(&"--safe-extra".to_string()));
        assert_eq!(
            args.windows(2)
                .find(|pair| pair[0] == "--prompt-interactive")
                .map(|pair| pair[1].as_str()),
            Some("review the workspace")
        );
        assert_eq!(
            args.iter().filter(|arg| arg.as_str() == "--yolo").count(),
            1
        );
    }

    #[test]
    fn build_args_headless_uses_prompt_flag() {
        let executor = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "generate a plan".to_string(),
            model: Some("qwen-max".to_string()),
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

        assert_eq!(
            args.windows(2)
                .find(|pair| pair[0] == "--prompt")
                .map(|pair| pair[1].as_str()),
            Some("generate a plan")
        );
    }
}
