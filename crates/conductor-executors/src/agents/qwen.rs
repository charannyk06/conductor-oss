use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{spawn_process_no_stdin_with_env_removals, spawn_process_with_env_removals};

const QWEN_ENV_REMOVE_KEYS: &[&str] = &["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE"];

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

    fn runtime_env(&self, options: &SpawnOptions) -> HashMap<String, String> {
        options.env.clone()
    }

    fn runtime_env_removals(&self, options: &SpawnOptions) -> Vec<String> {
        if !options.interactive {
            return Vec::new();
        }

        QWEN_ENV_REMOVE_KEYS
            .iter()
            .map(|key| (*key).to_string())
            .collect()
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

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let env = self.runtime_env(&options);
        let env_remove = self.runtime_env_removals(&options);
        let handle = if options.interactive {
            spawn_process_with_env_removals(&self.binary, &args, &options.cwd, &env, &env_remove)
                .await?
        } else {
            spawn_process_no_stdin_with_env_removals(
                &self.binary,
                &args,
                &options.cwd,
                &env,
                &env_remove,
            )
            .await?
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

    #[test]
    fn interactive_runtime_env_preserves_existing_values() {
        let executor = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen"));
        let env = executor.runtime_env(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "review the workspace".to_string(),
            model: None,
            reasoning_effort: None,
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::from([("EXISTING".to_string(), "1".to_string())]),
            branch: None,
            timeout: None,
            interactive: true,
            structured_output: false,
            resume_target: None,
        });

        assert_eq!(env.get("EXISTING").map(String::as_str), Some("1"));
    }

    #[test]
    fn interactive_runtime_env_removes_force_color_overrides() {
        let executor = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen"));
        let env_remove = executor.runtime_env_removals(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "review the workspace".to_string(),
            model: None,
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

        assert_eq!(
            env_remove,
            vec![
                "NO_COLOR".to_string(),
                "FORCE_COLOR".to_string(),
                "CLICOLOR_FORCE".to_string()
            ]
        );
    }

    #[test]
    fn headless_runtime_env_preserves_existing_color_behavior() {
        let executor = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen"));
        let env = executor.runtime_env(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "generate a plan".to_string(),
            model: None,
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

        assert!(env.is_empty());
    }

    #[test]
    fn headless_runtime_env_keeps_color_overrides_available() {
        let executor = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen"));
        let env_remove = executor.runtime_env_removals(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "generate a plan".to_string(),
            model: None,
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

        assert!(env_remove.is_empty());
    }
}
