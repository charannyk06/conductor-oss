mod control;
mod daemon;
mod frame;
mod helpers;
mod lifecycle;
mod log_tail;
pub mod pty_host;
mod pty_subprocess;
mod stream;
#[cfg(test)]
mod tests;
pub(crate) mod ttyd_launcher;
pub mod types;

use anyhow::Result;
use conductor_executors::executor::{Executor, ExecutorHandle, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;

use crate::state::AppState;

pub use pty_host::run_detached_pty_host;
pub(crate) use types::DETACHED_LOG_PATH_METADATA_KEY;
pub(crate) use types::DIRECT_RUNTIME_MODE;
pub(crate) use types::{RUNTIME_MODE_METADATA_KEY, TTYD_RUNTIME_MODE, TTYD_WS_URL_METADATA_KEY};

pub(crate) struct RuntimeLaunch {
    pub(crate) handle: ExecutorHandle,
    pub(crate) metadata: HashMap<String, String>,
    /// When true, the runtime already emits terminal bytes directly via
    /// `emit_terminal_bytes()` (e.g. ttyd mirror client). The output consumer
    /// should NOT also mirror Stdout lines as terminal bytes, which would
    /// cause double output.
    pub(crate) streams_terminal_bytes: bool,
}

impl AppState {
    pub(crate) async fn spawn_with_runtime(
        self: &Arc<Self>,
        project: &conductor_core::config::ProjectConfig,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        // Only try ttyd when runtime is unset (auto) or explicitly "ttyd".
        // Any other explicit value (e.g. "direct", "tmux") skips ttyd.
        let use_ttyd = match project.runtime.as_deref() {
            None => true,
            Some(r) if r.eq_ignore_ascii_case("ttyd") => true,
            Some(_) => false,
        };
        if use_ttyd && ttyd_launcher::ttyd_available() {
            match ttyd_launcher::spawn_ttyd_runtime(
                self,
                executor.clone(),
                session_id,
                options.clone(),
            )
            .await
            {
                Ok(launch) => return Ok(launch),
                Err(err) => {
                    tracing::warn!(
                        session_id,
                        error = %err,
                        "ttyd launch failed, falling back to detached PTY host"
                    );
                }
            }
        }
        self.spawn_detached_runtime_or_legacy(executor, session_id, options)
            .await
    }

    pub(crate) async fn restore_runtime_sessions(self: &Arc<Self>) {
        let session_ids_and_modes: Vec<(String, Option<String>)> = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| !session.status.is_terminal())
                .filter(|session| {
                    session
                        .metadata
                        .get(RUNTIME_MODE_METADATA_KEY)
                        .map(|value| value == DIRECT_RUNTIME_MODE || value == TTYD_RUNTIME_MODE)
                        .unwrap_or(false)
                })
                .map(|session| {
                    (
                        session.id.clone(),
                        session.metadata.get(RUNTIME_MODE_METADATA_KEY).cloned(),
                    )
                })
                .collect()
        };

        for (session_id, mode) in session_ids_and_modes {
            match mode.as_deref() {
                Some(TTYD_RUNTIME_MODE) => {
                    if let Err(err) = ttyd_launcher::restore_ttyd_runtime(self, &session_id).await {
                        tracing::warn!(
                            session_id,
                            error = %err,
                            "Failed to restore ttyd runtime session"
                        );
                    }
                }
                _ => {
                    if let Err(err) = self.restore_detached_runtime(&session_id).await {
                        tracing::warn!(
                            session_id,
                            error = %err,
                            "Failed to restore runtime session"
                        );
                    }
                }
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

        let runtime_mode = session
            .metadata
            .get(RUNTIME_MODE_METADATA_KEY)
            .map(String::as_str);

        if runtime_mode == Some(TTYD_RUNTIME_MODE) {
            ttyd_launcher::restore_ttyd_runtime(self, session_id).await?;
            return Ok(self.terminal_runtime_attached(session_id).await);
        }

        if runtime_mode != Some(DIRECT_RUNTIME_MODE) {
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
}
