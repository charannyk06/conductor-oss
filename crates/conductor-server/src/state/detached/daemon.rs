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
    detached_runtime_unreachable, ensure_terminal_daemon_protocol_version, wait_for_detached_ready,
};
#[cfg(unix)]
use super::types::{
    terminal_daemon_protocol_version, DetachedPtyHostReady, TerminalDaemonMetadata,
    TerminalDaemonRequest, TerminalDaemonResponse, TerminalDaemonSessionInfo,
    DETACHED_READY_TIMEOUT, TERMINAL_DAEMON_CONTROL_SOCKET_ENV,
    TERMINAL_DAEMON_PROTOCOL_VERSION_ENV, TERMINAL_DAEMON_TOKEN_ENV,
};

/// Maximum line size for daemon control socket responses (64 KiB).
#[cfg(unix)]
const MAX_DAEMON_LINE_SIZE: usize = 64 * 1024;

/// Manages a workspace-wide terminal daemon that multiplexes PTY sessions.
///
/// A single `TerminalDaemonManager` is held per server instance and tracks
/// which session IDs are currently hosted by the daemon.  All spawn requests
/// are sent through the daemon's Unix control socket so that the daemon -- not
/// the server process -- owns the PTY host child processes.
#[cfg(unix)]
#[allow(dead_code)]
pub(crate) struct TerminalDaemonManager {
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
    pub(crate) fn new(metadata: TerminalDaemonMetadata) -> Self {
        Self {
            metadata,
            active_sessions: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Record that a session was successfully spawned via this daemon.
    pub(crate) fn register_session(&self, session_id: &str, host_pid: u32) {
        if let Ok(mut guard) = self.active_sessions.lock() {
            guard.insert(session_id.to_string(), host_pid);
        }
    }

    /// Remove a session from the local tracking map (e.g. after it exits).
    pub(crate) fn unregister_session(&self, session_id: &str) {
        if let Ok(mut guard) = self.active_sessions.lock() {
            guard.remove(session_id);
        }
    }

    /// Return the locally-tracked active session IDs.
    pub(crate) fn local_sessions(&self) -> Vec<String> {
        self.active_sessions
            .lock()
            .map(|guard| guard.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Ask the daemon for its authoritative list of active sessions.
    pub(crate) async fn remote_sessions(&self) -> Result<Vec<String>> {
        list_daemon_sessions(&self.metadata).await
    }

    /// Ask the daemon for the authoritative state of a specific session.
    pub(crate) async fn remote_session(
        &self,
        session_id: &str,
    ) -> Result<Option<TerminalDaemonSessionInfo>> {
        get_daemon_session(&self.metadata, session_id).await
    }

    pub(crate) async fn remote_session_replay(
        &self,
        session_id: &str,
        max_bytes: usize,
    ) -> Result<Option<super::types::TerminalDaemonReplayPayload>> {
        get_daemon_session_replay(&self.metadata, session_id, max_bytes).await
    }

    pub(crate) async fn remote_session_checkpoint(
        &self,
        session_id: &str,
        max_bytes: usize,
    ) -> Result<Option<super::types::TerminalDaemonCheckpointPayload>> {
        get_daemon_session_checkpoint(&self.metadata, session_id, max_bytes).await
    }

    /// Ask the daemon whether a session ID is currently active.
    pub(crate) async fn is_session_active(&self, session_id: &str) -> Result<bool> {
        self.remote_sessions()
            .await
            .map(|sessions| sessions.iter().any(|session| session == session_id))
    }

    /// Ping the daemon and return `true` if it responds with `ok: true`.
    pub(crate) async fn is_healthy(&self) -> bool {
        check_daemon_health(&self.metadata).await
    }

    /// Ask the daemon to terminate a specific PTY host session.
    pub(crate) async fn terminate_session(&self, session_id: &str) -> Result<bool> {
        terminate_daemon_session(&self.metadata, session_id).await
    }

    /// Spawn a new PTY host for `session_id` through the daemon.
    pub(crate) async fn spawn(
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
pub(crate) fn resolve_terminal_daemon_metadata() -> Option<TerminalDaemonMetadata> {
    let control_socket_path =
        PathBuf::from(std::env::var(TERMINAL_DAEMON_CONTROL_SOCKET_ENV).ok()?);
    let token = std::env::var(TERMINAL_DAEMON_TOKEN_ENV).ok()?;
    let protocol_version = std::env::var(TERMINAL_DAEMON_PROTOCOL_VERSION_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(terminal_daemon_protocol_version);
    Some(TerminalDaemonMetadata {
        control_socket_path,
        token,
        protocol_version,
    })
}

#[cfg(unix)]
pub(crate) async fn send_terminal_daemon_request(
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
    if count == 0 && line.is_empty() {
        return Err(anyhow!("Terminal daemon closed the control socket"));
    }
    if line.len() > MAX_DAEMON_LINE_SIZE {
        return Err(anyhow!(
            "Terminal daemon response exceeded maximum line size ({MAX_DAEMON_LINE_SIZE} bytes)"
        ));
    }
    let response = serde_json::from_slice::<TerminalDaemonResponse>(&line)?;
    ensure_terminal_daemon_protocol_version(response.protocol_version)?;
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
pub(crate) async fn list_daemon_sessions(metadata: &TerminalDaemonMetadata) -> Result<Vec<String>> {
    let response = send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::ListSessions {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
        },
    )
    .await?;
    Ok(response.sessions.unwrap_or_default())
}

#[cfg(unix)]
#[allow(dead_code)]
pub(crate) async fn get_daemon_session(
    metadata: &TerminalDaemonMetadata,
    session_id: &str,
) -> Result<Option<TerminalDaemonSessionInfo>> {
    let response = send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::GetSession {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
            session_id: session_id.to_string(),
        },
    )
    .await?;
    Ok(response.session)
}

#[cfg(unix)]
#[allow(dead_code)]
pub(crate) async fn get_daemon_session_replay(
    metadata: &TerminalDaemonMetadata,
    session_id: &str,
    max_bytes: usize,
) -> Result<Option<super::types::TerminalDaemonReplayPayload>> {
    let response = send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::GetSessionReplay {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
            session_id: session_id.to_string(),
            max_bytes,
        },
    )
    .await?;
    Ok(response.replay)
}

#[cfg(unix)]
#[allow(dead_code)]
pub(crate) async fn get_daemon_session_checkpoint(
    metadata: &TerminalDaemonMetadata,
    session_id: &str,
    max_bytes: usize,
) -> Result<Option<super::types::TerminalDaemonCheckpointPayload>> {
    let response = send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::GetSessionCheckpoint {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
            session_id: session_id.to_string(),
            max_bytes,
        },
    )
    .await?;
    Ok(response.checkpoint)
}

#[cfg(unix)]
#[allow(dead_code)]
pub(crate) async fn terminate_daemon_session(
    metadata: &TerminalDaemonMetadata,
    session_id: &str,
) -> Result<bool> {
    let response = send_terminal_daemon_request(
        metadata,
        TerminalDaemonRequest::TerminateSession {
            protocol_version: metadata.protocol_version,
            token: metadata.token.clone(),
            session_id: session_id.to_string(),
        },
    )
    .await?;
    Ok(response.ok)
}

/// Ping the daemon and return `true` if it is reachable and healthy.
///
/// This function never propagates errors -- callers that merely want to know
/// whether the daemon is up should use the boolean return value directly.
#[cfg(unix)]
pub(crate) async fn check_daemon_health(metadata: &TerminalDaemonMetadata) -> bool {
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
pub(crate) async fn spawn_detached_runtime_via_daemon(
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
        Err(error) => {
            tracing::error!(
                session_id,
                error = %error,
                "Terminal daemon spawn_host request failed"
            );
            return Err(error);
        }
    };

    // Check the daemon's response before waiting for the ready file.
    // When the PTY host crashes on startup, the daemon returns ok: false
    // with the actual error (e.g. "PTY host exited before readiness").
    // Without this check, we'd wait for a ready file that will never appear
    // and eventually time out with a generic unhelpful message.
    if !response.ok {
        let error_msg = response
            .error
            .unwrap_or_else(|| "PTY host spawn failed (unknown error)".to_string());
        tracing::error!(
            session_id,
            error = %error_msg,
            "Terminal daemon reported spawn failure"
        );
        return Err(anyhow!("{}", error_msg));
    }

    let host_pid = response.host_pid.unwrap_or(0);
    match wait_for_detached_ready(ready_path, DETACHED_READY_TIMEOUT).await {
        Ok(ready) => Ok(Some((ready, host_pid))),
        Err(wait_err) => {
            // The daemon said ok: true (spawn started) but the PTY host crashed
            // before writing the ready file. Query the daemon for the session's
            // actual status/error to surface a more helpful message.
            if let Some(meta) = daemon_metadata {
                if let Ok(Some(info)) = get_daemon_session(meta, session_id).await {
                    let daemon_error = info
                        .error
                        .as_deref()
                        .unwrap_or("no error reported by daemon");
                    let daemon_status = &info.status;
                    return Err(anyhow::anyhow!(
                        "PTY host for session {session_id} failed to become ready: \
                         daemon reports status={daemon_status}, error={daemon_error} \
                         (original: {wait_err})"
                    ));
                }
            }
            Err(wait_err)
        }
    }
}
