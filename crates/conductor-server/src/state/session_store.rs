use anyhow::Result;
use std::collections::HashMap;
use std::fs::create_dir_all;
use std::path::PathBuf;

use super::AppState;
use super::helpers::normalize_loaded_session;
use super::types::SessionRecord;

impl AppState {
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
            *guard = loaded;
        }
    }

    pub(crate) async fn persist_session(&self, session: &SessionRecord) -> Result<()> {
        let path = self.session_snapshot_path(&session.id);
        let content = serde_json::to_string_pretty(session)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub(crate) async fn replace_session(&self, session: SessionRecord) -> Result<()> {
        self.persist_session(&session).await?;
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session.id.clone(), session.clone());
        }
        self.publish_snapshot().await;
        Ok(())
    }
}
