mod control;
mod daemon;
pub(crate) mod emulator;
mod frame;
pub(crate) mod helpers;
mod lifecycle;
mod log_tail;
mod stream;
#[cfg(test)]
mod tests;
pub mod types;

use anyhow::Result;
#[cfg(unix)]
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
#[cfg(unix)]
use base64::Engine as _;
use conductor_executors::executor::{Executor, ExecutorHandle, SpawnOptions};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::state::{AppState, SessionRecord, TerminalRestoreSnapshot};

#[cfg(unix)]
pub(crate) use daemon::{resolve_terminal_daemon_metadata, TerminalDaemonManager};
pub(crate) use types::DIRECT_RUNTIME_MODE;
pub(crate) use types::{TerminalRuntimeAuthority, TerminalRuntimeState, TerminalRuntimeStatus};

// Re-export constants used in this file's impl AppState methods
use types::RUNTIME_MODE_METADATA_KEY;

pub(crate) struct RuntimeLaunch {
    pub(crate) handle: ExecutorHandle,
    pub(crate) metadata: HashMap<String, String>,
}

#[allow(dead_code)]
pub(crate) struct DetachedRuntimeReplayData {
    pub(crate) bytes: Vec<u8>,
    pub(crate) start_offset: u64,
    pub(crate) end_offset: u64,
    pub(crate) truncated: bool,
}

pub(crate) enum DetachedRuntimeCheckpointData {
    RestoreSnapshot {
        snapshot: TerminalRestoreSnapshot,
        output_offset: Option<u64>,
    },
    ReplayTail {
        replay: DetachedRuntimeReplayData,
        cols: u16,
        rows: u16,
    },
}

impl AppState {
    #[cfg(unix)]
    pub(crate) async fn resolve_detached_runtime_checkpoint(
        &self,
        session: &SessionRecord,
        max_bytes: usize,
    ) -> Result<Option<DetachedRuntimeCheckpointData>> {
        use helpers::{detached_runtime_unreachable, resolve_detached_runtime_checkpoint_path};

        let daemon_session = if let Some(daemon) = self.terminal_daemon() {
            match daemon.remote_session(&session.id).await {
                Ok(session) => session,
                Err(error) if detached_runtime_unreachable(&error) => None,
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to query terminal daemon session metadata for detached checkpoint recovery"
                    );
                    None
                }
            }
        } else {
            None
        };

        if let Some(daemon) = self.terminal_daemon() {
            let checkpoint = match daemon
                .remote_session_checkpoint(&session.id, max_bytes)
                .await
            {
                Ok(checkpoint) => checkpoint,
                Err(error) if detached_runtime_unreachable(&error) => None,
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to query terminal daemon checkpoint payload; falling back to local checkpoint reconstruction"
                    );
                    None
                }
            };

            if let Some(checkpoint) = checkpoint {
                if let Some(snapshot) = checkpoint.restore_snapshot {
                    if !snapshot.is_empty() {
                        return Ok(Some(DetachedRuntimeCheckpointData::RestoreSnapshot {
                            snapshot,
                            output_offset: checkpoint.output_offset,
                        }));
                    }
                }

                let bytes = BASE64_STANDARD.decode(checkpoint.bytes_base64.as_bytes())?;
                if !bytes.is_empty() {
                    return Ok(Some(DetachedRuntimeCheckpointData::ReplayTail {
                        replay: DetachedRuntimeReplayData {
                            bytes,
                            start_offset: checkpoint.start_offset,
                            end_offset: checkpoint.end_offset,
                            truncated: checkpoint.truncated,
                        },
                        cols: checkpoint.cols.max(1),
                        rows: checkpoint.rows.max(1),
                    }));
                }
            }
        }

        if let Some(path) =
            resolve_detached_runtime_checkpoint_path(session, daemon_session.as_ref()).await?
        {
            if let Some(checkpoint) = Self::read_checkpoint_from_path(&path).await? {
                if !checkpoint.restore_snapshot.is_empty() {
                    return Ok(Some(DetachedRuntimeCheckpointData::RestoreSnapshot {
                        output_offset: Some(checkpoint.output_offset),
                        snapshot: checkpoint.restore_snapshot,
                    }));
                }
            }
        }

        let Some(replay) = self
            .resolve_detached_runtime_replay_bytes(session, max_bytes)
            .await?
        else {
            return Ok(None);
        };
        let (cols, rows) = self
            .resolve_detached_runtime_replay_dimensions(session)
            .await;
        Ok(Some(DetachedRuntimeCheckpointData::ReplayTail {
            replay,
            cols,
            rows,
        }))
    }

    #[cfg(not(unix))]
    pub(crate) async fn resolve_detached_runtime_checkpoint(
        &self,
        _session: &SessionRecord,
        _max_bytes: usize,
    ) -> Result<Option<DetachedRuntimeCheckpointData>> {
        Ok(None)
    }

    #[cfg(unix)]
    pub(crate) async fn resolve_detached_runtime_replay_bytes(
        &self,
        session: &SessionRecord,
        max_bytes: usize,
    ) -> Result<Option<DetachedRuntimeReplayData>> {
        use helpers::detached_runtime_unreachable;

        if let Some(daemon) = self.terminal_daemon() {
            let replay = match daemon.remote_session_replay(&session.id, max_bytes).await {
                Ok(replay) => replay,
                Err(error) if detached_runtime_unreachable(&error) => None,
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to query terminal daemon replay payload; falling back to local detached log"
                    );
                    None
                }
            };

            if let Some(replay) = replay {
                let bytes = BASE64_STANDARD.decode(replay.bytes_base64.as_bytes())?;
                if !bytes.is_empty() {
                    return Ok(Some(DetachedRuntimeReplayData {
                        bytes,
                        start_offset: replay.start_offset,
                        end_offset: replay.end_offset,
                        truncated: replay.truncated,
                    }));
                }
            }
        }

        let Some(path) = self.resolve_detached_runtime_log_path(session).await? else {
            return Ok(None);
        };
        Self::read_replay_bytes_from_path(&path, max_bytes).await
    }

    #[cfg(not(unix))]
    pub(crate) async fn resolve_detached_runtime_replay_bytes(
        &self,
        _session: &SessionRecord,
        _max_bytes: usize,
    ) -> Result<Option<DetachedRuntimeReplayData>> {
        Ok(None)
    }

    #[cfg(unix)]
    pub(crate) async fn resolve_detached_runtime_replay_dimensions(
        &self,
        session: &SessionRecord,
    ) -> (u16, u16) {
        use helpers::detached_runtime_unreachable;

        let daemon_session = match self.terminal_daemon() {
            Some(daemon) => match daemon.remote_session(&session.id).await {
                Ok(session) => session,
                Err(error) if detached_runtime_unreachable(&error) => None,
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to query terminal daemon session metadata for detached replay dimensions; using defaults"
                    );
                    None
                }
            },
            None => None,
        };

        if let Some(info) = daemon_session.as_ref() {
            if let (Some(cols), Some(rows)) = (info.cols, info.rows) {
                return (cols.max(1), rows.max(1));
            }
        }

        (
            crate::state::DEFAULT_TERMINAL_COLS,
            crate::state::DEFAULT_TERMINAL_ROWS,
        )
    }

    #[cfg(not(unix))]
    pub(crate) async fn resolve_detached_runtime_replay_dimensions(
        &self,
        _session: &SessionRecord,
    ) -> (u16, u16) {
        (
            crate::state::DEFAULT_TERMINAL_COLS,
            crate::state::DEFAULT_TERMINAL_ROWS,
        )
    }

    #[cfg(unix)]
    pub(crate) async fn resolve_detached_runtime_log_path(
        &self,
        session: &SessionRecord,
    ) -> Result<Option<PathBuf>> {
        use helpers::{detached_runtime_unreachable, resolve_detached_runtime_log_path};

        let daemon_session = match self.terminal_daemon() {
            Some(daemon) => match daemon.remote_session(&session.id).await {
                Ok(session) => session,
                Err(error) if detached_runtime_unreachable(&error) => {
                    tracing::debug!(
                        session_id = session.id,
                        error = %error,
                        "Terminal daemon session lookup is unreachable; falling back to persisted detached log path metadata"
                    );
                    None
                }
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to query terminal daemon session metadata for detached log path; using persisted metadata"
                    );
                    None
                }
            },
            None => None,
        };

        resolve_detached_runtime_log_path(session, daemon_session.as_ref()).await
    }

    #[cfg(not(unix))]
    pub(crate) async fn resolve_detached_runtime_log_path(
        &self,
        _session: &SessionRecord,
    ) -> Result<Option<PathBuf>> {
        Ok(None)
    }

    pub(crate) async fn spawn_with_runtime(
        self: &Arc<Self>,
        _project: &conductor_core::config::ProjectConfig,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        self.spawn_detached_runtime_or_legacy(executor, session_id, options)
            .await
    }

    pub(crate) async fn restore_runtime_sessions(self: &Arc<Self>) {
        let session_ids = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| !session.status.is_terminal())
                .filter(|session| {
                    session
                        .metadata
                        .get(RUNTIME_MODE_METADATA_KEY)
                        .map(|value| value == DIRECT_RUNTIME_MODE)
                        .unwrap_or(false)
                })
                .map(|session| session.id.clone())
                .collect::<Vec<_>>()
        };

        for session_id in session_ids {
            if let Err(err) = self.restore_detached_runtime(&session_id).await {
                tracing::warn!(session_id, error = %err, "Failed to restore runtime session");
            }
        }
    }

    pub(crate) async fn ensure_session_live(self: &Arc<Self>, session_id: &str) -> Result<bool> {
        if self.terminal_runtime_attached(session_id).await {
            return Ok(true);
        }

        let Some(session) = self.get_session(session_id).await else {
            return Ok(false);
        };

        if matches!(
            session.status,
            crate::state::SessionStatus::Archived | crate::state::SessionStatus::Killed
        ) {
            return Ok(false);
        }

        let is_direct_runtime = session
            .metadata
            .get(RUNTIME_MODE_METADATA_KEY)
            .map(|value| value == DIRECT_RUNTIME_MODE)
            .unwrap_or(false);
        if !is_direct_runtime {
            return Ok(false);
        }

        self.restore_detached_runtime(session_id).await?;
        Ok(self.terminal_runtime_attached(session_id).await)
    }

    pub(crate) async fn resize_live_terminal(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        self.resize_terminal_store(session_id, cols, rows).await;
        let handle = self.ensure_terminal_host(session_id).await;
        if let Some(resize_tx) = handle.resize_tx.read().await.clone() {
            let _ = resize_tx
                .send(conductor_executors::process::PtyDimensions { cols, rows })
                .await;
        }
        Ok(())
    }

    #[cfg(unix)]
    async fn read_replay_bytes_from_path(
        path: &std::path::Path,
        max_bytes: usize,
    ) -> Result<Option<DetachedRuntimeReplayData>> {
        let mut file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };

        let len = file.metadata().await?.len();
        let start = len.saturating_sub(max_bytes as u64);
        use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
        file.seek(SeekFrom::Start(start)).await?;

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        if bytes.is_empty() || String::from_utf8_lossy(&bytes).trim().is_empty() {
            Ok(None)
        } else {
            Ok(Some(DetachedRuntimeReplayData {
                bytes,
                start_offset: start,
                end_offset: len,
                truncated: start > 0,
            }))
        }
    }

    #[cfg(unix)]
    async fn read_checkpoint_from_path(
        path: &std::path::Path,
    ) -> Result<Option<types::DetachedPtyHostCheckpoint>> {
        let content = match tokio::fs::read(path).await {
            Ok(content) => content,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };

        let checkpoint = serde_json::from_slice::<types::DetachedPtyHostCheckpoint>(&content)?;
        Ok(Some(checkpoint))
    }

    #[cfg(not(unix))]
    async fn read_replay_bytes_from_path(
        _path: &std::path::Path,
        _max_bytes: usize,
    ) -> Result<Option<DetachedRuntimeReplayData>> {
        Ok(None)
    }

    #[cfg(unix)]
    pub(crate) async fn sync_detached_output_offset_metadata(
        &self,
        session_id: &str,
        offset: u64,
    ) -> Result<()> {
        let updated = {
            let mut sessions = self.sessions.write().await;
            let Some(session) = sessions.get_mut(session_id) else {
                return Ok(());
            };
            let current_offset = session
                .metadata
                .get(types::DETACHED_OUTPUT_OFFSET_METADATA_KEY)
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            if current_offset == offset {
                return Ok(());
            }
            session.metadata.insert(
                types::DETACHED_OUTPUT_OFFSET_METADATA_KEY.to_string(),
                offset.to_string(),
            );
            Some(session.clone())
        };

        if let Some(session) = updated {
            self.persist_session(&session).await?;
        }
        Ok(())
    }

    #[cfg(not(unix))]
    pub(crate) async fn sync_detached_output_offset_metadata(
        &self,
        _session_id: &str,
        _offset: u64,
    ) -> Result<()> {
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) async fn describe_terminal_runtime(
        &self,
        session: &SessionRecord,
    ) -> TerminalRuntimeState {
        use helpers::{
            detached_runtime_metadata, detached_runtime_unreachable, ping_detached_runtime,
            read_detached_exit_code,
        };

        let recovery_action = session.metadata.get("recoveryAction").cloned();
        let session_summary = session
            .summary
            .clone()
            .or_else(|| session.metadata.get("summary").cloned())
            .filter(|value| !value.trim().is_empty());

        if let Some(daemon) = self.terminal_daemon() {
            match daemon.remote_session(&session.id).await {
                Ok(Some(info)) => {
                    let status = map_daemon_runtime_status(&info.status);
                    let started_at = Some(info.started_at.to_string());
                    let updated_at = Some(info.updated_at.to_string());
                    return TerminalRuntimeState {
                        authority: TerminalRuntimeAuthority::Daemon,
                        status: status.clone(),
                        daemon_connected: Some(true),
                        host_pid: info.host_pid,
                        child_pid: info.child_pid,
                        cols: info.cols,
                        rows: info.rows,
                        started_at,
                        updated_at,
                        error: info.error.clone(),
                        notice: daemon_runtime_notice(
                            &status,
                            info.error.as_deref(),
                            recovery_action.as_deref(),
                            session_summary.as_deref(),
                        ),
                        recovery_action,
                    };
                }
                Ok(None) => {
                    return TerminalRuntimeState {
                        authority: TerminalRuntimeAuthority::Daemon,
                        status: TerminalRuntimeStatus::Missing,
                        daemon_connected: Some(true),
                        host_pid: None,
                        child_pid: None,
                        cols: None,
                        rows: None,
                        started_at: None,
                        updated_at: None,
                        error: None,
                        notice: Some(
                            "Workspace terminal daemon does not report this session as active. Send a follow-up to start a fresh runtime in the same workspace."
                                .to_string(),
                        ),
                        recovery_action,
                    };
                }
                Err(error) if detached_runtime_unreachable(&error) => {}
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to query terminal daemon runtime state; falling back to session metadata"
                    );
                }
            }
        }

        let daemon_connected = self.terminal_daemon().map(|_| false);

        if let Some(metadata) = detached_runtime_metadata(session) {
            match ping_detached_runtime(&metadata).await {
                Ok(Some(response)) => {
                    return TerminalRuntimeState {
                        authority: TerminalRuntimeAuthority::DetachedHost,
                        status: TerminalRuntimeStatus::Ready,
                        daemon_connected,
                        host_pid: Some(metadata.host_pid),
                        child_pid: response.child_pid,
                        cols: None,
                        rows: None,
                        started_at: None,
                        updated_at: None,
                        error: None,
                        notice: None,
                        recovery_action,
                    };
                }
                Ok(None) => {
                    let exit_code = read_detached_exit_code(&metadata.exit_path)
                        .await
                        .ok()
                        .flatten();
                    let status = if exit_code.is_some() {
                        TerminalRuntimeStatus::Exited
                    } else {
                        TerminalRuntimeStatus::Unknown
                    };
                    let exit_notice = exit_code.map(|code| {
                        if code == 0 {
                            "Terminal runtime exited cleanly. Send a follow-up to start a fresh runtime."
                                .to_string()
                        } else {
                            format!(
                                "Terminal runtime exited with code {code}. Send a follow-up to start a fresh runtime."
                            )
                        }
                    });
                    return TerminalRuntimeState {
                        authority: TerminalRuntimeAuthority::DetachedHost,
                        status,
                        daemon_connected,
                        host_pid: Some(metadata.host_pid),
                        child_pid: None,
                        cols: None,
                        rows: None,
                        started_at: None,
                        updated_at: None,
                        error: None,
                        notice: exit_notice.or(session_summary),
                        recovery_action,
                    };
                }
                Err(error) if detached_runtime_unreachable(&error) => {}
                Err(error) => {
                    tracing::warn!(
                        session_id = session.id,
                        error = %error,
                        "Failed to probe detached runtime directly; falling back to session metadata"
                    );
                }
            }
        }

        TerminalRuntimeState {
            authority: TerminalRuntimeAuthority::SessionMetadata,
            status: if recovery_action.is_some() {
                TerminalRuntimeStatus::Failed
            } else {
                TerminalRuntimeStatus::Unknown
            },
            daemon_connected,
            host_pid: None,
            child_pid: None,
            cols: None,
            rows: None,
            started_at: None,
            updated_at: None,
            error: None,
            notice: session_summary,
            recovery_action,
        }
    }

    #[cfg(not(unix))]
    pub(crate) async fn describe_terminal_runtime(
        &self,
        session: &SessionRecord,
    ) -> TerminalRuntimeState {
        TerminalRuntimeState {
            authority: TerminalRuntimeAuthority::SessionMetadata,
            status: TerminalRuntimeStatus::Unknown,
            daemon_connected: None,
            host_pid: None,
            child_pid: None,
            cols: None,
            rows: None,
            started_at: None,
            updated_at: None,
            error: None,
            notice: session
                .summary
                .clone()
                .or_else(|| session.metadata.get("summary").cloned()),
            recovery_action: session.metadata.get("recoveryAction").cloned(),
        }
    }
}

#[cfg(unix)]
fn map_daemon_runtime_status(status: &str) -> TerminalRuntimeStatus {
    match status.trim().to_ascii_lowercase().as_str() {
        "ready" => TerminalRuntimeStatus::Ready,
        "spawning" => TerminalRuntimeStatus::Spawning,
        "exited" => TerminalRuntimeStatus::Exited,
        "failed" => TerminalRuntimeStatus::Failed,
        _ => TerminalRuntimeStatus::Unknown,
    }
}

#[cfg(unix)]
fn daemon_runtime_notice(
    status: &TerminalRuntimeStatus,
    error: Option<&str>,
    recovery_action: Option<&str>,
    session_summary: Option<&str>,
) -> Option<String> {
    if let Some(message) = error.filter(|value| !value.trim().is_empty()) {
        return Some(message.to_string());
    }

    match status {
        TerminalRuntimeStatus::Ready => None,
        TerminalRuntimeStatus::Spawning => Some(
            "Terminal runtime is still spawning. The session should attach automatically when the host reports ready."
                .to_string(),
        ),
        TerminalRuntimeStatus::Exited => Some(
            "Terminal runtime already exited. Send a follow-up to start a fresh runtime."
                .to_string(),
        ),
        TerminalRuntimeStatus::Failed => session_summary
            .map(ToOwned::to_owned)
            .or_else(|| {
                recovery_action.map(|action| {
                    format!(
                        "Terminal runtime failed. Use the suggested recovery action: {action}."
                    )
                })
            })
            .or_else(|| {
                Some(
                    "Terminal runtime failed. Send a follow-up to start a fresh runtime."
                        .to_string(),
                )
            }),
        TerminalRuntimeStatus::Missing => Some(
            "Workspace terminal daemon no longer reports this session as active. Send a follow-up to start a fresh runtime."
                .to_string(),
        ),
        TerminalRuntimeStatus::Unknown => session_summary.map(ToOwned::to_owned),
    }
}
