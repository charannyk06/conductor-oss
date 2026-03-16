/// Native Rust ttyd-compatible terminal server.
///
/// Provides a self-contained terminal server that spawns PTY processes
/// and streams their I/O over WebSockets using the ttyd binary protocol.
/// Replaces the external ttyd C binary dependency.
pub mod protocol;
pub mod pty;
pub mod session;
pub mod websocket;

use pty::PtySpawnConfig;
use session::TtydSession;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Configuration for the ttyd server.
#[derive(Debug, Clone)]
pub struct TtydConfig {
    /// Default terminal columns.
    pub default_cols: u16,
    /// Default terminal rows.
    pub default_rows: u16,
    /// Maximum number of concurrent sessions (0 = unlimited).
    pub max_sessions: usize,
}

impl Default for TtydConfig {
    fn default() -> Self {
        Self {
            default_cols: 120,
            default_rows: 32,
            max_sessions: 0,
        }
    }
}

/// The native ttyd server managing multiple terminal sessions.
pub struct TtydServer {
    sessions: RwLock<HashMap<String, Arc<TtydSession>>>,
    config: TtydConfig,
}

impl TtydServer {
    pub fn new(config: TtydConfig) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            config,
        }
    }

    /// Spawn a new terminal session.
    pub async fn spawn_session(
        &self,
        session_id: String,
        command: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Arc<TtydSession>, SpawnError> {
        // Check session limit
        if self.config.max_sessions > 0 {
            let sessions = self.sessions.read().await;
            if sessions.len() >= self.config.max_sessions {
                return Err(SpawnError::SessionLimitReached);
            }
        }

        let config = PtySpawnConfig {
            command,
            cwd,
            env,
            cols: cols.unwrap_or(self.config.default_cols),
            rows: rows.unwrap_or(self.config.default_rows),
        };

        let session = TtydSession::spawn(session_id.clone(), config)
            .map_err(SpawnError::Pty)?;

        self.sessions
            .write()
            .await
            .insert(session_id, Arc::clone(&session));

        Ok(session)
    }

    /// Get an existing session by ID.
    pub async fn get_session(&self, session_id: &str) -> Option<Arc<TtydSession>> {
        self.sessions.read().await.get(session_id).cloned()
    }

    /// Get or spawn a session.
    pub async fn get_or_spawn(
        &self,
        session_id: String,
        command: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Arc<TtydSession>, SpawnError> {
        if let Some(session) = self.get_session(&session_id).await {
            return Ok(session);
        }
        self.spawn_session(session_id, command, cwd, env, cols, rows)
            .await
    }

    /// Kill and remove a session.
    pub async fn kill_session(&self, session_id: &str) -> bool {
        let session = self.sessions.write().await.remove(session_id);
        if let Some(session) = session {
            session.kill().await;
            true
        } else {
            false
        }
    }

    /// Remove a session from the registry (without killing).
    pub async fn remove_session(&self, session_id: &str) -> Option<Arc<TtydSession>> {
        self.sessions.write().await.remove(session_id)
    }

    /// List all active session IDs.
    pub async fn session_ids(&self) -> Vec<String> {
        self.sessions.read().await.keys().cloned().collect()
    }

    /// Number of active sessions.
    pub async fn session_count(&self) -> usize {
        self.sessions.read().await.len()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("failed to spawn PTY: {0}")]
    Pty(#[from] pty::PtySpawnError),
    #[error("session limit reached")]
    SessionLimitReached,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_server_lifecycle() {
        let server = TtydServer::new(TtydConfig::default());

        let session = server
            .spawn_session(
                "s1".into(),
                vec!["bash".into(), "-c".into(), "sleep 60".into()],
                ".".into(),
                HashMap::new(),
                Some(80),
                Some(24),
            )
            .await
            .expect("spawn should succeed");

        assert_eq!(session.session_id, "s1");
        assert_eq!(server.session_count().await, 1);

        // Get existing
        let got = server.get_session("s1").await;
        assert!(got.is_some());

        // Kill
        assert!(server.kill_session("s1").await);
        assert_eq!(server.session_count().await, 0);
    }

    #[tokio::test]
    async fn test_session_limit() {
        let config = TtydConfig {
            max_sessions: 1,
            ..Default::default()
        };
        let server = TtydServer::new(config);

        server
            .spawn_session(
                "s1".into(),
                vec!["bash".into(), "-c".into(), "sleep 60".into()],
                ".".into(),
                HashMap::new(),
                None,
                None,
            )
            .await
            .expect("first spawn should succeed");

        let result = server
            .spawn_session(
                "s2".into(),
                vec!["bash".into(), "-c".into(), "sleep 60".into()],
                ".".into(),
                HashMap::new(),
                None,
                None,
            )
            .await;

        assert!(matches!(result, Err(SpawnError::SessionLimitReached)));

        server.kill_session("s1").await;
    }

    #[tokio::test]
    async fn test_get_or_spawn() {
        let server = TtydServer::new(TtydConfig::default());

        let s1 = server
            .get_or_spawn(
                "s1".into(),
                vec!["bash".into(), "-c".into(), "sleep 60".into()],
                ".".into(),
                HashMap::new(),
                None,
                None,
            )
            .await
            .expect("spawn should succeed");

        // Second call should return the existing session
        let s1_again = server
            .get_or_spawn(
                "s1".into(),
                vec!["bash".into(), "-c".into(), "sleep 60".into()],
                ".".into(),
                HashMap::new(),
                None,
                None,
            )
            .await
            .expect("get should succeed");

        assert_eq!(s1.session_id, s1_again.session_id);
        assert_eq!(server.session_count().await, 1);

        server.kill_session("s1").await;
    }
}
