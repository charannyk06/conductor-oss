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
pub mod types;

use anyhow::Result;
use conductor_executors::executor::{Executor, ExecutorHandle, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;

use crate::state::AppState;

pub(crate) use types::DETACHED_LOG_PATH_METADATA_KEY;
pub use pty_host::run_detached_pty_host;

// Re-export constants used in this file's impl AppState methods
use types::{DIRECT_RUNTIME_MODE, RUNTIME_MODE_METADATA_KEY};

pub(crate) struct RuntimeLaunch {
    pub(crate) handle: ExecutorHandle,
    pub(crate) metadata: HashMap<String, String>,
}

impl AppState {
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
}
