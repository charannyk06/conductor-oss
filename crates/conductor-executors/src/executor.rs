use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::iter::Peekable;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;

/// Flags that must never be injected via extra_args because they bypass
/// security controls or grant unrestricted filesystem/shell access.
const BLOCKED_EXTRA_ARGS: &[&str] = &[
    "--dangerously-skip-permissions",
    "--full-auto",
    "--yolo",
    "--no-permissions",
    "--skip-permissions",
    "--trust",
];

/// Options for spawning an executor.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    /// Working directory for the agent.
    pub cwd: PathBuf,

    /// Task prompt/instructions to send.
    pub prompt: String,

    /// Model override.
    pub model: Option<String>,

    /// Reasoning effort override.
    pub reasoning_effort: Option<String>,

    /// Skip permission prompts.
    pub skip_permissions: bool,

    /// Additional CLI arguments.
    pub extra_args: Vec<String>,

    /// Environment variables.
    pub env: HashMap<String, String>,

    /// Branch to work on.
    pub branch: Option<String>,

    /// Maximum session duration. None means no timeout.
    pub timeout: Option<Duration>,

    /// Whether the runtime expects a long-lived interactive session.
    pub interactive: bool,

    /// Native CLI session target to resume instead of launching a fresh session.
    pub resume_target: Option<String>,
}

impl SpawnOptions {
    /// Returns extra_args with dangerous/permission-bypassing flags filtered out.
    pub fn sanitized_extra_args(&self) -> Vec<String> {
        self.extra_args
            .iter()
            .filter(|arg| {
                let lower = arg.to_lowercase();
                !BLOCKED_EXTRA_ARGS.iter().any(|blocked| lower == *blocked)
            })
            .cloned()
            .collect()
    }
}

/// Input sent to a running executor session.
#[derive(Debug, Clone)]
pub enum ExecutorInput {
    /// Send a logical text prompt/line and terminate it.
    Text(String),
    /// Send raw terminal bytes encoded as a string verbatim.
    Raw(String),
}

/// Output from a running executor.
#[derive(Debug, Clone)]
pub enum ExecutorOutput {
    /// Standard output line.
    Stdout(String),
    /// Standard error line.
    Stderr(String),
    /// Structured tool/status event that should render as a runtime status row.
    StructuredStatus {
        text: String,
        metadata: HashMap<String, Value>,
    },
    /// Agent is requesting input.
    NeedsInput(String),
    /// Agent has completed its task.
    Completed { exit_code: i32 },
    /// Agent crashed or was killed.
    Failed {
        error: String,
        exit_code: Option<i32>,
    },
    /// A single transport frame expanded into multiple runtime events.
    Composite(Vec<ExecutorOutput>),
}

/// Handle to a running executor process.
pub struct ExecutorHandle {
    /// Process ID.
    pub pid: u32,

    /// Agent kind.
    pub kind: AgentKind,

    /// Channel to receive output from the agent.
    pub output_rx: mpsc::Receiver<ExecutorOutput>,

    /// Channel to send input to the agent.
    pub input_tx: mpsc::Sender<ExecutorInput>,

    /// Kill handle.
    kill_tx: tokio::sync::oneshot::Sender<()>,
}

impl ExecutorHandle {
    pub fn new(
        pid: u32,
        kind: AgentKind,
        output_rx: mpsc::Receiver<ExecutorOutput>,
        input_tx: mpsc::Sender<ExecutorInput>,
        kill_tx: tokio::sync::oneshot::Sender<()>,
    ) -> Self {
        Self {
            pid,
            kind,
            output_rx,
            input_tx,
            kill_tx,
        }
    }

    /// Send input text to the running agent.
    pub async fn send_input(&self, text: &str) -> Result<()> {
        self.input_tx
            .send(ExecutorInput::Text(text.to_string()))
            .await?;
        Ok(())
    }

    /// Send raw terminal input to the running agent.
    pub async fn send_raw_input(&self, text: &str) -> Result<()> {
        self.input_tx
            .send(ExecutorInput::Raw(text.to_string()))
            .await?;
        Ok(())
    }

    /// Break the handle into parts so the runtime can monitor output separately.
    pub fn into_parts(
        self,
    ) -> (
        u32,
        AgentKind,
        mpsc::Receiver<ExecutorOutput>,
        mpsc::Sender<ExecutorInput>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        (
            self.pid,
            self.kind,
            self.output_rx,
            self.input_tx,
            self.kill_tx,
        )
    }

    /// Kill the running agent process.
    pub fn kill(self) {
        let _ = self.kill_tx.send(());
    }
}

pub fn wrap_parsed_output<E>(
    executor: E,
    mut output_rx: mpsc::Receiver<ExecutorOutput>,
) -> mpsc::Receiver<ExecutorOutput>
where
    E: Executor + Send + Sync + 'static,
{
    let (parsed_output_tx, parsed_output_rx) = mpsc::channel::<ExecutorOutput>(1024);

    tokio::spawn(async move {
        while let Some(event) = output_rx.recv().await {
            let parsed = match event {
                ExecutorOutput::Stdout(line) => {
                    let sanitized = sanitize_terminal_text(&line);
                    executor.parse_output(&sanitized)
                }
                other => other,
            };

            for parsed_event in flatten_parsed_output(parsed) {
                if parsed_output_tx.send(parsed_event).await.is_err() {
                    return;
                }
            }
        }
    });

    parsed_output_rx
}

fn is_filtered_control(ch: char) -> bool {
    ch.is_control() && ch != '\n' && ch != '\t'
}

fn consume_csi<I>(chars: &mut Peekable<I>)
where
    I: Iterator<Item = char>,
{
    for next in chars.by_ref() {
        let code = next as u32;
        if (0x40..=0x7e).contains(&code) {
            break;
        }
    }
}

fn consume_osc<I>(chars: &mut Peekable<I>)
where
    I: Iterator<Item = char>,
{
    let mut previous_was_escape = false;
    for next in chars.by_ref() {
        if next == '\u{0007}' {
            break;
        }
        if previous_was_escape && next == '\\' {
            break;
        }
        previous_was_escape = next == '\u{001b}';
    }
}

fn sanitize_terminal_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\u{001b}' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    consume_csi(&mut chars);
                }
                Some(']') => {
                    chars.next();
                    consume_osc(&mut chars);
                }
                _ => {}
            },
            '\r' => continue,
            _ if is_filtered_control(ch) => continue,
            _ => result.push(ch),
        }
    }

    result
}

fn flatten_parsed_output(event: ExecutorOutput) -> Vec<ExecutorOutput> {
    match event {
        ExecutorOutput::Composite(events) => {
            events.into_iter().flat_map(flatten_parsed_output).collect()
        }
        ExecutorOutput::Stdout(text) if text.trim().is_empty() => Vec::new(),
        other => vec![other],
    }
}

/// Trait for implementing an agent executor.
///
/// Each supported agent CLI implements this trait to handle:
/// - Spawning with the correct flags
/// - Parsing output for state changes
/// - Sending prompts/input
#[async_trait]
pub trait Executor: Send + Sync {
    /// The agent kind this executor handles.
    fn kind(&self) -> AgentKind;

    /// Human-readable name.
    fn name(&self) -> &str;

    /// Path to the CLI binary.
    fn binary_path(&self) -> &Path;

    /// Check if this executor is available (binary exists, correct version).
    async fn is_available(&self) -> bool;

    /// Get the CLI version string.
    async fn version(&self) -> Result<String>;

    /// Spawn the agent with the given options. Returns a handle to interact with it.
    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle>;

    /// Build the CLI arguments for spawning.
    fn build_args(&self, options: &SpawnOptions) -> Vec<String>;

    /// Parse a line of output and classify it.
    fn parse_output(&self, line: &str) -> ExecutorOutput;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct DummyExecutor;

    #[async_trait]
    impl Executor for DummyExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Dummy"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/tmp/dummy")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, _options: SpawnOptions) -> Result<ExecutorHandle> {
            unreachable!("not used in tests")
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            Vec::new()
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            match line {
                "structured" => ExecutorOutput::StructuredStatus {
                    text: "Thinking".to_string(),
                    metadata: HashMap::new(),
                },
                "composite" => ExecutorOutput::Composite(vec![
                    ExecutorOutput::Stdout("first".to_string()),
                    ExecutorOutput::Stdout(String::new()),
                    ExecutorOutput::Stdout("second".to_string()),
                ]),
                _ => ExecutorOutput::Stdout(line.to_string()),
            }
        }
    }

    #[tokio::test]
    async fn wrap_parsed_output_applies_parser_and_flattens_composites() {
        let (raw_tx, raw_rx) = mpsc::channel::<ExecutorOutput>(8);
        let mut parsed_rx = wrap_parsed_output(DummyExecutor, raw_rx);

        raw_tx
            .send(ExecutorOutput::Stdout("structured".to_string()))
            .await
            .unwrap();
        raw_tx
            .send(ExecutorOutput::Stdout("composite".to_string()))
            .await
            .unwrap();
        raw_tx
            .send(ExecutorOutput::Stderr("stderr".to_string()))
            .await
            .unwrap();
        drop(raw_tx);

        let first = parsed_rx.recv().await.unwrap();
        assert!(matches!(first, ExecutorOutput::StructuredStatus { .. }));

        let second = parsed_rx.recv().await.unwrap();
        assert!(matches!(second, ExecutorOutput::Stdout(ref text) if text == "first"));

        let third = parsed_rx.recv().await.unwrap();
        assert!(matches!(third, ExecutorOutput::Stdout(ref text) if text == "second"));

        let fourth = parsed_rx.recv().await.unwrap();
        assert!(matches!(fourth, ExecutorOutput::Stderr(ref text) if text == "stderr"));

        assert!(parsed_rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn wrap_parsed_output_sanitizes_terminal_sequences_before_parsing() {
        let (raw_tx, raw_rx) = mpsc::channel::<ExecutorOutput>(8);
        let mut parsed_rx = wrap_parsed_output(DummyExecutor, raw_rx);

        raw_tx
            .send(ExecutorOutput::Stdout(
                "\u{001b}[90mhello\u{001b}[0m".to_string(),
            ))
            .await
            .unwrap();
        drop(raw_tx);

        let output = parsed_rx.recv().await.unwrap();
        assert!(matches!(output, ExecutorOutput::Stdout(ref text) if text == "hello"));
        assert!(parsed_rx.recv().await.is_none());
    }
}
