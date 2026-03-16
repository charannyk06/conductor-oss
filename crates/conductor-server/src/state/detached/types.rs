use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::state::types::TerminalRestoreSnapshot;

pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
pub(crate) const RUNTIME_MODE_METADATA_KEY: &str = "runtimeMode";
pub(crate) const DETACHED_CONTROL_SOCKET_METADATA_KEY: &str = "detachedControlSocket";
pub(crate) const DETACHED_STREAM_SOCKET_METADATA_KEY: &str = "detachedStreamSocket";
pub(crate) const DETACHED_CONTROL_TOKEN_METADATA_KEY: &str = "detachedControlToken";
pub(crate) const DETACHED_LOG_PATH_METADATA_KEY: &str = "detachedLogPath";
pub(crate) const DETACHED_CHECKPOINT_PATH_METADATA_KEY: &str = "detachedCheckpointPath";
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
pub(super) const DETACHED_INPUT_BATCH_MAX_ITEMS: usize = 32;
pub(super) const DETACHED_INPUT_BATCH_MAX_BYTES: usize = 16 * 1024;
/// Returns the root directory for detached PTY sockets.
/// Checks CONDUCTOR_PTY_SOCKET_DIR → XDG_RUNTIME_DIR/conductor-pty → /tmp/conductor-pty.
pub(super) fn detached_socket_root() -> String {
    std::env::var("CONDUCTOR_PTY_SOCKET_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|dir| format!("{}/conductor-pty", dir))
                .unwrap_or_else(|| "/tmp/conductor-pty".to_string())
        })
}
pub(super) const DETACHED_PTY_PROTOCOL_VERSION: u16 = 1;
pub(super) const TERMINAL_DAEMON_PROTOCOL_VERSION: u16 = 2;
pub(super) const DETACHED_PTY_TRANSPORT: &str = "dual_socket_control_json_stream_binary_v1";
pub(super) const DETACHED_PTY_TERMINAL_EMULATOR: &str = "vt100_restore_v1";
pub(super) const DETACHED_PTY_BACKPRESSURE_MODE: &str = "bounded_channel_pause_pty_read_v2";
pub(super) const DETACHED_PTY_ISOLATION_MODE: &str = "portable_pty_subprocess_v1";

/// Default PTY dimensions used when spawning a detached terminal host.
/// The dashboard client sends a resize once the terminal surface mounts,
/// so these are only the initial fallback.
pub(super) const DEFAULT_DETACHED_PTY_COLS: u16 = 160;
pub(super) const DEFAULT_DETACHED_PTY_ROWS: u16 = 48;

pub(super) fn detached_protocol_version() -> u16 {
    DETACHED_PTY_PROTOCOL_VERSION
}

pub(super) fn terminal_daemon_protocol_version() -> u16 {
    TERMINAL_DAEMON_PROTOCOL_VERSION
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
    pub checkpoint_path: PathBuf,
    pub exit_path: PathBuf,
    pub ready_path: PathBuf,
    #[serde(default = "detached_stream_flush_interval_ms")]
    pub stream_flush_interval_ms: u64,
    #[serde(default = "detached_stream_max_batch_bytes")]
    pub stream_max_batch_bytes: usize,
    /// Optional isolation mode override.  When set to
    /// [`DETACHED_PTY_SUBPROCESS_ISOLATION_MODE`] the PTY child is placed in
    /// its own process group and monitored for crash resilience.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation_mode: Option<String>,
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
    Checkpoint,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_snapshot: Option<TerminalRestoreSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetachedPtyHostCheckpoint {
    pub output_offset: u64,
    pub restore_snapshot: TerminalRestoreSnapshot,
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
    ListSessions {
        protocol_version: u16,
        token: String,
    },
    GetSession {
        protocol_version: u16,
        token: String,
        session_id: String,
    },
    GetSessionReplay {
        protocol_version: u16,
        token: String,
        session_id: String,
        max_bytes: usize,
    },
    GetSessionCheckpoint {
        protocol_version: u16,
        token: String,
        session_id: String,
        max_bytes: usize,
    },
    TerminateSession {
        protocol_version: u16,
        token: String,
        session_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDaemonSessionInfo {
    pub(super) session_id: String,
    pub(super) spec_path: PathBuf,
    pub(super) ready_path: PathBuf,
    pub(super) host_pid: Option<u32>,
    pub(super) child_pid: Option<u32>,
    pub(super) protocol_version: Option<u16>,
    pub(super) cols: Option<u16>,
    pub(super) rows: Option<u16>,
    pub(super) control_socket_path: Option<PathBuf>,
    pub(super) stream_socket_path: Option<PathBuf>,
    pub(super) control_token: Option<String>,
    pub(super) log_path: Option<PathBuf>,
    pub(super) checkpoint_path: Option<PathBuf>,
    pub(super) exit_path: Option<PathBuf>,
    pub(super) status: String,
    pub(super) started_at: String,
    pub(super) updated_at: String,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDaemonReplayPayload {
    pub(super) bytes_base64: String,
    pub(super) byte_length: usize,
    pub(super) start_offset: u64,
    pub(super) end_offset: u64,
    pub(super) truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDaemonCheckpointPayload {
    pub(super) bytes_base64: String,
    pub(super) byte_length: usize,
    pub(super) start_offset: u64,
    pub(super) end_offset: u64,
    pub(super) truncated: bool,
    pub(super) cols: u16,
    pub(super) rows: u16,
    #[serde(default)]
    pub(super) output_offset: Option<u64>,
    #[serde(default)]
    pub(crate) restore_snapshot: Option<TerminalRestoreSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalDaemonResponse {
    #[serde(default = "terminal_daemon_protocol_version")]
    pub(super) protocol_version: u16,
    pub(super) ok: bool,
    pub(super) daemon_pid: Option<u32>,
    pub(super) host_pid: Option<u32>,
    pub(super) child_pid: Option<u32>,
    pub(super) error: Option<String>,
    #[serde(default)]
    pub(super) sessions: Option<Vec<String>>,
    #[serde(default)]
    pub(super) session: Option<TerminalDaemonSessionInfo>,
    #[serde(default)]
    pub(super) replay: Option<TerminalDaemonReplayPayload>,
    #[serde(default)]
    pub(super) checkpoint: Option<TerminalDaemonCheckpointPayload>,
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalDaemonMetadata {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalRuntimeAuthority {
    Daemon,
    DetachedHost,
    SessionMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalRuntimeStatus {
    Ready,
    Spawning,
    Exited,
    Failed,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRuntimeState {
    pub authority: TerminalRuntimeAuthority,
    pub status: TerminalRuntimeStatus,
    pub daemon_connected: Option<bool>,
    pub host_pid: Option<u32>,
    pub child_pid: Option<u32>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub recovery_action: Option<String>,
}
