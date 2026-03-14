use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex as StdMutex};
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio::sync::{mpsc, oneshot};

#[cfg(unix)]
use portable_pty::MasterPty;

pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
pub(crate) const RUNTIME_MODE_METADATA_KEY: &str = "runtimeMode";
pub(crate) const DETACHED_CONTROL_SOCKET_METADATA_KEY: &str = "detachedControlSocket";
pub(crate) const DETACHED_STREAM_SOCKET_METADATA_KEY: &str = "detachedStreamSocket";
pub(crate) const DETACHED_CONTROL_TOKEN_METADATA_KEY: &str = "detachedControlToken";
pub(crate) const DETACHED_LOG_PATH_METADATA_KEY: &str = "detachedLogPath";
pub(crate) const DETACHED_EXIT_PATH_METADATA_KEY: &str = "detachedExitPath";
pub(crate) const DETACHED_PROTOCOL_VERSION_METADATA_KEY: &str = "detachedProtocolVersion";
pub(crate) const DETACHED_TRANSPORT_METADATA_KEY: &str = "detachedTransport";
pub(crate) const DETACHED_EMULATOR_METADATA_KEY: &str = "detachedTerminalEmulator";
pub(crate) const DETACHED_BACKPRESSURE_METADATA_KEY: &str = "detachedBackpressure";
pub(crate) const DETACHED_BATCH_INTERVAL_METADATA_KEY: &str = "detachedBatchIntervalMs";
pub(crate) const DETACHED_BATCH_BYTES_METADATA_KEY: &str = "detachedBatchBytes";
pub(crate) const DETACHED_ISOLATION_METADATA_KEY: &str = "detachedIsolation";
pub(crate) const DETACHED_OUTPUT_OFFSET_METADATA_KEY: &str = "detachedOutputOffset";
pub(super) const TERMINAL_DAEMON_CONTROL_SOCKET_ENV: &str =
    "CONDUCTOR_TERMINAL_DAEMON_CONTROL_SOCKET";
pub(super) const TERMINAL_DAEMON_TOKEN_ENV: &str = "CONDUCTOR_TERMINAL_DAEMON_TOKEN";
pub(super) const TERMINAL_DAEMON_PROTOCOL_VERSION_ENV: &str =
    "CONDUCTOR_TERMINAL_DAEMON_PROTOCOL_VERSION";
pub(super) const DETACHED_READY_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const DETACHED_LOG_WATCH_FALLBACK_INTERVAL: Duration = Duration::from_millis(250);
pub(super) const DETACHED_EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const DETACHED_STREAM_RECONNECT_INTERVAL: Duration = Duration::from_millis(50);
pub(super) const DETACHED_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(32);
pub(super) const DETACHED_STREAM_MAX_BATCH_BYTES: usize = 128 * 1024;
pub(super) const DETACHED_STREAM_CHANNEL_CAPACITY: usize = 256;
pub(super) const DETACHED_CAPTURE_CHANNEL_CAPACITY: usize = 256;
pub(super) const DETACHED_CAPTURE_BUFFER_CAPACITY: usize = 64 * 1024;
pub(super) const DETACHED_CAPTURE_FLUSH_INTERVAL: Duration = Duration::from_millis(250);
pub(super) const DETACHED_CAPTURE_FORCE_FLUSH_BYTES: usize = 16 * 1024;
pub(super) const DETACHED_INPUT_BATCH_MAX_ITEMS: usize = 32;
pub(super) const DETACHED_INPUT_BATCH_MAX_BYTES: usize = 16 * 1024;
pub(super) const DETACHED_SOCKET_ROOT: &str = "/tmp/conductor-pty";
pub(super) const DETACHED_PTY_PROTOCOL_VERSION: u16 = 1;
pub(super) const DETACHED_PTY_TRANSPORT: &str = "dual_socket_control_json_stream_binary_v1";
pub(super) const DETACHED_PTY_TERMINAL_EMULATOR: &str = "vt100_restore_v1";
pub(super) const DETACHED_PTY_BACKPRESSURE_MODE: &str = "bounded_channel_pause_pty_read_v2";
pub(super) const DETACHED_PTY_ISOLATION_MODE: &str = "portable_pty_subprocess_v1";

pub(super) fn detached_protocol_version() -> u16 {
    DETACHED_PTY_PROTOCOL_VERSION
}

pub(super) fn detached_stream_flush_interval_ms() -> u64 {
    DETACHED_STREAM_FLUSH_INTERVAL.as_millis() as u64
}

pub(super) fn detached_stream_max_batch_bytes() -> usize {
    DETACHED_STREAM_MAX_BATCH_BYTES
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostSpec {
    #[serde(default = "detached_protocol_version")]
    pub protocol_version: u16,
    pub token: String,
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub control_socket_path: PathBuf,
    pub stream_socket_path: PathBuf,
    pub log_path: PathBuf,
    pub exit_path: PathBuf,
    pub ready_path: PathBuf,
    #[serde(default = "detached_stream_flush_interval_ms")]
    pub stream_flush_interval_ms: u64,
    #[serde(default = "detached_stream_max_batch_bytes")]
    pub stream_max_batch_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostReady {
    #[serde(default = "detached_protocol_version")]
    pub protocol_version: u16,
    pub host_pid: u32,
    pub child_pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DetachedPtyHostCommand {
    Ping,
    Text { text: String },
    Raw { data: String },
    Resize { cols: u16, rows: u16 },
    Kill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostRequest {
    #[serde(default = "detached_protocol_version")]
    pub protocol_version: u16,
    pub token: String,
    #[serde(flatten)]
    pub command: DetachedPtyHostCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostResponse {
    #[serde(default = "detached_protocol_version")]
    pub protocol_version: u16,
    pub ok: bool,
    pub child_pid: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DetachedPtyHostStreamRequest {
    #[serde(default = "detached_protocol_version")]
    pub(super) protocol_version: u16,
    pub(super) token: String,
    pub(super) offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DetachedPtyHostStreamResponse {
    #[serde(default = "detached_protocol_version")]
    pub(super) protocol_version: u16,
    pub(super) ok: bool,
    pub(super) child_pid: Option<u32>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub(super) enum TerminalDaemonRequest {
    Ping {
        protocol_version: u16,
        token: String,
    },
    SpawnHost {
        protocol_version: u16,
        token: String,
        session_id: String,
        spec_path: PathBuf,
        ready_path: PathBuf,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalDaemonResponse {
    #[serde(default = "detached_protocol_version")]
    pub(super) protocol_version: u16,
    pub(super) ok: bool,
    pub(super) daemon_pid: Option<u32>,
    pub(super) host_pid: Option<u32>,
    pub(super) child_pid: Option<u32>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct TerminalDaemonMetadata {
    pub(super) control_socket_path: PathBuf,
    pub(super) token: String,
    pub(super) protocol_version: u16,
}

#[derive(Debug, Clone)]
pub(super) struct DetachedRuntimeMetadata {
    pub(super) protocol_version: u16,
    pub(super) host_pid: u32,
    pub(super) control_socket_path: PathBuf,
    pub(super) stream_socket_path: Option<PathBuf>,
    pub(super) control_token: String,
    pub(super) log_path: PathBuf,
    pub(super) exit_path: PathBuf,
}

pub(super) struct DetachedRuntimeAttachment {
    pub(super) kind: conductor_core::types::AgentKind,
    pub(super) session_id: String,
    pub(super) child_pid: u32,
    pub(super) metadata: DetachedRuntimeMetadata,
    pub(super) start_offset: u64,
}

pub(super) struct DetachedOutputForwarder {
    pub(super) session_id: String,
    pub(super) metadata: DetachedRuntimeMetadata,
    pub(super) offset: u64,
}

#[derive(Clone)]
pub(super) struct DetachedPtyOutputChunk {
    pub(super) offset: u64,
    pub(super) bytes: Arc<[u8]>,
}

pub(super) enum DetachedPtyHostCaptureMessage {
    Data(DetachedPtyOutputChunk),
    Flush { ack: oneshot::Sender<()> },
    Shutdown,
}

pub(super) enum DetachedPtyHostStreamMessage {
    Data(DetachedPtyOutputChunk),
    Exit { offset: u64, exit_code: i32 },
    Error { offset: u64, message: String },
}

pub(super) struct DetachedHostStreamSlot {
    pub(super) generation: u64,
    pub(super) tx: mpsc::Sender<DetachedPtyHostStreamMessage>,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
pub(super) struct DetachedStreamBatchConfig {
    pub(super) flush_interval: Duration,
    pub(super) max_batch_bytes: usize,
}

#[cfg(unix)]
pub(super) struct DetachedHostState {
    pub(super) protocol_version: u16,
    pub(super) token: String,
    pub(super) child_pid: u32,
    pub(super) writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    pub(super) master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    pub(super) child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    pub(super) capture_tx: mpsc::Sender<DetachedPtyHostCaptureMessage>,
    pub(super) stream_slot: Arc<StdMutex<Option<DetachedHostStreamSlot>>>,
    pub(super) stream_generation: AtomicU64,
    pub(super) log_offset: AtomicU64,
    pub(super) log_path: PathBuf,
    pub(super) stream_batch: DetachedStreamBatchConfig,
}
