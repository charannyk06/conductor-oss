#[cfg(unix)]
use anyhow::{anyhow, Result};
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
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
    DETACHED_PTY_PROTOCOL_VERSION, DETACHED_READY_TIMEOUT, TERMINAL_DAEMON_CONTROL_SOCKET_ENV,
    TERMINAL_DAEMON_PROTOCOL_VERSION_ENV, TERMINAL_DAEMON_TOKEN_ENV,
};

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
