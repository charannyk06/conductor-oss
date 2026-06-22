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

/// Cursor CLI uses its own model namespace. Map generic model names from
/// Kanban card metadata to Cursor-accepted identifiers. Returns `None` for
/// unrecognized names so the agent falls back to `auto` (its default).
fn normalize_cursor_model(model: Option<&str>) -> Option<String> {
    let value = model.map(str::trim).filter(|v| !v.is_empty())?;
    let normalized = value.to_ascii_lowercase();
    match normalized.as_str() {
        "auto" => Some("auto".to_string()),
        // Preserve older saved Cursor aliases by remapping them onto the
        // current GPT-5 preset family that the CLI still accepts.
        "gpt-5.3-codex" => Some("gpt-5".to_string()),
        "gpt-5.3-codex-fast" => Some("gpt-5-fast".to_string()),
        "gpt-5.3-codex-high" => Some("gpt-5-high".to_string()),
        "opus" => Some("opus-4.1".to_string()),
        // Cursor-native names and runtime-discovered model ids pass through.
        s if s.starts_with("gpt-")
            || s.starts_with("composer-")
            || s.starts_with("sonnet-")
            || s.starts_with("opus")
            || s.starts_with("claude-")
            || s.starts_with("gemini-")
            || s.starts_with("grok-")
            || s.starts_with("kimi-")
            || s.starts_with("qwen-") =>
        {
            Some(value.to_string())
        }
        // Unrecognized model: let Cursor pick its default
        _ => None,
    }
}

#[derive(Clone)]
pub struct CursorExecutor {
    binary: PathBuf,
}

impl CursorExecutor {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub fn discover() -> Option<Self> {
        // Prefer the dedicated agent binary over the Cursor IDE shim. The
        // `cursor` launcher can exist without a usable agent runtime.
        discover_binary(&["cursor-agent", "cursor-cli", "cursor"]).map(Self::new)
    }
}

#[async_trait]
impl Executor for CursorExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::CursorCli
    }
    fn name(&self) -> &str {
        "Cursor CLI"
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
        let mut args = cursor_wrapper_prefix_args(&self.binary);

        if options.interactive {
            if options.structured_output {
                args.push("--output-format".to_string());
                args.push("stream-json".to_string());
            }

            if options.skip_permissions {
                args.push("--force".to_string());
            }

            if let Some(model) = normalize_cursor_model(options.model.as_deref()) {
                args.push("--model".to_string());
                args.push(model);
            }

            args.extend(options.sanitized_extra_args());

            if !options.prompt.trim().is_empty() {
                args.push(options.prompt.clone());
            }
            return args;
        }

        args.extend([
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
        ]);
        if let Some(model) = normalize_cursor_model(options.model.as_deref()) {
            args.push("--model".to_string());
            args.push(model);
        }
        if options.skip_permissions {
            args.push("--force".to_string());
        }
        args.extend(options.sanitized_extra_args());
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() || is_cursor_terminal_art(trimmed) {
            return ExecutorOutput::Stdout(String::new());
        }

        if is_cursor_auth_prompt(trimmed) {
            return ExecutorOutput::NeedsInput(
                "Cursor login required. Run `cursor-agent login` and retry the session."
                    .to_string(),
            );
        }

        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            return ExecutorOutput::Stdout(trimmed.to_string());
        };

        match value.get("type").and_then(Value::as_str) {
            Some("system") => ExecutorOutput::Composite(Vec::new()),
            Some("assistant") => ExecutorOutput::Composite(extract_cursor_assistant_events(&value)),
            Some("tool_call") => {
                let subtype = value
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("started");
                let tool_call = value.get("tool_call").unwrap_or(&Value::Null);
                let tool_name = tool_call
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("name").and_then(Value::as_str))
                    .unwrap_or("tool");
                let status = match subtype {
                    "completed" | "complete" | "done" => "completed",
                    "failed" | "error" => "failed",
                    _ => "running",
                };
                ExecutorOutput::StructuredStatus {
                    text: title_case(tool_name),
                    metadata: tool_metadata(
                        tool_name,
                        &title_case(tool_name),
                        status,
                        tool_content_summary(tool_call.get("arguments")),
                    ),
                }
            }
            Some("result") => {
                let subtype = value
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("success");
                if subtype.eq_ignore_ascii_case("success") {
                    ExecutorOutput::Completed { exit_code: 0 }
                } else {
                    let error = value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("Cursor Agent failed")
                        .to_string();
                    ExecutorOutput::Failed {
                        error,
                        exit_code: Some(1),
                    }
                }
            }
            Some("error") => ExecutorOutput::Failed {
                error: value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Cursor Agent failed")
                    .to_string(),
                exit_code: Some(1),
            },
            _ => ExecutorOutput::Stdout(String::new()),
        }
    }
}

fn cursor_wrapper_prefix_args(binary: &Path) -> Vec<String> {
    if is_cursor_wrapper_binary(binary) {
        vec!["agent".to_string()]
    } else {
        Vec::new()
    }
}

fn is_cursor_wrapper_binary(binary: &Path) -> bool {
    binary
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cursor"))
}

fn is_cursor_auth_prompt(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("press any key to sign in")
        || lower.contains("authentication required to use cursor agent")
}

fn is_cursor_terminal_art(line: &str) -> bool {
    line.contains("Cursor Agent")
        || line.chars().all(|ch| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '+' | ':'
                        | ';'
                        | ','
                        | '"'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '?'
                        | '_'
                        | '~'
                        | '<'
                        | '>'
                        | '\\'
                        | '/'
                        | '|'
                        | '('
                        | ')'
                        | '#'
                        | '*'
                        | '↗'
                        | '…'
                        | '^'
                        | '-'
                        | '='
                )
                || ch.is_ascii_digit()
        })
}

fn extract_cursor_assistant_events(value: &Value) -> Vec<ExecutorOutput> {
    let mut events = Vec::new();
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return events;
    };

    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(text) = block
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            events.push(ExecutorOutput::Stdout(text.to_string()));
        }
    }

    events
}

fn title_case(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn tool_content_summary(arguments: Option<&Value>) -> Vec<String> {
    let Some(arguments) = arguments else {
        return Vec::new();
    };

    for key in ["command", "path", "file_path", "query", "url", "prompt"] {
        if let Some(value) = arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return vec![value.to_string()];
        }
    }

    serde_json::to_string(arguments)
        .ok()
        .filter(|value| !value.trim().is_empty() && value != "{}")
        .map(|value| vec![value])
        .unwrap_or_default()
}

fn tool_metadata(
    tool_kind: &str,
    tool_title: &str,
    tool_status: &str,
    tool_content: Vec<String>,
) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert("toolKind".to_string(), Value::String(tool_kind.to_string()));
    metadata.insert(
        "toolTitle".to_string(),
        Value::String(tool_title.to_string()),
    );
    metadata.insert(
        "toolStatus".to_string(),
        Value::String(tool_status.to_string()),
    );
    metadata.insert(
        "toolContent".to_string(),
        Value::Array(tool_content.into_iter().map(Value::String).collect()),
    );
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_requests_print_stream_json() {
        let executor = CursorExecutor::new(PathBuf::from("/usr/bin/cursor-agent"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("gpt-5".to_string()),
            reasoning_effort: None,
            skip_permissions: true,
            extra_args: Vec::new(),
            env: HashMap::new(),
            branch: None,
            timeout: None,
            interactive: false,
            structured_output: false,
            resume_target: None,
        });

        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--force".to_string()));
        assert!(args.contains(&"gpt-5".to_string()));
    }

    #[test]
    fn build_args_drops_unrecognized_model() {
        let executor = CursorExecutor::new(PathBuf::from("/usr/bin/cursor-agent"));
        let args = executor.build_args(&SpawnOptions {
            cwd: PathBuf::from("/tmp/demo"),
            prompt: "hello".to_string(),
            model: Some("not-a-cursor-model".to_string()),
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

        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"not-a-cursor-model".to_string()));
    }

    #[test]
    fn normalize_cursor_model_maps_common_names() {
        assert_eq!(
            normalize_cursor_model(Some("gpt-5")),
            Some("gpt-5".to_string())
        );
        assert_eq!(
            normalize_cursor_model(Some("auto")),
            Some("auto".to_string())
        );
        assert_eq!(
            normalize_cursor_model(Some("gpt-5.3-codex-high")),
            Some("gpt-5-high".to_string())
        );
        assert_eq!(
            normalize_cursor_model(Some("sonnet-4")),
            Some("sonnet-4".to_string())
        );
        assert_eq!(
            normalize_cursor_model(Some("opus")),
            Some("opus-4.1".to_string())
        );
        assert_eq!(normalize_cursor_model(Some("openai/gpt-5")), None);
        assert_eq!(normalize_cursor_model(None), None);
    }

    #[test]
    fn parse_tool_call_started_emits_structured_status() {
        let executor = CursorExecutor::new(PathBuf::from("/usr/bin/cursor-agent"));
        let line = r#"{"type":"tool_call","subtype":"started","tool_call":{"name":"bash","arguments":{"command":"pwd"}}}"#;

        let output = executor.parse_output(line);
        let ExecutorOutput::StructuredStatus { text, metadata } = output else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Bash");
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("running")
        );
    }
}
