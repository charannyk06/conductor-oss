#[cfg(unix)]
use anyhow::{anyhow, Result};
#[cfg(unix)]
use std::collections::HashMap;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::{Arc, Mutex as StdMutex};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;

#[cfg(unix)]
use super::helpers::{
    detached_runtime_unreachable, ensure_detached_protocol_version, wait_for_detached_ready,
};
#[cfg(unix)]
use super::types::{
    DetachedPtyHostReady, TerminalDaemonMetadata, TerminalDaemonRequest, TerminalDaemonResponse,
    TerminalDaemonSessionsResponse, DETACHED_PTY_PROTOCOL_VERSION, DETACHED_READY_TIMEOUT,
    TERMINAL_DAEMON_CONTROL_SOCKET_ENV, TERMINAL_DAEMON_PROTOCOL_VERSION_ENV,
    TERMINAL_DAEMON_TOKEN_ENV,
};

/// Manages a workspace-wide terminal daemon that multiplexes PTY sessions.
///
/// A single `TerminalDaemonManager` is held per server instance and tracks
/// which session IDs are currently hosted by the daemon.  All spawn requests
/// are sent through the daemon's Unix control socket so that the daemon — not
/// the server process — owns the PTY host child processes.
#[cfg(unix)]
#[allow(dead_code)]
pub(super) struct TerminalDaemonManager {
    metadata: TerminalDaemonMetadata,
    /// Session IDs that were spawned through this daemon in the current
    /// server lifetime.  The daemon itself is the authoritative source;
    /// this map is a best-effort local cache.
    active_sessions: Arc<StdMutex<HashMap<String, u32>>>,
}

#[cfg(unix)]
#[allow(dead_code)]
impl TerminalDaemonManager {
    /// Create a manager from resolved daemon metadata.
    pub(super) fn new(metadata: TerminalDaemonMetadata) -> Self {
        Self {
            metadata,
            active_sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Record that a session was successfully spawned via this daemon.
    pub(super) fn register_session(&self, session_id: &str, host_pid: u32) {
        if let Ok(mut guard) = self.active_sessions.lock() {
            guard.insert(session_id.to_string(), host_pid);
        }
    }

    /// Remove a session from the local tracking map (e.g. after it exits).
    pub(super) fn unregister_session(&self, session_id: &str) {
        if let Ok(mut guard) = self.active_sessions.lock() {
            guard.remove(session_id);
        }
    }

    /// Return the locally-tracked active session IDs.
    pub(super) fn local_sessions(&self) -> Vec<String> {
        self.active_sessions
            .lock()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Ask the daemon for its authoritative list of active sessions.
    pub(super) async fn remote_sessions(&self) -> Result<Vec<String>> {
        list_daemon_sessions(&self.metadata).await
    }

    /// Ping the daemon and return `true` if it responds with `ok: true`.
    pub(super) async fn is_healthy(&self) -> bool {
        check_daemon_health(&self.metadata).await
    }

    /// Spawn a new PTY host for `session_id` through the daemon.
    pub(super) async fn spawn(
        &self,
        session_id: &str,
        spec_path: &Path,
        ready_path: &Path,
    ) -> Result<Option<(DetachedPtyHostReady, u32)>> {
        let result = spawn_detached_runtime_via_daemon(
            Some(&self.metadata),
            session_id,
            spec_path,
            ready_path,
        )
        .await?;
        if let Some((ref ready, host_pid)) = result {
            let pid = if ready.host_pid > 0 {
                ready.host_pid
            } else {
                host_pid
            };
            self.register_session(session_id, pid);
        }
        Ok(result)
    }
}

#[cfg(unix)]
pub(super) fn resolve_terminal_daemon_metadata() -> Option<TerminalDaemonMetadata> {
    let control_socket_path =
        PathBuf::from(std::env::var(TERMINAL_DAEMON_CONTROL_SOCKET_ENV).ok()?);
    let token = std::env::var(TERMINAL_DAEMON_TOKEN_ENV).ok()?;
    let protocol_version = std::env::var(TERMINAL_DAEMON_PROTOCOL_VERSION_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DETACHED_PTY_PROTOCOL_VERSION);
    Some(TerminalDaemonMetadata {
        control_socket_path,
        token,
        protocol_version,
    })
}

#[cfg(unix)]
pub(super) async fn send_terminal_daemon_request(
    metadata: &TerminalDaemonMetadata,
    request: TerminalDaemonRequest,
) -> Result<TerminalDaemonResponse> {
    let mut stream = UnixStream::connect(&metadata.control_socket_path).await?;
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Err(anyhow!("Terminal daemon closed the control socket"));
    }
    let response = serde_json::from_slice::<TerminalDaemonResponse>(&line)?;
    ensure_detached_protocol_version(response.protocol_version)?;
    if response.ok {
        Ok(response)
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "Terminal daemon request failed".to_string()
        })))
    }
}

/// Send a `ListSessions` command to the daemon and return the list of active
/// session IDs.  Returns an error if the daemon is unreachable or responds
/// with an error.
#[cfg(unix)]
#[allow(dead_code)]
pub(super) async fn list_daemon_sessions(
    metadata: &TerminalDaemonMetadata,
) -> Result<Vec<String>> {
    let mut stream = UnixStream::connect(&metadata.control_socket_path).await?;
    let request = TerminalDaemonRequest::ListSessions {
        protocol_version: metadata.protocol_version,
        token: metadata.token.clone(),
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Err(anyhow!("Terminal daemon closed the control socket"));
    }
    let response = serde_json::from_slice::<TerminalDaemonSessionsResponse>(&line)?;
    ensure_detached_protocol_version(response.protocol_version)?;
    if response.ok {
        Ok(response.sessions)
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "Terminal daemon ListSessions request failed".to_string()
        })))
    }
}

/// Ping the daemon and return `true` if it is reachable and healthy.
///
/// This function never propagates errors — callers that merely want to know
/// whether the daemon is up should use the boolean return value directly.
#[cfg(unix)]
pub(super) async fn check_daemon_health(metadata: &TerminalDaemonMetadata) -> bool {
    let result = send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::Ping {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
        },
    )
    .await;
    match result {
        Ok(response) => {
            tracing::debug!(
                daemon_pid = response.daemon_pid,
                protocol_version = response.protocol_version,
                "Terminal daemon health check passed"
            );
            response.ok
        }
        Err(ref error) if detached_runtime_unreachable(error) => {
            tracing::debug!(
                error = %error,
                "Terminal daemon health check: daemon is unreachable"
            );
            false
        }
        Err(ref error) => {
            tracing::warn!(
                error = %error,
                "Terminal daemon health check failed"
            );
            false
        }
    }
}

#[cfg(unix)]
pub(super) async fn spawn_detached_runtime_via_daemon(
    daemon_metadata: Option<&TerminalDaemonMetadata>,
    session_id: &str,
    spec_path: &Path,
    ready_path: &Path,
) -> Result<Option<(DetachedPtyHostReady, u32)>> {
    let Some(metadata) = daemon_metadata else {
        return Ok(None);
    };

    let response = match send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::SpawnHost {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
            session_id: session_id.to_string(),
            spec_path: spec_path.to_path_buf(),
            ready_path: ready_path.to_path_buf(),
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) if detached_runtime_unreachable(&error) => {
            tracing::warn!(
                session_id,
                error = %error,
                "Terminal daemon was unavailable; falling back to direct detached PTY host launch"
            );
            return Ok(None);
        }
        Err(error) => return Err(error),
    };

    let ready = wait_for_detached_ready(ready_path, DETACHED_READY_TIMEOUT).await?;
    Ok(Some((ready, response.host_pid.unwrap_or(0))))
}
