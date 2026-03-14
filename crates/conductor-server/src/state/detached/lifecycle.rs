#[cfg(unix)]
use anyhow::Context;
use anyhow::{anyhow, Result};
use conductor_executors::executor::{Executor, ExecutorHandle, SpawnOptions};
#[cfg(unix)]
use conductor_executors::executor::{ExecutorInput, ExecutorOutput};
#[cfg(unix)]
use chrono::Utc;
#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio::sync::{mpsc, oneshot};

#[cfg(unix)]
use super::control::{
    coalesce_detached_input_commands, run_detached_runtime_control_queue,
    send_detached_runtime_request,
};
#[cfg(unix)]
use super::daemon::{resolve_terminal_daemon_metadata, spawn_detached_runtime_via_daemon};
#[cfg(unix)]
use super::helpers::{
    configure_detached_process_group, detached_runtime_disabled, ensure_detached_protocol_version,
    detached_runtime_metadata, ping_detached_runtime, prepare_detached_runtime_env,
    read_detached_exit_code, resolve_detached_runtime_launcher, wait_for_detached_ready,
};
use super::types::{
    DIRECT_RUNTIME_MODE, RUNTIME_MODE_METADATA_KEY,
};
#[cfg(unix)]
use super::types::*;
use crate::state::AppState;
#[cfg(unix)]
use crate::state::{OutputConsumerConfig, SessionRecord};

use super::RuntimeLaunch;

#[cfg(unix)]
impl AppState {
    pub(crate) async fn spawn_detached_runtime_or_legacy(
        self: &Arc<Self>,
        executor: Arc<dyn Executor>,
        session_id: &str,
        mut options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        if detached_runtime_disabled() {
            return self.spawn_legacy_direct_runtime(executor, options).await;
        }
        options.interactive = executor.supports_direct_terminal_ui();
        options.structured_output = false;
        prepare_detached_runtime_env(executor.kind(), options.interactive, &mut options.env);
        let _spawn_permit = self
            .acquire_detached_runtime_spawn_limit()
            .acquire_owned()
            .await
            .map_err(|_| anyhow!("Detached runtime spawn semaphore was closed"))?;

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
            protocol_version: DETACHED_PTY_PROTOCOL_VERSION,
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
            stream_flush_interval_ms: detached_stream_flush_interval_ms(),
            stream_max_batch_bytes: detached_stream_max_batch_bytes(),
            isolation_mode: None,
        };
        tokio::fs::write(&spec_path, serde_json::to_vec(&spec)?).await?;

        let daemon_metadata = resolve_terminal_daemon_metadata();
        let (ready, host_pid) = match spawn_detached_runtime_via_daemon(
            daemon_metadata.as_ref(),
            session_id,
            &spec_path,
            &ready_path,
        )
        .await
        {
            Ok(Some((ready, host_pid))) => (ready, host_pid),
            Ok(None) => {
                let Some(launcher_path) = resolve_detached_runtime_launcher() else {
                    tracing::warn!("Detached PTY host launcher is unavailable; falling back to in-process direct runtime");
                    return self.spawn_legacy_direct_runtime(executor, options).await;
                };
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
                (ready, host_pid)
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&spec_path).await;
                let _ = tokio::fs::remove_file(&ready_path).await;
                return Err(err);
            }
        };
        ensure_detached_protocol_version(ready.protocol_version)?;
        let attachment = DetachedRuntimeAttachment {
            kind: executor.kind(),
            session_id: session_id.to_string(),
            child_pid: ready.child_pid,
            metadata: DetachedRuntimeMetadata {
                protocol_version: ready.protocol_version,
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
            start_offset: 0,
        };
        let handle = self.attach_detached_runtime_handle(attachment).await?;
        let _ = tokio::fs::remove_file(&spec_path).await;
        let _ = tokio::fs::remove_file(&ready_path).await;

        Ok(RuntimeLaunch {
            handle,
            metadata: HashMap::from([
                (
                    RUNTIME_MODE_METADATA_KEY.to_string(),
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
                (
                    DETACHED_PROTOCOL_VERSION_METADATA_KEY.to_string(),
                    DETACHED_PTY_PROTOCOL_VERSION.to_string(),
                ),
                (
                    DETACHED_TRANSPORT_METADATA_KEY.to_string(),
                    DETACHED_PTY_TRANSPORT.to_string(),
                ),
                (
                    DETACHED_EMULATOR_METADATA_KEY.to_string(),
                    DETACHED_PTY_TERMINAL_EMULATOR.to_string(),
                ),
                (
                    DETACHED_BACKPRESSURE_METADATA_KEY.to_string(),
                    DETACHED_PTY_BACKPRESSURE_MODE.to_string(),
                ),
                (
                    DETACHED_BATCH_INTERVAL_METADATA_KEY.to_string(),
                    detached_stream_flush_interval_ms().to_string(),
                ),
                (
                    DETACHED_BATCH_BYTES_METADATA_KEY.to_string(),
                    detached_stream_max_batch_bytes().to_string(),
                ),
                (
                    DETACHED_ISOLATION_METADATA_KEY.to_string(),
                    DETACHED_PTY_ISOLATION_MODE.to_string(),
                ),
                (
                    DETACHED_OUTPUT_OFFSET_METADATA_KEY.to_string(),
                    "0".to_string(),
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
        let Some(mut metadata) = detached_runtime_metadata(&session) else {
            return Ok(());
        };
        // For sessions restored from older metadata that predates stream_socket_path
        // being persisted, attempt to infer the expected socket path so the stream
        // transport is tried before falling back to log-tail.
        if metadata.stream_socket_path.is_none() {
            let (_, inferred_stream_path) = self.detached_socket_paths(session_id);
            metadata.stream_socket_path = Some(inferred_stream_path);
        }
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
                current.status = crate::state::SessionStatus::Stuck;
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
                start_offset: Self::detached_output_offset(&session),
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
                crate::state::SessionStatus::NeedsInput => Some("waiting_input".to_string()),
                crate::state::SessionStatus::Queued => Some("idle".to_string()),
                _ => Some("active".to_string()),
            };
            if current.status == crate::state::SessionStatus::Spawning {
                current.status = crate::state::SessionStatus::Working;
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

    pub(super) fn detached_socket_paths(&self, session_id: &str) -> (PathBuf, PathBuf) {
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

    pub(super) fn detached_output_offset(session: &SessionRecord) -> u64 {
        session
            .metadata
            .get(DETACHED_OUTPUT_OFFSET_METADATA_KEY)
            .and_then(|value| value.parse::<u64>().ok())
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
        if response.ok {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(response.ok)
    }

    pub(super) async fn spawn_legacy_direct_runtime(
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
                RUNTIME_MODE_METADATA_KEY.to_string(),
                DIRECT_RUNTIME_MODE.to_string(),
            )]),
        })
    }

    pub(super) async fn attach_detached_runtime_handle(
        self: &Arc<Self>,
        attachment: DetachedRuntimeAttachment,
    ) -> Result<ExecutorHandle> {
        let DetachedRuntimeAttachment {
            kind,
            session_id,
            child_pid,
            metadata,
            start_offset,
        } = attachment;
        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
        let (resize_tx, mut resize_rx) =
            mpsc::channel::<conductor_executors::process::PtyDimensions>(8);
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        let (control_tx, control_rx) = mpsc::channel::<DetachedPtyHostCommand>(256);
        let metadata_for_control = metadata.clone();
        let session_id_for_control = session_id.clone();
        tokio::spawn(async move {
            run_detached_runtime_control_queue(
                metadata_for_control,
                session_id_for_control,
                control_rx,
            )
            .await;
        });

        let control_tx_for_input = control_tx.clone();
        tokio::spawn(async move {
            while let Some(first) = input_rx.recv().await {
                let mut batch = vec![first];
                while batch.len() < DETACHED_INPUT_BATCH_MAX_ITEMS {
                    match input_rx.try_recv() {
                        Ok(next) => batch.push(next),
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                    }
                }

                for command in coalesce_detached_input_commands(batch) {
                    if control_tx_for_input.send(command).await.is_err() {
                        return;
                    }
                }
            }
        });

        let control_tx_for_resize = control_tx.clone();
        tokio::spawn(async move {
            while let Some(mut dimensions) = resize_rx.recv().await {
                while let Ok(next) = resize_rx.try_recv() {
                    dimensions = next;
                }
                if control_tx_for_resize
                    .send(DetachedPtyHostCommand::Resize {
                        cols: dimensions.cols,
                        rows: dimensions.rows,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });

        tokio::spawn(async move {
            if kill_rx.try_recv().is_ok() {
                return;
            }
            let _ = kill_rx.await;
            let _ = control_tx.send(DetachedPtyHostCommand::Kill).await;
        });

        let state = self.clone();
        tokio::spawn(async move {
            if let Err(err) = state
                .forward_detached_output(
                    DetachedOutputForwarder {
                        session_id: session_id.clone(),
                        metadata,
                        offset: start_offset,
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
                RUNTIME_MODE_METADATA_KEY.to_string(),
                DIRECT_RUNTIME_MODE.to_string(),
            )]),
        })
    }
}
