#[cfg(unix)]
use anyhow::Context;
use anyhow::{anyhow, Result};
#[cfg(unix)]
use chrono::Utc;
use conductor_executors::executor::{Executor, SpawnOptions};
#[cfg(unix)]
use conductor_executors::executor::{ExecutorHandle, ExecutorInput, ExecutorOutput};
#[cfg(unix)]
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::collections::HashMap;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
#[cfg(unix)]
use tokio::fs::OpenOptions;
#[cfg(unix)]
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, BufWriter, SeekFrom,
};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(unix)]
use tokio::sync::Notify;
use tokio::sync::{mpsc, oneshot};

use super::tmux_runtime::RuntimeLaunch;
#[cfg(unix)]
use super::types::TerminalStreamEvent;
use crate::state::AppState;
#[cfg(unix)]
use crate::state::{OutputConsumerConfig, SessionRecord, SessionStatus};

pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
pub(crate) const DETACHED_CONTROL_SOCKET_METADATA_KEY: &str = "detachedControlSocket";
pub(crate) const DETACHED_STREAM_SOCKET_METADATA_KEY: &str = "detachedStreamSocket";
pub(crate) const DETACHED_CONTROL_TOKEN_METADATA_KEY: &str = "detachedControlToken";
pub(crate) const DETACHED_LOG_PATH_METADATA_KEY: &str = "detachedLogPath";
pub(crate) const DETACHED_EXIT_PATH_METADATA_KEY: &str = "detachedExitPath";
const DETACHED_READY_TIMEOUT: Duration = Duration::from_secs(5);
const DETACHED_LOG_WATCH_FALLBACK_INTERVAL: Duration = Duration::from_millis(250);
const DETACHED_EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const DETACHED_STREAM_RECONNECT_INTERVAL: Duration = Duration::from_millis(50);
const DETACHED_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(32);
const DETACHED_STREAM_MAX_BATCH_BYTES: usize = 128 * 1024;
const DETACHED_STREAM_CHANNEL_CAPACITY: usize = 256;
const DETACHED_STREAM_FRAME_HEADER_BYTES: usize = 13;
const DETACHED_STREAM_FRAME_MAX_BYTES: usize = 64 * 1024 * 1024;
const DETACHED_CAPTURE_CHANNEL_CAPACITY: usize = 256;
const DETACHED_CAPTURE_BUFFER_CAPACITY: usize = 64 * 1024;
const DETACHED_CAPTURE_FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const DETACHED_CAPTURE_FORCE_FLUSH_BYTES: usize = 16 * 1024;
const DETACHED_SOCKET_ROOT: &str = "/tmp/conductor-pty";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostSpec {
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostReady {
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
    pub token: String,
    #[serde(flatten)]
    pub command: DetachedPtyHostCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostResponse {
    pub ok: bool,
    pub child_pid: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetachedPtyHostStreamRequest {
    token: String,
    offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetachedPtyHostStreamResponse {
    ok: bool,
    child_pid: Option<u32>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct DetachedRuntimeMetadata {
    host_pid: u32,
    control_socket_path: PathBuf,
    stream_socket_path: Option<PathBuf>,
    control_token: String,
    log_path: PathBuf,
    exit_path: PathBuf,
}

struct DetachedRuntimeAttachment {
    kind: conductor_core::types::AgentKind,
    session_id: String,
    child_pid: u32,
    metadata: DetachedRuntimeMetadata,
}

struct DetachedOutputForwarder {
    session_id: String,
    metadata: DetachedRuntimeMetadata,
    offset: u64,
}

#[derive(Clone)]
struct DetachedPtyOutputChunk {
    offset: u64,
    bytes: Arc<[u8]>,
}

enum DetachedPtyHostCaptureMessage {
    Data(DetachedPtyOutputChunk),
    Flush { ack: oneshot::Sender<()> },
    Shutdown,
}

enum DetachedPtyHostStreamMessage {
    Data(DetachedPtyOutputChunk),
    Exit { offset: u64, exit_code: i32 },
    Error { offset: u64, message: String },
}

struct DetachedHostStreamSlot {
    generation: u64,
    tx: mpsc::Sender<DetachedPtyHostStreamMessage>,
}

#[cfg(unix)]
struct DetachedHostState {
    token: String,
    child_pid: u32,
    writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    capture_tx: mpsc::Sender<DetachedPtyHostCaptureMessage>,
    stream_slot: Arc<StdMutex<Option<DetachedHostStreamSlot>>>,
    stream_generation: AtomicU64,
    log_offset: AtomicU64,
    log_path: PathBuf,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum DetachedPtyStreamFrameKind {
    Data = 1,
    Exit = 2,
    Error = 3,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DetachedPtyStreamFrame {
    kind: DetachedPtyStreamFrameKind,
    offset: u64,
    payload: Vec<u8>,
}

#[cfg(unix)]
struct DetachedPtyStreamFrameDecoder {
    header: [u8; DETACHED_STREAM_FRAME_HEADER_BYTES],
    header_offset: usize,
    frame_kind: Option<DetachedPtyStreamFrameKind>,
    frame_offset: u64,
    payload: Option<Vec<u8>>,
    payload_offset: usize,
}

#[cfg(unix)]
impl Default for DetachedPtyStreamFrameDecoder {
    fn default() -> Self {
        Self {
            header: [0; DETACHED_STREAM_FRAME_HEADER_BYTES],
            header_offset: 0,
            frame_kind: None,
            frame_offset: 0,
            payload: None,
            payload_offset: 0,
        }
    }
}

#[cfg(unix)]
impl DetachedPtyStreamFrameDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<DetachedPtyStreamFrame>> {
        let mut frames = Vec::new();
        let mut offset = 0;
        while offset < chunk.len() {
            if self.payload.is_none() {
                let needed = DETACHED_STREAM_FRAME_HEADER_BYTES - self.header_offset;
                let available = chunk.len() - offset;
                let to_copy = needed.min(available);
                self.header[self.header_offset..self.header_offset + to_copy]
                    .copy_from_slice(&chunk[offset..offset + to_copy]);
                self.header_offset += to_copy;
                offset += to_copy;

                if self.header_offset < DETACHED_STREAM_FRAME_HEADER_BYTES {
                    continue;
                }

                let frame_kind = decode_detached_stream_frame_kind(self.header[0])?;
                let frame_offset = u64::from_be_bytes(self.header[1..9].try_into().unwrap());
                let payload_len =
                    u32::from_be_bytes(self.header[9..13].try_into().unwrap()) as usize;
                if payload_len > DETACHED_STREAM_FRAME_MAX_BYTES {
                    return Err(anyhow!(
                        "Detached PTY stream frame too large: {payload_len} bytes"
                    ));
                }

                self.frame_kind = Some(frame_kind);
                self.frame_offset = frame_offset;
                self.header_offset = 0;
                if payload_len == 0 {
                    frames.push(DetachedPtyStreamFrame {
                        kind: frame_kind,
                        offset: frame_offset,
                        payload: Vec::new(),
                    });
                    self.frame_kind = None;
                } else {
                    self.payload = Some(vec![0; payload_len]);
                    self.payload_offset = 0;
                }
            } else {
                let payload = self.payload.as_mut().expect("payload should exist");
                let needed = payload.len() - self.payload_offset;
                let available = chunk.len() - offset;
                let to_copy = needed.min(available);
                payload[self.payload_offset..self.payload_offset + to_copy]
                    .copy_from_slice(&chunk[offset..offset + to_copy]);
                self.payload_offset += to_copy;
                offset += to_copy;

                if self.payload_offset < payload.len() {
                    continue;
                }

                frames.push(DetachedPtyStreamFrame {
                    kind: self.frame_kind.take().expect("frame kind should exist"),
                    offset: self.frame_offset,
                    payload: self.payload.take().expect("payload should exist"),
                });
                self.payload_offset = 0;
            }
        }

        Ok(frames)
    }
}

#[cfg(unix)]
pub async fn run_detached_pty_host(spec_path: PathBuf) -> Result<()> {
    let spec = serde_json::from_slice::<DetachedPtyHostSpec>(&tokio::fs::read(&spec_path).await?)
        .with_context(|| {
        format!("Failed to parse detached PTY spec {}", spec_path.display())
    })?;

    if let Some(parent) = spec.log_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.exit_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.ready_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.control_socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.stream_socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::remove_file(&spec.control_socket_path).await;
    let _ = tokio::fs::remove_file(&spec.stream_socket_path).await;
    let _ = tokio::fs::remove_file(&spec.log_path).await;
    let _ = tokio::fs::remove_file(&spec.exit_path).await;
    let _ = tokio::fs::remove_file(&spec.ready_path).await;

    let control_listener = UnixListener::bind(&spec.control_socket_path)
        .context("Failed to bind detached PTY control listener")?;
    let stream_listener = UnixListener::bind(&spec.stream_socket_path)
        .context("Failed to bind detached PTY stream listener")?;

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: spec.rows.max(1),
        cols: spec.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&spec.binary);
    cmd.cwd(&spec.cwd);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    for (key, value) in &spec.env {
        cmd.env(key, value);
    }

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let child_pid = child.process_id().unwrap_or(0);
    let reader = pair.master.try_clone_reader()?;
    let writer = Arc::new(StdMutex::new(pair.master.take_writer()?));
    let master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>> =
        Arc::new(StdMutex::new(Some(pair.master)));
    let child = Arc::new(StdMutex::new(child));

    let (capture_tx, capture_rx) = mpsc::channel(DETACHED_CAPTURE_CHANNEL_CAPACITY);
    tokio::spawn(run_detached_capture_writer(
        spec.log_path.clone(),
        capture_rx,
    ));

    let shared = Arc::new(DetachedHostState {
        token: spec.token.clone(),
        child_pid,
        writer,
        master,
        child,
        capture_tx: capture_tx.clone(),
        stream_slot: Arc::new(StdMutex::new(None)),
        stream_generation: AtomicU64::new(0),
        log_offset: AtomicU64::new(0),
        log_path: spec.log_path.clone(),
    });

    let shared_for_output = shared.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0_u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let offset = shared_for_output
                        .log_offset
                        .fetch_add(read as u64, Ordering::Relaxed);
                    let chunk = DetachedPtyOutputChunk {
                        offset,
                        bytes: Arc::<[u8]>::from(buffer[..read].to_vec()),
                    };
                    if shared_for_output
                        .capture_tx
                        .blocking_send(DetachedPtyHostCaptureMessage::Data(chunk.clone()))
                        .is_err()
                    {
                        break;
                    }
                    if let Some(sender) = clone_detached_host_stream_sender(&shared_for_output) {
                        let _ = sender.blocking_send(DetachedPtyHostStreamMessage::Data(chunk));
                    }
                }
                Err(_) => break,
            }
        }
    });

    let ready = DetachedPtyHostReady {
        host_pid: std::process::id(),
        child_pid,
    };
    tokio::fs::write(&spec.ready_path, serde_json::to_vec(&ready)?).await?;

    let shutdown = Arc::new(Notify::new());
    let shutdown_for_wait = shutdown.clone();
    let exit_path = spec.exit_path.clone();
    let shared_for_wait = shared.clone();
    tokio::spawn(async move {
        let result = wait_for_detached_child(shared_for_wait.child.clone()).await;
        if let Ok(mut guard) = shared_for_wait.master.lock() {
            guard.take();
        }

        let stream_offset = shared_for_wait.log_offset.load(Ordering::Relaxed);
        let stream_error = result.as_ref().err().map(ToString::to_string);
        let exit_code = result.unwrap_or(-1);

        let _ = flush_detached_capture(&shared_for_wait.capture_tx).await;
        let _ = tokio::fs::write(&exit_path, exit_code.to_string()).await;

        if let Some(sender) = clone_detached_host_stream_sender(&shared_for_wait) {
            if let Some(message) = stream_error {
                let _ = sender
                    .send(DetachedPtyHostStreamMessage::Error {
                        offset: stream_offset,
                        message,
                    })
                    .await;
            }
            let _ = sender
                .send(DetachedPtyHostStreamMessage::Exit {
                    offset: stream_offset,
                    exit_code,
                })
                .await;
        }
        let _ = shared_for_wait
            .capture_tx
            .send(DetachedPtyHostCaptureMessage::Shutdown)
            .await;
        shutdown_for_wait.notify_waiters();
    });

    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = control_listener.accept() => {
                let (stream, _) = accepted?;
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _ = handle_detached_host_connection(stream, shared).await;
                });
            }
            accepted = stream_listener.accept() => {
                let (stream, _) = accepted?;
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _ = handle_detached_stream_connection(stream, shared).await;
                });
            }
        }
    }

    let _ = tokio::fs::remove_file(&spec.control_socket_path).await;
    let _ = tokio::fs::remove_file(&spec.stream_socket_path).await;
    Ok(())
}

#[cfg(not(unix))]
pub async fn run_detached_pty_host(_spec_path: PathBuf) -> Result<()> {
    Err(anyhow!(
        "Detached PTY host is only supported on Unix platforms"
    ))
}

#[cfg(unix)]
impl AppState {
    pub(crate) async fn spawn_detached_runtime_or_legacy(
        self: &Arc<Self>,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        if detached_runtime_disabled() {
            return self.spawn_legacy_direct_runtime(executor, options).await;
        }

        let Some(launcher_path) = resolve_detached_runtime_launcher() else {
            tracing::warn!("Detached PTY host launcher is unavailable; falling back to in-process direct runtime");
            return self.spawn_legacy_direct_runtime(executor, options).await;
        };

        let runtime_root = self.direct_runtime_root().await;
        tokio::fs::create_dir_all(&runtime_root).await?;
        tokio::fs::create_dir_all(self.detached_socket_root()).await?;
        let spec_path = runtime_root.join(format!("{session_id}.spec.json"));
        let ready_path = runtime_root.join(format!("{session_id}.ready.json"));
        let (control_socket_path, stream_socket_path) = self.detached_socket_paths(session_id);
        let log_path = runtime_root.join(format!("{session_id}.log"));
        let exit_path = runtime_root.join(format!("{session_id}.exit"));
        let control_token = uuid::Uuid::new_v4().to_string();

        let spec = DetachedPtyHostSpec {
            token: control_token.clone(),
            binary: executor.binary_path().to_path_buf(),
            args: executor.build_args(&options),
            cwd: options.cwd.clone(),
            env: options.env.clone(),
            cols: 160,
            rows: 48,
            control_socket_path: control_socket_path.clone(),
            stream_socket_path: stream_socket_path.clone(),
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
            ready_path: ready_path.clone(),
        };
        tokio::fs::write(&spec_path, serde_json::to_vec(&spec)?).await?;

        let mut command = tokio::process::Command::new(&launcher_path);
        command
            .arg("--workspace")
            .arg(&self.workspace_path)
            .arg("--config")
            .arg(&self.config_path)
            .arg("pty-host")
            .arg("--spec")
            .arg(&spec_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .current_dir(&self.workspace_path);
        configure_detached_process_group(&mut command);
        let child = command.spawn().with_context(|| {
            format!(
                "Failed to launch detached PTY host via {}",
                launcher_path.display()
            )
        })?;
        let host_pid = child.id().unwrap_or(0);
        drop(child);

        let ready = wait_for_detached_ready(&ready_path, DETACHED_READY_TIMEOUT).await?;
        let attachment = DetachedRuntimeAttachment {
            kind: executor.kind(),
            session_id: session_id.to_string(),
            child_pid: ready.child_pid,
            metadata: DetachedRuntimeMetadata {
                host_pid: if ready.host_pid > 0 {
                    ready.host_pid
                } else {
                    host_pid
                },
                control_socket_path: control_socket_path.clone(),
                stream_socket_path: Some(stream_socket_path.clone()),
                control_token: control_token.clone(),
                log_path: log_path.clone(),
                exit_path: exit_path.clone(),
            },
        };
        let handle = self.attach_detached_runtime_handle(attachment).await?;
        let _ = tokio::fs::remove_file(&spec_path).await;
        let _ = tokio::fs::remove_file(&ready_path).await;

        Ok(RuntimeLaunch {
            handle,
            metadata: HashMap::from([
                (
                    super::tmux_runtime::RUNTIME_MODE_METADATA_KEY.to_string(),
                    DIRECT_RUNTIME_MODE.to_string(),
                ),
                (
                    "detachedPid".to_string(),
                    if ready.host_pid > 0 {
                        ready.host_pid.to_string()
                    } else {
                        host_pid.to_string()
                    },
                ),
                (
                    DETACHED_CONTROL_SOCKET_METADATA_KEY.to_string(),
                    control_socket_path.to_string_lossy().to_string(),
                ),
                (
                    DETACHED_STREAM_SOCKET_METADATA_KEY.to_string(),
                    stream_socket_path.to_string_lossy().to_string(),
                ),
                (
                    DETACHED_CONTROL_TOKEN_METADATA_KEY.to_string(),
                    control_token,
                ),
                (
                    DETACHED_LOG_PATH_METADATA_KEY.to_string(),
                    log_path.to_string_lossy().to_string(),
                ),
                (
                    DETACHED_EXIT_PATH_METADATA_KEY.to_string(),
                    exit_path.to_string_lossy().to_string(),
                ),
            ]),
        })
    }

    pub(crate) async fn restore_detached_runtime(self: &Arc<Self>, session_id: &str) -> Result<()> {
        if self.terminal_runtime_attached(session_id).await {
            return Ok(());
        }

        let session = self
            .get_session(session_id)
            .await
            .with_context(|| format!("Session {session_id} not found"))?;
        let Some(metadata) = detached_runtime_metadata(&session) else {
            return Ok(());
        };
        let Some(response) = ping_detached_runtime(&metadata).await? else {
            if let Some(exit_code) = read_detached_exit_code(&metadata.exit_path).await? {
                let event = if exit_code == 0 {
                    ExecutorOutput::Completed { exit_code }
                } else {
                    ExecutorOutput::Failed {
                        error: format!("Process exited with code {exit_code}"),
                        exit_code: Some(exit_code),
                    }
                };
                self.apply_runtime_event(session_id, event).await?;
                return Ok(());
            }

            let mut sessions = self.sessions.write().await;
            if let Some(current) = sessions.get_mut(session_id) {
                current.status = SessionStatus::Stuck;
                current.activity = Some("blocked".to_string());
                current.summary = Some(
                    "Detached PTY runtime was not reachable after restart. Send a message to start a fresh runtime in the same workspace.".to_string(),
                );
                current.metadata.insert(
                    "summary".to_string(),
                    current.summary.clone().unwrap_or_default(),
                );
                current
                    .metadata
                    .insert("recoveryState".to_string(), "resume_required".to_string());
                current
                    .metadata
                    .insert("recoveryAction".to_string(), "resume".to_string());
                current.pid = None;
                let updated = current.clone();
                drop(sessions);
                self.replace_session(updated).await?;
            }
            return Ok(());
        };

        let executors = self.executors.read().await;
        let executor = executors
            .get(&conductor_core::types::AgentKind::parse(&session.agent))
            .cloned()
            .with_context(|| format!("Executor '{}' is not available", session.agent))?;
        drop(executors);

        let handle = self
            .attach_detached_runtime_handle(DetachedRuntimeAttachment {
                kind: executor.kind(),
                session_id: session_id.to_string(),
                child_pid: response.child_pid.unwrap_or(session.pid.unwrap_or(0)),
                metadata: metadata.clone(),
            })
            .await?;
        let (_pid, _kind, output_rx, input_tx, terminal_rx, resize_tx, kill_tx) =
            handle.into_parts();
        self.attach_terminal_runtime(session_id, input_tx, resize_tx, kill_tx)
            .await;
        self.start_output_consumer(
            session_id.to_string(),
            executor,
            output_rx,
            OutputConsumerConfig {
                terminal_rx,
                mirror_terminal_output: false,
                output_is_parsed: true,
                timeout: None,
            },
        );

        let mut sessions = self.sessions.write().await;
        if let Some(current) = sessions.get_mut(session_id) {
            current.pid = response.child_pid.or(current.pid);
            current.activity = match &current.status {
                SessionStatus::NeedsInput => Some("waiting_input".to_string()),
                SessionStatus::Queued => Some("idle".to_string()),
                _ => Some("active".to_string()),
            };
            if current.status == SessionStatus::Spawning {
                current.status = SessionStatus::Working;
            }
            current.metadata.remove("recoveryState");
            current.metadata.remove("recoveryAction");
            current
                .metadata
                .insert("lastRecoveredAt".to_string(), Utc::now().to_rfc3339());
            let updated = current.clone();
            drop(sessions);
            self.replace_session(updated).await?;
        }

        Ok(())
    }

    pub(crate) async fn direct_runtime_root(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("direct")
    }

    fn detached_socket_root(&self) -> PathBuf {
        PathBuf::from(DETACHED_SOCKET_ROOT)
    }

    fn detached_socket_paths(&self, session_id: &str) -> (PathBuf, PathBuf) {
        let mut hasher = Sha256::new();
        hasher.update(self.workspace_path.to_string_lossy().as_bytes());
        hasher.update(b":");
        hasher.update(session_id.as_bytes());
        let digest = hex::encode(hasher.finalize());
        let stem = &digest[..16];
        let root = self.detached_socket_root();
        (
            root.join(format!("{stem}.ctrl.sock")),
            root.join(format!("{stem}.stream.sock")),
        )
    }

    async fn detached_replay_offset(&self, session_id: &str) -> u64 {
        tokio::fs::metadata(self.session_terminal_capture_path(session_id))
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    }

    pub(crate) async fn kill_detached_runtime(&self, session_id: &str) -> Result<bool> {
        let Some(session) = self.get_session(session_id).await else {
            return Ok(false);
        };
        let Some(metadata) = detached_runtime_metadata(&session) else {
            return Ok(false);
        };
        let response =
            send_detached_runtime_request(&metadata, DetachedPtyHostCommand::Kill).await?;
        Ok(response.ok)
    }

    async fn spawn_legacy_direct_runtime(
        self: &Arc<Self>,
        executor: Arc<dyn Executor>,
        mut options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        options.interactive = executor.supports_direct_terminal_ui();
        options.structured_output = false;
        let handle = executor.spawn(options).await?;
        Ok(RuntimeLaunch {
            handle,
            metadata: HashMap::from([(
                super::tmux_runtime::RUNTIME_MODE_METADATA_KEY.to_string(),
                DIRECT_RUNTIME_MODE.to_string(),
            )]),
        })
    }

    async fn attach_detached_runtime_handle(
        self: &Arc<Self>,
        attachment: DetachedRuntimeAttachment,
    ) -> Result<ExecutorHandle> {
        let DetachedRuntimeAttachment {
            kind,
            session_id,
            child_pid,
            metadata,
        } = attachment;
        let replay_offset = self.detached_replay_offset(&session_id).await;
        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
        let (resize_tx, mut resize_rx) =
            mpsc::channel::<conductor_executors::process::PtyDimensions>(8);
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        let metadata_for_input = metadata.clone();
        let session_id_for_input = session_id.clone();
        tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                let command = match input {
                    ExecutorInput::Text(text) => DetachedPtyHostCommand::Text { text },
                    ExecutorInput::Raw(raw) => DetachedPtyHostCommand::Raw { data: raw },
                };
                if let Err(err) = send_detached_runtime_request(&metadata_for_input, command).await
                {
                    tracing::warn!(session_id_for_input, error = %err, "Failed to send input to detached PTY runtime");
                    break;
                }
            }
        });

        let metadata_for_resize = metadata.clone();
        let session_id_for_resize = session_id.clone();
        tokio::spawn(async move {
            while let Some(dimensions) = resize_rx.recv().await {
                if let Err(err) = send_detached_runtime_request(
                    &metadata_for_resize,
                    DetachedPtyHostCommand::Resize {
                        cols: dimensions.cols,
                        rows: dimensions.rows,
                    },
                )
                .await
                {
                    tracing::warn!(session_id_for_resize, error = %err, "Failed to resize detached PTY runtime");
                    break;
                }
            }
        });

        let metadata_for_kill = metadata.clone();
        tokio::spawn(async move {
            if kill_rx.try_recv().is_ok() {
                return;
            }
            let _ = kill_rx.await;
            let _ = send_detached_runtime_request(&metadata_for_kill, DetachedPtyHostCommand::Kill)
                .await;
        });

        let state = self.clone();
        tokio::spawn(async move {
            if let Err(err) = state
                .forward_detached_output(
                    DetachedOutputForwarder {
                        session_id: session_id.clone(),
                        metadata,
                        offset: replay_offset,
                    },
                    output_tx,
                )
                .await
            {
                tracing::warn!(session_id, error = %err, "Detached runtime output forwarder failed");
            }
        });

        Ok(
            ExecutorHandle::new(child_pid, kind, output_rx, input_tx, kill_tx)
                .with_terminal_io(None, Some(resize_tx)),
        )
    }

    async fn forward_detached_output(
        self: Arc<Self>,
        forwarder: DetachedOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        if forwarder.metadata.stream_socket_path.is_some() {
            self.forward_detached_stream_output(forwarder, output_tx)
                .await
        } else {
            self.forward_detached_log_output(forwarder, output_tx).await
        }
    }

    async fn forward_detached_stream_output(
        self: Arc<Self>,
        forwarder: DetachedOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        let DetachedOutputForwarder {
            session_id,
            metadata,
            mut offset,
        } = forwarder;
        let mut partial = Vec::new();
        let mut exit_deadline = None;

        loop {
            match connect_detached_runtime_stream(&metadata, offset).await {
                Ok(mut stream) => {
                    exit_deadline = None;
                    let mut decoder = DetachedPtyStreamFrameDecoder::default();
                    let mut buffer = [0_u8; 8192];
                    loop {
                        let read = match stream.read(&mut buffer).await {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(err) => {
                                tracing::debug!(session_id, error = %err, "Detached PTY stream read error, reconnecting");
                                break;
                            }
                        };
                        for frame in decoder.push(&buffer[..read])? {
                            match frame.kind {
                                DetachedPtyStreamFrameKind::Data => {
                                    let next_offset = frame.offset + frame.payload.len() as u64;
                                    if next_offset <= offset {
                                        continue;
                                    }
                                    let skip = offset.saturating_sub(frame.offset) as usize;
                                    if skip >= frame.payload.len() {
                                        offset = next_offset;
                                        continue;
                                    }
                                    let chunk = frame.payload[skip..].to_vec();
                                    self.emit_terminal_bytes(&session_id, &chunk).await;
                                    let lines = split_detached_log_lines(&mut partial, &chunk);
                                    for line in lines {
                                        if output_tx
                                            .send(ExecutorOutput::Stdout(line))
                                            .await
                                            .is_err()
                                        {
                                            return Ok(());
                                        }
                                    }
                                    offset = next_offset;
                                }
                                DetachedPtyStreamFrameKind::Exit => {
                                    flush_detached_partial_line(&output_tx, &mut partial).await?;
                                    let exit_code = decode_detached_exit_payload(&frame.payload)?;
                                    emit_detached_runtime_exit(
                                        &self,
                                        &session_id,
                                        &output_tx,
                                        exit_code,
                                    )
                                    .await;
                                    return Ok(());
                                }
                                DetachedPtyStreamFrameKind::Error => {
                                    flush_detached_partial_line(&output_tx, &mut partial).await?;
                                    let error = String::from_utf8_lossy(&frame.payload).to_string();
                                    emit_detached_runtime_error(
                                        &self,
                                        &session_id,
                                        &output_tx,
                                        error,
                                        None,
                                    )
                                    .await;
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    tracing::debug!(session_id, error = %err, "Detached PTY stream connect failed");
                }
            }

            if !crate::state::workspace::is_process_alive(metadata.host_pid) {
                let deadline = exit_deadline.get_or_insert_with(|| {
                    tokio::time::Instant::now() + DETACHED_EXIT_WAIT_TIMEOUT
                });
                flush_detached_partial_line(&output_tx, &mut partial).await?;
                if let Some(exit_code) = read_detached_exit_code(&metadata.exit_path).await? {
                    emit_detached_runtime_exit(&self, &session_id, &output_tx, exit_code).await;
                    return Ok(());
                }
                if tokio::time::Instant::now() >= *deadline {
                    emit_detached_runtime_error(
                        &self,
                        &session_id,
                        &output_tx,
                        "Detached PTY runtime exited unexpectedly".to_string(),
                        None,
                    )
                    .await;
                    return Ok(());
                }
            } else {
                exit_deadline = None;
            }

            tokio::time::sleep(DETACHED_STREAM_RECONNECT_INTERVAL).await;
        }
    }

    async fn forward_detached_log_output(
        self: Arc<Self>,
        forwarder: DetachedOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        let DetachedOutputForwarder {
            session_id,
            metadata,
            mut offset,
        } = forwarder;
        let (_watcher, mut log_events) = watch_detached_log(&metadata.log_path)?;
        let mut partial = Vec::new();
        let mut exit_deadline = None;

        loop {
            if let Some((next_offset, chunk)) =
                read_detached_log_chunk(&metadata.log_path, offset).await?
            {
                self.emit_terminal_bytes(&session_id, &chunk).await;
                let lines = split_detached_log_lines(&mut partial, &chunk);
                for line in lines {
                    if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                        return Ok(());
                    }
                }
                offset = next_offset;
            }

            if !crate::state::workspace::is_process_alive(metadata.host_pid) {
                let deadline = exit_deadline.get_or_insert_with(|| {
                    tokio::time::Instant::now() + DETACHED_EXIT_WAIT_TIMEOUT
                });
                flush_detached_partial_line(&output_tx, &mut partial).await?;

                if let Some(exit_code) = read_detached_exit_code(&metadata.exit_path).await? {
                    emit_detached_runtime_exit(&self, &session_id, &output_tx, exit_code).await;
                    return Ok(());
                }

                if tokio::time::Instant::now() >= *deadline {
                    emit_detached_runtime_error(
                        &self,
                        &session_id,
                        &output_tx,
                        "Detached PTY runtime exited unexpectedly".to_string(),
                        None,
                    )
                    .await;
                    return Ok(());
                }
            } else {
                exit_deadline = None;
            }

            tokio::select! {
                event = log_events.recv() => {
                    if event.is_none() {
                        tokio::time::sleep(DETACHED_LOG_WATCH_FALLBACK_INTERVAL).await;
                    }
                }
                _ = tokio::time::sleep(DETACHED_LOG_WATCH_FALLBACK_INTERVAL) => {}
            }
        }
    }
}

#[cfg(not(unix))]
impl AppState {
    pub(crate) async fn spawn_detached_runtime_or_legacy(
        self: &Arc<Self>,
        executor: Arc<dyn Executor>,
        _session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        tracing::warn!(
            "Detached PTY host is unavailable on this platform; falling back to in-process direct runtime"
        );
        self.spawn_legacy_direct_runtime(executor, options).await
    }

    pub(crate) async fn restore_detached_runtime(
        self: &Arc<Self>,
        _session_id: &str,
    ) -> Result<()> {
        Ok(())
    }

    pub(crate) async fn kill_detached_runtime(&self, _session_id: &str) -> Result<bool> {
        Ok(false)
    }

    async fn spawn_legacy_direct_runtime(
        self: &Arc<Self>,
        executor: Arc<dyn Executor>,
        mut options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        options.interactive = executor.supports_direct_terminal_ui();
        options.structured_output = false;
        let handle = executor.spawn(options).await?;
        Ok(RuntimeLaunch {
            handle,
            metadata: HashMap::from([(
                super::tmux_runtime::RUNTIME_MODE_METADATA_KEY.to_string(),
                DIRECT_RUNTIME_MODE.to_string(),
            )]),
        })
    }
}

#[cfg(unix)]
async fn handle_detached_host_connection(
    stream: UnixStream,
    state: Arc<DetachedHostState>,
) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Ok(());
    }
    let request = serde_json::from_slice::<DetachedPtyHostRequest>(&line)
        .context("Failed to parse detached PTY host request")?;
    let response = if request.token != state.token {
        DetachedPtyHostResponse {
            ok: false,
            child_pid: Some(state.child_pid),
            error: Some("Unauthorized detached PTY host request".to_string()),
        }
    } else {
        match request.command {
            DetachedPtyHostCommand::Ping => DetachedPtyHostResponse {
                ok: true,
                child_pid: Some(state.child_pid),
                error: None,
            },
            DetachedPtyHostCommand::Text { text } => {
                write_detached_host_input(&state.writer, &text, true).await?;
                DetachedPtyHostResponse {
                    ok: true,
                    child_pid: Some(state.child_pid),
                    error: None,
                }
            }
            DetachedPtyHostCommand::Raw { data } => {
                write_detached_host_input(&state.writer, &data, false).await?;
                DetachedPtyHostResponse {
                    ok: true,
                    child_pid: Some(state.child_pid),
                    error: None,
                }
            }
            DetachedPtyHostCommand::Resize { cols, rows } => {
                resize_detached_host(&state.master, cols, rows).await?;
                DetachedPtyHostResponse {
                    ok: true,
                    child_pid: Some(state.child_pid),
                    error: None,
                }
            }
            DetachedPtyHostCommand::Kill => {
                kill_detached_host_child(&state.child).await?;
                DetachedPtyHostResponse {
                    ok: true,
                    child_pid: Some(state.child_pid),
                    error: None,
                }
            }
        }
    };

    let mut stream = reader.into_inner();
    stream.write_all(&serde_json::to_vec(&response)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(unix)]
async fn handle_detached_stream_connection(
    stream: UnixStream,
    state: Arc<DetachedHostState>,
) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Ok(());
    }
    let request = serde_json::from_slice::<DetachedPtyHostStreamRequest>(&line)
        .context("Failed to parse detached PTY stream request")?;
    let mut stream = reader.into_inner();
    if request.token != state.token {
        let response = DetachedPtyHostStreamResponse {
            ok: false,
            child_pid: Some(state.child_pid),
            error: Some("Unauthorized detached PTY stream request".to_string()),
        };
        stream.write_all(&serde_json::to_vec(&response)?).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        return Ok(());
    }

    let (tx, rx) = mpsc::channel(DETACHED_STREAM_CHANNEL_CAPACITY);
    let generation = state.stream_generation.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut slot = state
            .stream_slot
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *slot = Some(DetachedHostStreamSlot {
            generation,
            tx: tx.clone(),
        });
    }

    let result = async {
        flush_detached_capture(&state.capture_tx).await?;
        let replay_limit = detached_log_len(&state.log_path).await?;
        let response = DetachedPtyHostStreamResponse {
            ok: true,
            child_pid: Some(state.child_pid),
            error: None,
        };
        stream.write_all(&serde_json::to_vec(&response)?).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        forward_detached_host_stream(
            stream,
            state.log_path.clone(),
            request.offset,
            replay_limit,
            rx,
        )
        .await
    }
    .await;

    let mut slot = state
        .stream_slot
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if slot
        .as_ref()
        .map(|current| current.generation == generation)
        .unwrap_or(false)
    {
        *slot = None;
    }

    result
}

#[cfg(unix)]
async fn forward_detached_host_stream(
    mut stream: UnixStream,
    log_path: PathBuf,
    requested_offset: u64,
    replay_limit: u64,
    mut rx: mpsc::Receiver<DetachedPtyHostStreamMessage>,
) -> Result<()> {
    let mut stream_floor = requested_offset.min(replay_limit);
    replay_detached_log_range(&mut stream, &log_path, stream_floor, replay_limit).await?;
    stream_floor = replay_limit;

    let mut pending_offset = None;
    let mut pending = Vec::new();
    let mut flush_deadline = None;

    loop {
        if let Some(deadline) = flush_deadline {
            tokio::select! {
                maybe_message = rx.recv() => {
                    let Some(message) = maybe_message else {
                        flush_detached_stream_batch(&mut stream, &mut pending_offset, &mut pending).await?;
                        return Ok(());
                    };
                    if handle_detached_host_stream_message(
                        &mut stream,
                        &mut stream_floor,
                        &mut pending_offset,
                        &mut pending,
                        &mut flush_deadline,
                        message,
                    )
                    .await? {
                        return Ok(());
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    flush_detached_stream_batch(&mut stream, &mut pending_offset, &mut pending).await?;
                    flush_deadline = None;
                }
            }
        } else {
            let Some(message) = rx.recv().await else {
                flush_detached_stream_batch(&mut stream, &mut pending_offset, &mut pending).await?;
                return Ok(());
            };
            if handle_detached_host_stream_message(
                &mut stream,
                &mut stream_floor,
                &mut pending_offset,
                &mut pending,
                &mut flush_deadline,
                message,
            )
            .await?
            {
                return Ok(());
            }
        }
    }
}

#[cfg(unix)]
async fn handle_detached_host_stream_message(
    stream: &mut UnixStream,
    stream_floor: &mut u64,
    pending_offset: &mut Option<u64>,
    pending: &mut Vec<u8>,
    flush_deadline: &mut Option<tokio::time::Instant>,
    message: DetachedPtyHostStreamMessage,
) -> Result<bool> {
    match message {
        DetachedPtyHostStreamMessage::Data(chunk) => {
            let chunk_end = chunk.offset + chunk.bytes.len() as u64;
            if chunk_end <= *stream_floor {
                return Ok(false);
            }
            let skip = stream_floor.saturating_sub(chunk.offset) as usize;
            let effective_offset = chunk.offset + skip as u64;
            let bytes = &chunk.bytes[skip..];
            if bytes.is_empty() {
                *stream_floor = (*stream_floor).max(chunk_end);
                return Ok(false);
            }

            let expected_offset = pending_offset.map(|offset| offset + pending.len() as u64);
            if expected_offset.is_some() && expected_offset != Some(effective_offset) {
                flush_detached_stream_batch(stream, pending_offset, pending).await?;
                *flush_deadline = None;
            }
            if pending_offset.is_none() {
                *pending_offset = Some(effective_offset);
                *flush_deadline =
                    Some(tokio::time::Instant::now() + DETACHED_STREAM_FLUSH_INTERVAL);
            }
            pending.extend_from_slice(bytes);
            *stream_floor = (*stream_floor).max(chunk_end);

            if pending.len() >= DETACHED_STREAM_MAX_BATCH_BYTES {
                flush_detached_stream_batch(stream, pending_offset, pending).await?;
                *flush_deadline = None;
            }

            Ok(false)
        }
        DetachedPtyHostStreamMessage::Exit { offset, exit_code } => {
            flush_detached_stream_batch(stream, pending_offset, pending).await?;
            let payload = exit_code.to_be_bytes();
            write_detached_stream_frame(
                stream,
                DetachedPtyStreamFrameKind::Exit,
                offset.max(*stream_floor),
                &payload,
            )
            .await?;
            stream.flush().await?;
            Ok(true)
        }
        DetachedPtyHostStreamMessage::Error { offset, message } => {
            flush_detached_stream_batch(stream, pending_offset, pending).await?;
            write_detached_stream_frame(
                stream,
                DetachedPtyStreamFrameKind::Error,
                offset.max(*stream_floor),
                message.as_bytes(),
            )
            .await?;
            stream.flush().await?;
            Ok(true)
        }
    }
}

#[cfg(unix)]
async fn replay_detached_log_range(
    stream: &mut UnixStream,
    log_path: &Path,
    start_offset: u64,
    end_offset: u64,
) -> Result<()> {
    if end_offset <= start_offset {
        return Ok(());
    }

    let mut file = match OpenOptions::new().read(true).open(log_path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    file.seek(SeekFrom::Start(start_offset)).await?;

    let mut current_offset = start_offset;
    let mut buffer = vec![0_u8; DETACHED_STREAM_MAX_BATCH_BYTES.min(64 * 1024)];
    while current_offset < end_offset {
        let remaining = (end_offset - current_offset) as usize;
        let read_len = remaining.min(buffer.len());
        let read = file.read(&mut buffer[..read_len]).await?;
        if read == 0 {
            break;
        }
        write_detached_stream_frame(
            stream,
            DetachedPtyStreamFrameKind::Data,
            current_offset,
            &buffer[..read],
        )
        .await?;
        current_offset += read as u64;
    }

    stream.flush().await?;
    Ok(())
}

#[cfg(unix)]
async fn flush_detached_stream_batch(
    stream: &mut UnixStream,
    pending_offset: &mut Option<u64>,
    pending: &mut Vec<u8>,
) -> Result<()> {
    let Some(offset) = pending_offset.take() else {
        pending.clear();
        return Ok(());
    };
    if pending.is_empty() {
        return Ok(());
    }
    write_detached_stream_frame(stream, DetachedPtyStreamFrameKind::Data, offset, pending).await?;
    stream.flush().await?;
    pending.clear();
    Ok(())
}

#[cfg(unix)]
fn clone_detached_host_stream_sender(
    state: &DetachedHostState,
) -> Option<mpsc::Sender<DetachedPtyHostStreamMessage>> {
    state
        .stream_slot
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|slot| slot.tx.clone())
}

#[cfg(unix)]
async fn run_detached_capture_writer(
    log_path: PathBuf,
    mut rx: mpsc::Receiver<DetachedPtyHostCaptureMessage>,
) {
    let _ = async {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .await?;
        let mut writer = BufWriter::with_capacity(DETACHED_CAPTURE_BUFFER_CAPACITY, file);
        let mut pending_bytes = 0usize;
        let mut dirty = false;

        loop {
            tokio::select! {
                maybe_message = rx.recv() => {
                    let Some(message) = maybe_message else {
                        if dirty {
                            writer.flush().await?;
                        }
                        return Ok::<(), anyhow::Error>(());
                    };
                    match message {
                        DetachedPtyHostCaptureMessage::Data(chunk) => {
                            writer.write_all(&chunk.bytes).await?;
                            pending_bytes = pending_bytes.saturating_add(chunk.bytes.len());
                            dirty = true;
                            if pending_bytes >= DETACHED_CAPTURE_FORCE_FLUSH_BYTES {
                                writer.flush().await?;
                                pending_bytes = 0;
                                dirty = false;
                            }
                        }
                        DetachedPtyHostCaptureMessage::Flush { ack } => {
                            if dirty {
                                writer.flush().await?;
                                pending_bytes = 0;
                                dirty = false;
                            }
                            let _ = ack.send(());
                        }
                        DetachedPtyHostCaptureMessage::Shutdown => {
                            if dirty {
                                writer.flush().await?;
                            }
                            return Ok(());
                        }
                    }
                }
                _ = tokio::time::sleep(DETACHED_CAPTURE_FLUSH_INTERVAL), if dirty => {
                    writer.flush().await?;
                    pending_bytes = 0;
                    dirty = false;
                }
            }
        }
    }
    .await;
}

#[cfg(unix)]
async fn flush_detached_capture(
    capture_tx: &mpsc::Sender<DetachedPtyHostCaptureMessage>,
) -> Result<()> {
    let (ack_tx, ack_rx) = oneshot::channel();
    capture_tx
        .send(DetachedPtyHostCaptureMessage::Flush { ack: ack_tx })
        .await
        .map_err(|_| anyhow!("Detached PTY capture channel is unavailable"))?;
    ack_rx
        .await
        .map_err(|_| anyhow!("Detached PTY capture flush acknowledgement was dropped"))?;
    Ok(())
}

#[cfg(unix)]
async fn detached_log_len(log_path: &Path) -> Result<u64> {
    match tokio::fs::metadata(log_path).await {
        Ok(metadata) => Ok(metadata.len()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(err) => Err(err.into()),
    }
}

#[cfg(unix)]
async fn connect_detached_runtime_stream(
    metadata: &DetachedRuntimeMetadata,
    offset: u64,
) -> Result<UnixStream> {
    let stream_path = metadata
        .stream_socket_path
        .as_ref()
        .ok_or_else(|| anyhow!("Detached PTY stream socket is unavailable"))?;
    let mut stream = UnixStream::connect(stream_path).await?;
    let request = DetachedPtyHostStreamRequest {
        token: metadata.control_token.clone(),
        offset,
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;

    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Err(anyhow!("Detached PTY host closed the stream socket"));
    }
    let response = serde_json::from_slice::<DetachedPtyHostStreamResponse>(&line)?;
    if response.ok {
        Ok(reader.into_inner())
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "Detached PTY stream request failed".to_string()
        })))
    }
}

#[cfg(unix)]
async fn flush_detached_partial_line(
    output_tx: &mpsc::Sender<ExecutorOutput>,
    partial: &mut Vec<u8>,
) -> Result<()> {
    if partial.is_empty() {
        return Ok(());
    }
    let line = String::from_utf8_lossy(partial)
        .trim_end_matches('\r')
        .to_string();
    partial.clear();
    if line.is_empty() {
        return Ok(());
    }
    if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
        return Err(anyhow!("Detached runtime output receiver dropped"));
    }
    Ok(())
}

#[cfg(unix)]
async fn emit_detached_runtime_exit(
    state: &AppState,
    session_id: &str,
    output_tx: &mpsc::Sender<ExecutorOutput>,
    exit_code: i32,
) {
    state
        .emit_terminal_stream_event(session_id, TerminalStreamEvent::Exit(exit_code))
        .await;
    let event = if exit_code == 0 {
        ExecutorOutput::Completed { exit_code }
    } else {
        ExecutorOutput::Failed {
            error: format!("Process exited with code {exit_code}"),
            exit_code: Some(exit_code),
        }
    };
    let _ = output_tx.send(event).await;
}

#[cfg(unix)]
async fn emit_detached_runtime_error(
    state: &AppState,
    session_id: &str,
    output_tx: &mpsc::Sender<ExecutorOutput>,
    message: String,
    exit_code: Option<i32>,
) {
    state
        .emit_terminal_stream_event(session_id, TerminalStreamEvent::Error(message.clone()))
        .await;
    let _ = output_tx
        .send(ExecutorOutput::Failed {
            error: message,
            exit_code,
        })
        .await;
}

#[cfg(unix)]
async fn write_detached_stream_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    kind: DetachedPtyStreamFrameKind,
    offset: u64,
    payload: &[u8],
) -> Result<()> {
    if payload.len() > u32::MAX as usize {
        return Err(anyhow!(
            "Detached PTY stream payload is too large: {} bytes",
            payload.len()
        ));
    }
    writer.write_all(&[kind as u8]).await?;
    writer.write_all(&offset.to_be_bytes()).await?;
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await?;
    if !payload.is_empty() {
        writer.write_all(payload).await?;
    }
    Ok(())
}

#[cfg(unix)]
fn decode_detached_stream_frame_kind(value: u8) -> Result<DetachedPtyStreamFrameKind> {
    match value {
        1 => Ok(DetachedPtyStreamFrameKind::Data),
        2 => Ok(DetachedPtyStreamFrameKind::Exit),
        3 => Ok(DetachedPtyStreamFrameKind::Error),
        _ => Err(anyhow!(
            "Unsupported detached PTY stream frame kind: {value}"
        )),
    }
}

#[cfg(unix)]
fn decode_detached_exit_payload(payload: &[u8]) -> Result<i32> {
    if payload.len() != std::mem::size_of::<i32>() {
        return Err(anyhow!(
            "Detached PTY exit payload had invalid length: {}",
            payload.len()
        ));
    }
    Ok(i32::from_be_bytes(payload.try_into().unwrap()))
}

#[cfg(unix)]
async fn write_detached_host_input(
    writer: &Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    value: &str,
    logical_text: bool,
) -> Result<()> {
    let writer = writer.clone();
    let value = value.to_string();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut writer = writer.lock().unwrap_or_else(|error| error.into_inner());
        writer.write_all(value.as_bytes())?;
        if logical_text && !value.ends_with('\n') && !value.ends_with('\r') {
            writer.write_all(b"\r")?;
        }
        writer.flush()?;
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
async fn resize_detached_host(
    master: &Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let master = master.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut guard = master.lock().unwrap_or_else(|error| error.into_inner());
        let Some(master) = guard.as_mut() else {
            return Ok(());
        };
        master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
async fn kill_detached_host_child(
    child: &Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> Result<()> {
    let child = child.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
        #[cfg(unix)]
        {
            if let Some(pid) = child.process_id() {
                let _ = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
                for _ in 0..50 {
                    std::thread::sleep(Duration::from_millis(100));
                    if let Ok(Some(_)) = child.try_wait() {
                        return Ok(());
                    }
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
async fn wait_for_detached_child(
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> Result<i32> {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child = child.clone();
        match tokio::task::spawn_blocking(move || {
            let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
            child.try_wait()
        })
        .await
        {
            Ok(Ok(Some(status))) => return Ok(status.exit_code() as i32),
            Ok(Ok(None)) => continue,
            Ok(Err(error)) => return Err(error.into()),
            Err(error) => return Err(anyhow!(error.to_string())),
        }
    }
}

#[cfg(unix)]
fn detached_runtime_metadata(session: &SessionRecord) -> Option<DetachedRuntimeMetadata> {
    Some(DetachedRuntimeMetadata {
        host_pid: session.metadata.get("detachedPid")?.parse::<u32>().ok()?,
        control_socket_path: PathBuf::from(
            session
                .metadata
                .get(DETACHED_CONTROL_SOCKET_METADATA_KEY)?
                .clone(),
        ),
        stream_socket_path: session
            .metadata
            .get(DETACHED_STREAM_SOCKET_METADATA_KEY)
            .map(PathBuf::from),
        control_token: session
            .metadata
            .get(DETACHED_CONTROL_TOKEN_METADATA_KEY)?
            .clone(),
        log_path: PathBuf::from(
            session
                .metadata
                .get(DETACHED_LOG_PATH_METADATA_KEY)?
                .clone(),
        ),
        exit_path: PathBuf::from(
            session
                .metadata
                .get(DETACHED_EXIT_PATH_METADATA_KEY)?
                .clone(),
        ),
    })
}

#[cfg(unix)]
async fn ping_detached_runtime(
    metadata: &DetachedRuntimeMetadata,
) -> Result<Option<DetachedPtyHostResponse>> {
    match send_detached_runtime_request(metadata, DetachedPtyHostCommand::Ping).await {
        Ok(response) if response.ok => Ok(Some(response)),
        Ok(_) => Ok(None),
        Err(error) if detached_runtime_unreachable(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn detached_runtime_unreachable(error: &anyhow::Error) -> bool {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .map(|io_error| {
                matches!(
                    io_error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::AddrNotAvailable
                )
            })
            .unwrap_or(false)
    }) {
        return true;
    }

    let message = error.to_string();
    message.contains("Connection refused")
        || message.contains("failed to lookup address information")
        || message.contains("No route to host")
        || message.contains("No such file or directory")
}

#[cfg(unix)]
async fn send_detached_runtime_request(
    metadata: &DetachedRuntimeMetadata,
    command: DetachedPtyHostCommand,
) -> Result<DetachedPtyHostResponse> {
    let mut stream = UnixStream::connect(&metadata.control_socket_path).await?;
    let request = DetachedPtyHostRequest {
        token: metadata.control_token.clone(),
        command,
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Err(anyhow!("Detached PTY host closed the control socket"));
    }
    let response = serde_json::from_slice::<DetachedPtyHostResponse>(&line)?;
    if response.ok {
        Ok(response)
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "Detached PTY host request failed".to_string()
        })))
    }
}

fn detached_runtime_disabled() -> bool {
    !cfg!(unix)
        || std::env::var("CONDUCTOR_DISABLE_DETACHED_PTY_HOST")
            .map(|value| value.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(cfg!(test))
}

fn resolve_detached_runtime_launcher() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CONDUCTOR_PTY_HOST_LAUNCHER") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }

    let current = std::env::current_exe().ok()?;
    let current_name = current.file_stem()?.to_string_lossy();
    if current_name == "conductor" {
        return Some(current);
    }

    let parent = current.parent()?;
    if parent.file_name().and_then(|value| value.to_str()) == Some("deps") {
        let exe_name = if cfg!(windows) {
            "conductor.exe"
        } else {
            "conductor"
        };
        let candidate = parent.parent()?.join(exe_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn configure_detached_process_group(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

#[cfg(unix)]
async fn wait_for_detached_ready(path: &Path, timeout: Duration) -> Result<DetachedPtyHostReady> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::fs::read(path).await {
            Ok(bytes) => return Ok(serde_json::from_slice::<DetachedPtyHostReady>(&bytes)?),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "Detached PTY host did not become ready before timeout ({})",
                path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(unix)]
async fn read_detached_log_chunk(log_path: &Path, offset: u64) -> Result<Option<(u64, Vec<u8>)>> {
    let mut file = match OpenOptions::new().read(true).open(log_path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    file.seek(SeekFrom::Start(offset)).await?;
    let mut chunk = Vec::new();
    file.read_to_end(&mut chunk).await?;
    if chunk.is_empty() {
        return Ok(None);
    }
    Ok(Some((offset + chunk.len() as u64, chunk)))
}

#[cfg(unix)]
fn watch_detached_log(
    log_path: &Path,
) -> Result<(RecommendedWatcher, mpsc::UnboundedReceiver<()>)> {
    let watch_path = log_path.parent().unwrap_or(log_path).to_path_buf();
    let callback_path = log_path.to_path_buf();
    let (tx, rx) = mpsc::unbounded_channel();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| match res {
            Ok(event) => {
                if detached_log_event_matches(&callback_path, &event) {
                    let _ = tx.send(());
                }
            }
            Err(err) => {
                tracing::debug!(
                    path = %callback_path.display(),
                    error = %err,
                    "detached PTY log watcher callback error"
                );
            }
        },
        Config::default(),
    )?;
    watcher.watch(&watch_path, RecursiveMode::NonRecursive)?;
    Ok((watcher, rx))
}

#[cfg(unix)]
fn detached_log_event_matches(log_path: &Path, event: &Event) -> bool {
    if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
        return false;
    }

    let parent = log_path.parent();
    event.paths.iter().any(|path| {
        path == log_path
            || parent.map(|candidate| path == candidate).unwrap_or(false)
            || (path.parent().is_none() && path.file_name() == log_path.file_name())
    })
}

#[cfg(unix)]
fn split_detached_log_lines(partial: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    partial.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(index) = partial.iter().position(|byte| *byte == b'\n') {
        let line = partial.drain(..=index).collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&line)
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines
}

#[cfg(unix)]
async fn read_detached_exit_code(path: &Path) -> Result<Option<i32>> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.parse::<i32>().with_context(|| {
        format!("Invalid exit code '{trimmed}' in {}", path.display())
    })?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use conductor_core::config::ConductorConfig;
    use conductor_db::Database;
    use uuid::Uuid;

    #[test]
    fn detached_stream_frame_decoder_handles_partial_frames() {
        let payload = b"hello";
        let frame = {
            let mut bytes = Vec::new();
            bytes.push(DetachedPtyStreamFrameKind::Data as u8);
            bytes.extend_from_slice(&7_u64.to_be_bytes());
            bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            bytes.extend_from_slice(payload);
            bytes
        };

        let mut decoder = DetachedPtyStreamFrameDecoder::default();
        let first = decoder
            .push(&frame[..4])
            .expect("partial header should parse");
        assert!(first.is_empty());
        let second = decoder
            .push(&frame[4..9])
            .expect("remaining header should parse");
        assert!(second.is_empty());
        let final_frames = decoder
            .push(&frame[9..])
            .expect("payload should complete the frame");
        assert_eq!(
            final_frames,
            vec![DetachedPtyStreamFrame {
                kind: DetachedPtyStreamFrameKind::Data,
                offset: 7,
                payload: payload.to_vec(),
            }]
        );
    }

    #[tokio::test]
    async fn detached_pty_host_streams_replays_and_persists_output() {
        let root = std::env::temp_dir().join(format!(
            "conductor-detached-pty-host-test-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let spec_path = root.join("host-spec.json");
        let log_path = root.join("host.log");
        let exit_path = root.join("host.exit");
        let ready_path = root.join("host.ready.json");
        let control_socket_path = PathBuf::from(format!(
            "/tmp/co-detached-{}-ctrl.sock",
            Uuid::new_v4().simple()
        ));
        let stream_socket_path = PathBuf::from(format!(
            "/tmp/co-detached-{}-stream.sock",
            Uuid::new_v4().simple()
        ));
        let token = Uuid::new_v4().to_string();
        let spec = DetachedPtyHostSpec {
            token: token.clone(),
            binary: PathBuf::from("/bin/sh"),
            args: vec!["-lc".to_string(), "cat".to_string()],
            cwd: root.clone(),
            env: HashMap::new(),
            cols: 120,
            rows: 32,
            control_socket_path: control_socket_path.clone(),
            stream_socket_path: stream_socket_path.clone(),
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
            ready_path: ready_path.clone(),
        };
        tokio::fs::write(&spec_path, serde_json::to_vec(&spec).unwrap())
            .await
            .unwrap();

        let host_task = tokio::spawn(run_detached_pty_host(spec_path.clone()));
        let ready = match wait_for_detached_ready(&ready_path, DETACHED_READY_TIMEOUT).await {
            Ok(ready) => ready,
            Err(error) => {
                if host_task.is_finished() {
                    let joined = host_task.await.unwrap();
                    if joined
                        .as_ref()
                        .err()
                        .map(|err| {
                            err.chain().any(|cause| {
                                let message = cause.to_string();
                                message.contains("Operation not permitted")
                                    || message.contains("path must be shorter than SUN_LEN")
                            })
                        })
                        .unwrap_or(false)
                    {
                        return;
                    }
                    panic!("host failed before readiness: {joined:?}");
                }
                panic!("host should report readiness: {error}");
            }
        };
        let metadata = DetachedRuntimeMetadata {
            host_pid: ready.host_pid,
            control_socket_path,
            stream_socket_path: Some(stream_socket_path),
            control_token: token,
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
        };

        let ping = send_detached_runtime_request(&metadata, DetachedPtyHostCommand::Ping)
            .await
            .expect("ping should succeed");
        assert!(ping.ok);
        assert_eq!(ping.child_pid, Some(ready.child_pid));

        let mut stream = connect_detached_runtime_stream(&metadata, 0)
            .await
            .expect("stream should connect");

        send_detached_runtime_request(
            &metadata,
            DetachedPtyHostCommand::Text {
                text: "hello from host".to_string(),
            },
        )
        .await
        .expect("text should be accepted");

        let mut decoder = DetachedPtyStreamFrameDecoder::default();
        let first = read_next_stream_frame(&mut stream, &mut decoder)
            .await
            .expect("first frame should arrive");
        assert_eq!(first.kind, DetachedPtyStreamFrameKind::Data);
        assert!(String::from_utf8_lossy(&first.payload).contains("hello from host"));

        let first_end = first.offset + first.payload.len() as u64;
        drop(stream);

        send_detached_runtime_request(
            &metadata,
            DetachedPtyHostCommand::Text {
                text: "replayed line".to_string(),
            },
        )
        .await
        .expect("text should be accepted while detached");

        let mut replay_stream = connect_detached_runtime_stream(&metadata, first_end)
            .await
            .expect("replay stream should connect");
        let mut replay_decoder = DetachedPtyStreamFrameDecoder::default();
        let replayed = read_next_stream_frame(&mut replay_stream, &mut replay_decoder)
            .await
            .expect("replayed frame should arrive");
        assert_eq!(replayed.kind, DetachedPtyStreamFrameKind::Data);
        assert!(String::from_utf8_lossy(&replayed.payload).contains("replayed line"));

        let log_contents = wait_for_detached_log("detached host output", &log_path).await;
        assert!(log_contents.contains("hello from host"));
        assert!(log_contents.contains("replayed line"));

        send_detached_runtime_request(
            &metadata,
            DetachedPtyHostCommand::Resize {
                cols: 132,
                rows: 40,
            },
        )
        .await
        .expect("resize should be accepted");

        send_detached_runtime_request(&metadata, DetachedPtyHostCommand::Kill)
            .await
            .expect("kill should be accepted");

        let exit_frame = read_next_stream_frame(&mut replay_stream, &mut replay_decoder)
            .await
            .expect("exit frame should arrive");
        assert_eq!(exit_frame.kind, DetachedPtyStreamFrameKind::Exit);
        assert_ne!(
            decode_detached_exit_payload(&exit_frame.payload).expect("exit payload should decode"),
            i32::MIN
        );

        let exit_code = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(code) = read_detached_exit_code(&exit_path).await.unwrap() {
                    return code;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("host should write an exit code");
        assert_ne!(exit_code, i32::MIN);

        host_task
            .await
            .expect("host task should join")
            .expect("host should exit cleanly");

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn detached_replay_offset_uses_terminal_capture_length() {
        let root = std::env::temp_dir().join(format!(
            "conductor-detached-replay-offset-test-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let state = build_test_state(&root).await;

        state
            .emit_terminal_bytes("session-1", b"hello\r\nworld")
            .await;
        state.flush_terminal_capture("session-1").await;

        assert_eq!(state.detached_replay_offset("session-1").await, 12);

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn ping_detached_runtime_returns_none_for_missing_unix_socket() {
        let metadata = DetachedRuntimeMetadata {
            host_pid: 0,
            control_socket_path: PathBuf::from(format!(
                "/tmp/co-detached-{}-missing-ctrl.sock",
                Uuid::new_v4().simple()
            )),
            stream_socket_path: Some(PathBuf::from(format!(
                "/tmp/co-detached-{}-missing-stream.sock",
                Uuid::new_v4().simple()
            ))),
            control_token: Uuid::new_v4().to_string(),
            log_path: PathBuf::from(format!(
                "/tmp/co-detached-{}-missing.log",
                Uuid::new_v4().simple()
            )),
            exit_path: PathBuf::from(format!(
                "/tmp/co-detached-{}-missing.exit",
                Uuid::new_v4().simple()
            )),
        };

        assert!(ping_detached_runtime(&metadata)
            .await
            .expect("missing detached runtime socket should not error")
            .is_none());
    }

    async fn read_next_stream_frame(
        stream: &mut UnixStream,
        decoder: &mut DetachedPtyStreamFrameDecoder,
    ) -> Result<DetachedPtyStreamFrame> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut buffer = [0_u8; 8192];
            loop {
                let read = stream.read(&mut buffer).await?;
                if read == 0 {
                    return Err(anyhow!("detached PTY stream closed"));
                }
                let mut frames = decoder.push(&buffer[..read])?;
                if !frames.is_empty() {
                    return Ok(frames.remove(0));
                }
            }
        })
        .await
        .map_err(|_| anyhow!("timed out waiting for detached PTY stream frame"))?
    }

    async fn wait_for_detached_log(label: &str, path: &Path) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match tokio::fs::read_to_string(path).await {
                    Ok(content) if !content.trim().is_empty() => return content,
                    _ => tokio::time::sleep(Duration::from_millis(25)).await,
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
    }

    async fn build_test_state(root: &Path) -> Arc<AppState> {
        let config = ConductorConfig {
            workspace: root.to_path_buf(),
            ..ConductorConfig::default()
        };
        AppState::new(
            root.join("conductor.yaml"),
            config,
            Database::in_memory().await.unwrap(),
        )
        .await
    }
}
