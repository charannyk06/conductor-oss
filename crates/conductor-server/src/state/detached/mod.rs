mod helpers;
pub(crate) mod ttyd_launcher;
pub(crate) mod types;

use anyhow::{anyhow, Result};
use conductor_executors::executor::{Executor, ExecutorHandle, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;

use crate::state::AppState;

pub(crate) use types::DETACHED_LOG_PATH_METADATA_KEY;
pub(crate) use types::DETACHED_PID_METADATA_KEY;
use types::DIRECT_RUNTIME_MODE;
pub(crate) use types::{
    RUNTIME_MODE_METADATA_KEY, TTYD_PID_METADATA_KEY, TTYD_RUNTIME_MODE, TTYD_WS_URL_METADATA_KEY,
};

pub(crate) struct RuntimeLaunch {
    pub(crate) handle: ExecutorHandle,
    pub(crate) metadata: HashMap<String, String>,
    /// When true, the runtime already emits terminal bytes directly via
    /// `emit_terminal_bytes()` (e.g. ttyd mirror client). The output consumer
    /// should NOT also mirror Stdout lines as terminal bytes, which would
    /// cause double output.
    pub(crate) streams_terminal_bytes: bool,
}

fn validate_interactive_runtime(runtime: Option<&str>) -> Result<()> {
    let normalized = runtime.map(str::trim).filter(|value| !value.is_empty());
    match normalized {
        None => Ok(()),
        Some(value) if value.eq_ignore_ascii_case(TTYD_RUNTIME_MODE) => Ok(()),
        Some(value)
            if value.eq_ignore_ascii_case(DIRECT_RUNTIME_MODE)
                || value.eq_ignore_ascii_case("tmux") =>
        {
            Ok(())
        }
        Some(other) => Err(anyhow!(
            "Unsupported runtime `{other}`. Conductor now launches interactive sessions through ttyd only."
        )),
    }
}

impl AppState {
    pub(crate) async fn spawn_with_runtime(
        self: &Arc<Self>,
        project: &conductor_core::config::ProjectConfig,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        validate_interactive_runtime(project.runtime.as_deref())?;
        let ttyd_binary = ttyd_launcher::resolve_ttyd_binary(&self.workspace_path)
            .ok_or_else(|| ttyd_launcher::ttyd_missing_error(&self.workspace_path))?;
        ttyd_launcher::spawn_ttyd_runtime(self, executor, session_id, options, &ttyd_binary).await
    }

    /// Archive any non-ttyd sessions that survived previous restarts as Stuck/Working.
    /// These are legacy sessions from before the ttyd runtime was introduced.
    /// They cannot be recovered and should not pollute the dashboard.
    pub(crate) async fn archive_stale_non_ttyd_sessions(self: &Arc<Self>) {
        let now = chrono::Utc::now().to_rfc3339();
        let session_ids: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| !session.status.is_terminal())
                .filter(|session| {
                    // Only non-ttyd sessions
                    session
                        .metadata
                        .get(RUNTIME_MODE_METADATA_KEY)
                        .map(|value| value != TTYD_RUNTIME_MODE)
                        .unwrap_or(true) // no runtimeMode = pre-ttyd
                })
                .map(|session| session.id.clone())
                .collect()
        };

        for session_id in session_ids {
            let session_to_persist = {
                let mut sessions = self.sessions.write().await;
                if let Some(session) = sessions.get_mut(&session_id) {
                    session.status = crate::state::SessionStatus::Archived;
                    session.activity = Some("exited".to_string());
                    session.last_activity_at = now.clone();
                    session.summary = Some(
                        "Session archived on restart (pre-ttyd runtime not recoverable)"
                            .to_string(),
                    );
                    session
                        .metadata
                        .insert("archivedAt".to_string(), now.clone());
                    session.pid = None;
                    Some(session.clone())
                } else {
                    None
                }
            };

            if let Some(session) = session_to_persist {
                let _ = self.persist_session(&session).await;
            }
        }
    }

    pub(crate) async fn restore_runtime_sessions(self: &Arc<Self>) {
        let session_ids: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| !session.status.is_terminal())
                .filter(|session| {
                    session
                        .metadata
                        .get(RUNTIME_MODE_METADATA_KEY)
                        .map(|value| value == TTYD_RUNTIME_MODE)
                        .unwrap_or(false)
                })
                .map(|session| session.id.clone())
                .collect()
        };

        for session_id in session_ids {
            if let Err(err) = ttyd_launcher::restore_ttyd_runtime(self, &session_id).await {
                tracing::warn!(
                    session_id,
                    error = %err,
                    "Failed to restore ttyd runtime session"
                );
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

        if runtime_mode != Some(TTYD_RUNTIME_MODE) {
            return Ok(false);
        }

        ttyd_launcher::restore_ttyd_runtime(self, session_id).await?;
        Ok(self.terminal_runtime_attached(session_id).await)
    }

    #[cfg_attr(not(test), allow(dead_code))]
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
