use anyhow::Result;
use std::collections::HashMap;
use std::fs::create_dir_all;
use std::path::PathBuf;

use super::helpers::normalize_loaded_session;
use super::types::{SessionRecord, TerminalRestoreSnapshot};
use super::AppState;

impl AppState {
    async fn write_session_snapshot(&self, session: &SessionRecord) -> Result<()> {
        let path = self.session_snapshot_path(&session.id);
        let content = serde_json::to_string_pretty(session)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub fn session_store_dir(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("sessions")
    }

    pub fn worktree_root(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("worktrees")
    }

    pub(crate) fn ensure_session_store(&self) {
        let _ = create_dir_all(self.session_store_dir());
        let _ = create_dir_all(self.worktree_root());
    }

    pub(crate) fn session_snapshot_path(&self, session_id: &str) -> PathBuf {
        self.session_store_dir().join(format!("{session_id}.json"))
    }

    pub(crate) fn session_terminal_capture_path(&self, session_id: &str) -> PathBuf {
        self.session_store_dir()
            .join(format!("{session_id}.terminal"))
    }

    pub(crate) fn session_terminal_restore_path(&self, session_id: &str) -> PathBuf {
        self.session_store_dir()
            .join(format!("{session_id}.terminal-state.json"))
    }

    pub(crate) async fn load_sessions_from_disk(&self) {
        let root = self.session_store_dir();
        let mut loaded = HashMap::new();
        let entries = match tokio::fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut entries = entries;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = tokio::fs::read_to_string(&path).await {
                if let Ok(mut session) = serde_json::from_str::<SessionRecord>(&content) {
                    let changed = normalize_loaded_session(&mut session);
                    if changed {
                        if let Ok(updated) = serde_json::to_string_pretty(&session) {
                            let _ = tokio::fs::write(&path, updated).await;
                        }
                    }
                    loaded.insert(session.id.clone(), session);
                }
            }
        }
        if !loaded.is_empty() {
            let mut guard = self.sessions.write().await;
            guard.extend(loaded);
        }
        self.dashboard_snapshot_cache
            .lock()
            .await
            .ordered_ids
            .clear();
        self.dashboard_snapshot_cache
            .lock()
            .await
            .sessions_by_id
            .clear();
        self.feed_payload_cache.lock().await.clear();
        self.runtime_status_cache.lock().await.clear();
    }

    pub(crate) async fn persist_session(&self, session: &SessionRecord) -> Result<()> {
        self.write_session_snapshot(session).await?;
        self.invalidate_session_caches(&session.id).await;
        Ok(())
    }

    pub(crate) async fn persist_session_snapshot(&self, session: &SessionRecord) -> Result<()> {
        self.write_session_snapshot(session).await
    }

    pub(crate) async fn persist_terminal_restore_snapshot(
        &self,
        session_id: &str,
        snapshot: &TerminalRestoreSnapshot,
    ) -> Result<()> {
        let path = self.session_terminal_restore_path(session_id);
        if snapshot.is_empty() {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            }
            return Ok(());
        }

        let content = serde_json::to_vec(snapshot)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub(crate) async fn load_terminal_restore_snapshot(
        &self,
        session_id: &str,
    ) -> Result<Option<TerminalRestoreSnapshot>> {
        let path = self.session_terminal_restore_path(session_id);
        let content = match tokio::fs::read(path).await {
            Ok(content) => content,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };

        let snapshot = serde_json::from_slice::<TerminalRestoreSnapshot>(&content)?;
        Ok(Some(snapshot))
    }

    pub(crate) async fn replace_session(&self, session: SessionRecord) -> Result<()> {
        self.persist_session(&session).await?;
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session.id.clone(), session.clone());
        }
        self.publish_feed_update(&session.id);
        self.publish_snapshot().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::AppState;
    use conductor_core::config::ConductorConfig;
    use conductor_db::Database;
    use uuid::Uuid;

    async fn build_state(root: &std::path::Path) -> std::sync::Arc<AppState> {
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

    #[tokio::test]
    async fn terminal_restore_snapshot_survives_backend_restart() {
        let root = std::env::temp_dir().join(format!(
            "conductor-terminal-restore-test-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();

        let state = build_state(&root).await;
        state.emit_terminal_text("session-1", "hello\r\n").await;
        state
            .emit_terminal_text("session-1", "\x1b[32mworld\x1b[0m")
            .await;
        state.resize_terminal_store("session-1", 144, 42).await;

        let initial = state
            .current_terminal_restore_snapshot("session-1")
            .await
            .expect("terminal restore snapshot should exist");
        assert_eq!(initial.cols, 144);
        assert_eq!(initial.rows, 42);
        assert!(state.session_terminal_restore_path("session-1").exists());
        drop(state);

        let restored = build_state(&root).await;
        let loaded = restored
            .current_terminal_restore_snapshot("session-1")
            .await
            .expect("persisted terminal restore snapshot should load");
        assert_eq!(loaded, initial);

        let _ = restored.ensure_terminal_host("session-1").await;
        restored
            .emit_terminal_bytes("session-1", b"\r\nagain")
            .await;

        let appended = restored
            .current_terminal_restore_snapshot("session-1")
            .await
            .expect("rehydrated terminal restore snapshot should update");
        let rendered = String::from_utf8_lossy(&appended.render_bytes(8192)).into_owned();

        assert_eq!(appended.cols, 144);
        assert_eq!(appended.rows, 42);
        assert!(rendered.contains("world"));
        assert!(rendered.contains("again"));

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn terminal_capture_writer_flushes_buffered_output() {
        let root = std::env::temp_dir().join(format!(
            "conductor-terminal-capture-test-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();

        let state = build_state(&root).await;
        state
            .emit_terminal_bytes("session-2", b"hello\r\nworld")
            .await;
        state.flush_terminal_capture("session-2").await;

        let capture = tokio::fs::read(state.session_terminal_capture_path("session-2"))
            .await
            .expect("terminal capture file should flush to disk");

        assert_eq!(capture, b"hello\r\nworld");

        let _ = tokio::fs::remove_dir_all(&root).await;
    }
}
