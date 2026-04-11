pub(crate) mod native_runtime;
pub(crate) mod types;

use anyhow::Result;
use conductor_executors::executor::{Executor, ExecutorHandle, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::state::AppState;

pub(crate) use types::DETACHED_LOG_PATH_METADATA_KEY;
pub(crate) use types::DETACHED_PID_METADATA_KEY;
pub(crate) use types::{
    RUNTIME_MODE_METADATA_KEY, TTYD_PID_METADATA_KEY, TTYD_WS_URL_METADATA_KEY,
};

pub(crate) struct RuntimeLaunch {
    pub(crate) handle: ExecutorHandle,
    pub(crate) metadata: HashMap<String, String>,
    pub(crate) streams_terminal_bytes: bool,
}

fn validate_interactive_runtime(_runtime: Option<&str>) {
    // Conductor now treats every interactive session as a native PTY-backed runtime.
}

impl AppState {
    pub(crate) async fn spawn_with_runtime(
        self: &Arc<Self>,
        project: &conductor_core::config::ProjectConfig,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        validate_interactive_runtime(project.runtime.as_deref());
        native_runtime::spawn_native_runtime(self, executor, session_id, options).await
    }

    pub(crate) async fn archive_stale_non_ttyd_sessions(self: &Arc<Self>) {
        let now = chrono::Utc::now().to_rfc3339();
        let session_ids: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| !session.status.is_terminal())
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
                        "Session archived on restart (native PTY runtime is not automatically recoverable)"
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
        // Native PTY sessions stay attached while the backend stays alive.
        // After a backend restart there is no detached ttyd process to recover,
        // so stale loaded sessions are archived during startup instead.
    }

    pub(crate) async fn ensure_session_live(self: &Arc<Self>, session_id: &str) -> Result<bool> {
        let restore_guard = {
            let mut guards = self.terminal_restore_guards.lock().await;
            guards
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _restore_lock = restore_guard.lock().await;
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
