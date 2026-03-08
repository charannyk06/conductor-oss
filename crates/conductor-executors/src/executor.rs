use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
