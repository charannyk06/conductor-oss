use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::discover_binary;
use crate::executor::{wrap_parsed_output, Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::{spawn_process, spawn_process_no_stdin};

const HERMES_SETUP_PROMPT: &str =
    "Hermes isn't configured yet. Run `hermes setup` or `hermes model`, then retry.";

#[derive(Clone)]
pub struct HermesExecutor {
    binary: PathBuf,
}

impl HermesExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        discover_binary(&["hermes", "hermes-agent"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for HermesExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Hermes
    }

    fn name(&self) -> &str {
        "Hermes"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        self.binary.exists()
    }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("version").output().await?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !version.is_empty() {
            return Ok(version);
        }

        let fallback = Command::new(&self.binary).arg("--version").output().await?;
        Ok(String::from_utf8_lossy(&fallback.stdout).trim().to_string())
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }

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
        let mut args = vec!["chat".to_string()];

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
        }

        args.extend(options.sanitized_extra_args());

        if options.interactive {
            // Hermes interactive chat reads the first task from stdin after the
            // terminal attaches instead of accepting it as an argv prompt.
            return args;
        }

        args.push("-Q".to_string());
        args.push("-q".to_string());
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return ExecutorOutput::Stdout(String::new());
        }

        if let Some(session_id) = trimmed.strip_prefix("session_id:") {
            let session_id = session_id.trim();
            if !session_id.is_empty() {
                return ExecutorOutput::StructuredStatus {
                    text: String::new(),
                    metadata: native_resume_target_metadata(session_id),
                };
            }
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("hermes isn't configured yet")
            || lower.contains("no api keys or providers found")
            || lower.contains("run:  hermes setup")
            || lower.contains("run `hermes setup`")
        {
            return ExecutorOutput::NeedsInput(HERMES_SETUP_PROMPT.to_string());
        }

        if trimmed.starts_with("Session not found:")
            || trimmed == "No previous CLI session found to continue."
        {
            return ExecutorOutput::Failed {
                error: trimmed.to_string(),
                exit_code: Some(1),
            };
        }

        ExecutorOutput::Stdout(trimmed.to_string())
    }
}

fn native_resume_target_metadata(session_id: &str) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert(
        "eventKind".to_string(),
        Value::String("native_resume_target".to_string()),
    );
    metadata.insert(
        "nativeResumeTarget".to_string(),
        Value::String(session_id.to_string()),
    );
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_headless_uses_quiet_query_mode() {
        let executor = HermesExecutor::new(PathBuf::from("/usr/bin/hermes"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "review the codebase".to_string(),
            model: Some("nous-hermes".to_string()),
            reasoning_effort: Some("high".to_string()),
            skip_permissions: true,
            extra_args: vec!["--safe-extra".to_string(), "--YOLO".to_string()],
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert_eq!(
            args,
            vec![
                "chat",
                "--model",
                "nous-hermes",
                "--yolo",
                "--safe-extra",
                "-Q",
                "-q",
                "review the codebase",
            ]
        );
    }

    #[test]
    fn build_args_resume_places_resume_before_query() {
        let executor = HermesExecutor::new(PathBuf::from("/usr/bin/hermes"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "continue".to_string(),
            model: None,
            reasoning_effort: None,
            skip_permissions: false,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: Some("session-123".to_string()),
        });

        assert_eq!(
            args,
            vec!["chat", "--resume", "session-123", "-Q", "-q", "continue"]
        );
    }

    #[test]
    fn parse_output_extracts_session_id_for_resume() {
        let executor = HermesExecutor::new(PathBuf::from("/usr/bin/hermes"));
        let output = executor.parse_output("session_id: session-123");
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "");
        assert_eq!(
            metadata.get("nativeResumeTarget").and_then(Value::as_str),
            Some("session-123")
        );
    }

    #[test]
    fn parse_output_detects_setup_requirement() {
        let executor = HermesExecutor::new(PathBuf::from("/usr/bin/hermes"));
        let output = executor.parse_output(
            "It looks like Hermes isn't configured yet -- no API keys or providers found.",
        );
        let ExecutorOutput::NeedsInput(prompt) = output else {
            panic!("expected setup prompt");
        };
        assert!(prompt.contains("hermes setup"));
    }
}
