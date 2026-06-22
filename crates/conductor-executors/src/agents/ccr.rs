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

fn normalize_ccr_model(model: Option<&str>) -> Option<String> {
    let value = model.map(str::trim).filter(|value| !value.is_empty())?;
    let normalized = value.to_ascii_lowercase();
    match normalized.as_str() {
        "sonnet" | "sonnet-4" | "claude-sonnet-4" => Some("claude-sonnet-4-6".to_string()),
        "opus" | "opus-4" | "claude-opus-4" => Some("claude-opus-4-6".to_string()),
        "haiku" | "haiku-4" | "haiku-4-5" | "claude-haiku-4" => {
            Some("claude-haiku-4-5".to_string())
        }
        model if model.starts_with("claude-") => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_ccr_reasoning_effort(reasoning_effort: Option<&str>) -> Option<String> {
    let value = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_ascii_lowercase();
    let normalized = match value.as_str() {
        "minimal" | "min" | "off" | "none" | "low" => "low",
        "medium" | "med" => "medium",
        "high" => "high",
        "max" | "xhigh" | "extra-high" | "extra_high" | "extra high" => "max",
        _ => return None,
    };
    Some(normalized.to_string())
}

fn push_ccr_model_arg(args: &mut Vec<String>, model: Option<&str>) {
    if let Some(model) = normalize_ccr_model(model) {
        args.push("--model".to_string());
        args.push(model);
    }
}

fn push_ccr_reasoning_arg(args: &mut Vec<String>, reasoning_effort: Option<&str>) {
    if let Some(reasoning_effort) = normalize_ccr_reasoning_effort(reasoning_effort) {
        args.push("--effort".to_string());
        args.push(reasoning_effort);
    }
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

    fn supports_direct_terminal_ui(&self) -> bool {
        true
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
            let mut args = vec!["code".to_string()];

            if options.structured_output {
                args.push("--print".to_string());
                args.push("--output-format".to_string());
                args.push("stream-json".to_string());
                args.push("--include-partial-messages".to_string());
                args.push("--verbose".to_string());
            }

            push_ccr_model_arg(&mut args, options.model.as_deref());
            push_ccr_reasoning_arg(&mut args, options.reasoning_effort.as_deref());
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

        push_ccr_model_arg(&mut args, options.model.as_deref());
        push_ccr_reasoning_arg(&mut args, options.reasoning_effort.as_deref());

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

    #[test]
    fn build_args_normalizes_claude_aliases_for_ccr() {
        let executor = CcrExecutor::new(PathBuf::from("/usr/bin/ccr"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("haiku".to_string()),
            reasoning_effort: Some("max".to_string()),
            skip_permissions: false,
            extra_args: Vec::new(),
            env: std::collections::HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.contains(&"claude-haiku-4-5".to_string()));
        assert!(args.contains(&"max".to_string()));
        assert!(!args.contains(&"xhigh".to_string()));
    }
}
