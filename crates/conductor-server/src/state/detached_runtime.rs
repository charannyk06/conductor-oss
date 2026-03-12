use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use conductor_executors::executor::{
    Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions,
};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Notify};

use super::tmux_runtime::RuntimeLaunch;
use super::types::TerminalStreamEvent;
use crate::state::{AppState, OutputConsumerConfig, SessionRecord, SessionStatus};

pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
pub(crate) const DETACHED_CONTROL_PORT_METADATA_KEY: &str = "detachedControlPort";
pub(crate) const DETACHED_CONTROL_TOKEN_METADATA_KEY: &str = "detachedControlToken";
pub(crate) const DETACHED_LOG_PATH_METADATA_KEY: &str = "detachedLogPath";
pub(crate) const DETACHED_EXIT_PATH_METADATA_KEY: &str = "detachedExitPath";
pub(crate) const DETACHED_LOG_OFFSET_METADATA_KEY: &str = "detachedLogOffset";
const DETACHED_READY_TIMEOUT: Duration = Duration::from_secs(5);
const DETACHED_LOG_WATCH_FALLBACK_INTERVAL: Duration = Duration::from_millis(250);
const DETACHED_EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

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
    pub log_path: PathBuf,
    pub exit_path: PathBuf,
    pub ready_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedPtyHostReady {
    pub host_pid: u32,
    pub child_pid: u32,
    pub control_port: u16,
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

#[derive(Debug, Clone)]
struct DetachedRuntimeMetadata {
    host_pid: u32,
    control_port: u16,
    control_token: String,
    log_path: PathBuf,
    exit_path: PathBuf,
    log_offset: u64,
}

struct DetachedRuntimeAttachment {
    kind: conductor_core::types::AgentKind,
    session_id: String,
    child_pid: u32,
    metadata: DetachedRuntimeMetadata,
}

struct DetachedOutputForwarder {
    session_id: String,
    host_pid: u32,
    log_path: PathBuf,
    exit_path: PathBuf,
    offset: u64,
}

struct DetachedHostState {
    token: String,
    child_pid: u32,
    writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

pub async fn run_detached_pty_host(spec_path: PathBuf) -> Result<()> {
    let spec = serde_json::from_slice::<DetachedPtyHostSpec>(&tokio::fs::read(&spec_path).await?)
        .with_context(|| format!("Failed to parse detached PTY spec {}", spec_path.display()))?;

    if let Some(parent) = spec.log_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.exit_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.ready_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::remove_file(&spec.log_path).await;
    let _ = tokio::fs::remove_file(&spec.exit_path).await;
    let _ = tokio::fs::remove_file(&spec.ready_path).await;

    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .await
        .context("Failed to bind detached PTY control listener")?;
    let control_port = listener
        .local_addr()
        .context("Detached PTY control listener has no local address")?
        .port();

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

    let log_path = spec.log_path.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut log_file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(file) => file,
            Err(_) => return,
        };
        let mut buffer = [0_u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => {
                    let _ = std::io::Write::flush(&mut log_file);
                    break;
                }
                Ok(read) => {
                    if std::io::Write::write_all(&mut log_file, &buffer[..read]).is_err() {
                        break;
                    }
                    if std::io::Write::flush(&mut log_file).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let ready = DetachedPtyHostReady {
        host_pid: std::process::id(),
        child_pid,
        control_port,
    };
    tokio::fs::write(&spec.ready_path, serde_json::to_vec(&ready)?).await?;

    let shared = Arc::new(DetachedHostState {
        token: spec.token.clone(),
        child_pid,
        writer,
        master,
        child,
    });
    let shutdown = Arc::new(Notify::new());
    let shutdown_for_wait = shutdown.clone();
    let exit_path = spec.exit_path.clone();
    let child_for_wait = shared.child.clone();
    let master_for_cleanup = shared.master.clone();
    tokio::spawn(async move {
        let result = wait_for_detached_child(child_for_wait).await;
        if let Ok(mut guard) = master_for_cleanup.lock() {
            guard.take();
        }
        let exit_code = result.unwrap_or(-1);
        let _ = tokio::fs::write(&exit_path, exit_code.to_string()).await;
        shutdown_for_wait.notify_waiters();
    });

    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _ = handle_detached_host_connection(stream, shared).await;
                });
            }
        }
    }

    Ok(())
}

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
        let spec_path = runtime_root.join(format!("{session_id}.spec.json"));
        let ready_path = runtime_root.join(format!("{session_id}.ready.json"));
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
                host_pid: if ready.host_pid > 0 { ready.host_pid } else { host_pid },
                control_port: ready.control_port,
                control_token: control_token.clone(),
                log_path: log_path.clone(),
                exit_path: exit_path.clone(),
                log_offset: 0,
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
                    DETACHED_CONTROL_PORT_METADATA_KEY.to_string(),
                    ready.control_port.to_string(),
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
                (DETACHED_LOG_OFFSET_METADATA_KEY.to_string(), "0".to_string()),
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
                current
                    .metadata
                    .insert("summary".to_string(), current.summary.clone().unwrap_or_default());
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

    pub(crate) async fn update_detached_log_offset(&self, session_id: &str, offset: u64) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        let next = offset.to_string();
        if session
            .metadata
            .get(DETACHED_LOG_OFFSET_METADATA_KEY)
            .map(|value| value == &next)
            .unwrap_or(false)
        {
            return Ok(());
        }

        session
            .metadata
            .insert(DETACHED_LOG_OFFSET_METADATA_KEY.to_string(), next);
        let updated = session.clone();
        drop(sessions);
        self.persist_session(&updated).await
    }

    pub(crate) async fn kill_detached_runtime(&self, session_id: &str) -> Result<bool> {
        let Some(session) = self.get_session(session_id).await else {
            return Ok(false);
        };
        let Some(metadata) = detached_runtime_metadata(&session) else {
            return Ok(false);
        };
        let response = send_detached_runtime_request(
            &metadata,
            DetachedPtyHostCommand::Kill,
        )
        .await?;
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
        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
        let (resize_tx, mut resize_rx) = mpsc::channel::<conductor_executors::process::PtyDimensions>(8);
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        let metadata_for_input = metadata.clone();
        let session_id_for_input = session_id.clone();
        tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                let command = match input {
                    ExecutorInput::Text(text) => DetachedPtyHostCommand::Text { text },
                    ExecutorInput::Raw(raw) => DetachedPtyHostCommand::Raw { data: raw },
                };
                if let Err(err) = send_detached_runtime_request(&metadata_for_input, command).await {
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
            let _ = send_detached_runtime_request(&metadata_for_kill, DetachedPtyHostCommand::Kill).await;
        });

        let state = self.clone();
        tokio::spawn(async move {
            if let Err(err) = state
                .forward_detached_output(
                    DetachedOutputForwarder {
                        session_id: session_id.clone(),
                        host_pid: metadata.host_pid,
                        log_path: metadata.log_path.clone(),
                        exit_path: metadata.exit_path.clone(),
                        offset: metadata.log_offset,
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
        let DetachedOutputForwarder {
            session_id,
            host_pid,
            log_path,
            exit_path,
            mut offset,
        } = forwarder;
        let (_watcher, mut log_events) = watch_detached_log(&log_path)?;
        let mut partial = Vec::new();
        let mut exit_deadline = None;

        loop {
            if let Some((next_offset, chunk)) = read_detached_log_chunk(&log_path, offset).await? {
                self.emit_terminal_bytes(&session_id, &chunk).await;
                let lines = split_detached_log_lines(&mut partial, &chunk);
                for line in lines {
                    if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                        return Ok(());
                    }
                }
                offset = next_offset;
                self.update_detached_log_offset(&session_id, offset).await?;
            }

            if !crate::state::workspace::is_process_alive(host_pid) {
                let deadline = exit_deadline.get_or_insert_with(|| {
                    tokio::time::Instant::now() + DETACHED_EXIT_WAIT_TIMEOUT
                });
                if !partial.is_empty() {
                    let line = String::from_utf8_lossy(&partial)
                        .trim_end_matches('\r')
                        .to_string();
                    partial.clear();
                    if !line.is_empty() && output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                        return Ok(());
                    }
                }

                if let Some(exit_code) = read_detached_exit_code(&exit_path).await? {
                    self.emit_terminal_stream_event(
                        &session_id,
                        TerminalStreamEvent::Exit(exit_code),
                    )
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
                    return Ok(());
                }

                if tokio::time::Instant::now() >= *deadline {
                    self.emit_terminal_stream_event(
                        &session_id,
                        TerminalStreamEvent::Error(
                            "Detached PTY runtime exited unexpectedly".to_string(),
                        ),
                    )
                    .await;
                    let _ = output_tx
                        .send(ExecutorOutput::Failed {
                            error: "Detached PTY runtime exited unexpectedly".to_string(),
                            exit_code: None,
                        })
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

async fn handle_detached_host_connection(
    stream: TcpStream,
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

fn detached_runtime_metadata(session: &SessionRecord) -> Option<DetachedRuntimeMetadata> {
    Some(DetachedRuntimeMetadata {
        host_pid: session
            .metadata
            .get("detachedPid")?
            .parse::<u32>()
            .ok()?,
        control_port: session
            .metadata
            .get(DETACHED_CONTROL_PORT_METADATA_KEY)?
            .parse::<u16>()
            .ok()?,
        control_token: session
            .metadata
            .get(DETACHED_CONTROL_TOKEN_METADATA_KEY)?
            .clone(),
        log_path: PathBuf::from(session.metadata.get(DETACHED_LOG_PATH_METADATA_KEY)?.clone()),
        exit_path: PathBuf::from(session.metadata.get(DETACHED_EXIT_PATH_METADATA_KEY)?.clone()),
        log_offset: session
            .metadata
            .get(DETACHED_LOG_OFFSET_METADATA_KEY)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
    })
}

async fn ping_detached_runtime(
    metadata: &DetachedRuntimeMetadata,
) -> Result<Option<DetachedPtyHostResponse>> {
    match send_detached_runtime_request(metadata, DetachedPtyHostCommand::Ping).await {
        Ok(response) if response.ok => Ok(Some(response)),
        Ok(_) => Ok(None),
        Err(error) => {
            if error
                .to_string()
                .contains("Connection refused")
                || error.to_string().contains("failed to lookup address information")
                || error.to_string().contains("No route to host")
            {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

async fn send_detached_runtime_request(
    metadata: &DetachedRuntimeMetadata,
    command: DetachedPtyHostCommand,
) -> Result<DetachedPtyHostResponse> {
    let mut stream =
        TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, metadata.control_port)).await?;
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
        Err(anyhow!(
            response
                .error
                .unwrap_or_else(|| "Detached PTY host request failed".to_string())
        ))
    }
}

fn detached_runtime_disabled() -> bool {
    std::env::var("CONDUCTOR_DISABLE_DETACHED_PTY_HOST")
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
}

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

async fn read_detached_log_chunk(log_path: &Path, offset: u64) -> Result<Option<(u64, Vec<u8>)>> {
    let mut file = match tokio::fs::OpenOptions::new()
        .read(true)
        .open(log_path)
        .await
    {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut chunk = Vec::new();
    file.read_to_end(&mut chunk).await?;
    if chunk.is_empty() {
        return Ok(None);
    }
    Ok(Some((offset + chunk.len() as u64, chunk)))
}

fn watch_detached_log(log_path: &Path) -> Result<(RecommendedWatcher, mpsc::UnboundedReceiver<()>)> {
    let watch_path = log_path.parent().unwrap_or(log_path).to_path_buf();
    let target_log_path = log_path.to_path_buf();
    let callback_path = target_log_path.clone();
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
    Ok(Some(
        trimmed
            .parse::<i32>()
            .with_context(|| format!("Invalid exit code '{trimmed}' in {}", path.display()))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn detached_pty_host_accepts_control_commands_and_persists_output() {
        let root = std::env::temp_dir().join(format!(
            "conductor-detached-pty-host-test-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let spec_path = root.join("host-spec.json");
        let log_path = root.join("host.log");
        let exit_path = root.join("host.exit");
        let ready_path = root.join("host.ready.json");
        let token = Uuid::new_v4().to_string();
        let spec = DetachedPtyHostSpec {
            token: token.clone(),
            binary: PathBuf::from("/bin/sh"),
            args: vec!["-lc".to_string(), "cat".to_string()],
            cwd: root.clone(),
            env: HashMap::new(),
            cols: 120,
            rows: 32,
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
            ready_path: ready_path.clone(),
        };
        tokio::fs::write(&spec_path, serde_json::to_vec(&spec).unwrap())
            .await
            .unwrap();

        let host_task = tokio::spawn(run_detached_pty_host(spec_path.clone()));
        let ready = wait_for_detached_ready(&ready_path, DETACHED_READY_TIMEOUT)
            .await
            .expect("host should report readiness");
        let metadata = DetachedRuntimeMetadata {
            host_pid: ready.host_pid,
            control_port: ready.control_port,
            control_token: token,
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
            log_offset: 0,
        };

        let ping = send_detached_runtime_request(&metadata, DetachedPtyHostCommand::Ping)
            .await
            .expect("ping should succeed");
        assert!(ping.ok);
        assert_eq!(ping.child_pid, Some(ready.child_pid));

        send_detached_runtime_request(
            &metadata,
            DetachedPtyHostCommand::Text {
                text: "hello from host".to_string(),
            },
        )
        .await
        .expect("text should be accepted");

        let log_contents = wait_for_detached_log("detached host output", &log_path).await;
        assert!(log_contents.contains("hello from host"));

        send_detached_runtime_request(
            &metadata,
            DetachedPtyHostCommand::Resize { cols: 132, rows: 40 },
        )
        .await
        .expect("resize should be accepted");

        send_detached_runtime_request(&metadata, DetachedPtyHostCommand::Kill)
            .await
            .expect("kill should be accepted");

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
}
