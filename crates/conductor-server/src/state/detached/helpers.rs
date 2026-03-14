#[cfg(unix)]
use anyhow::Context;
use anyhow::{anyhow, Result};
use conductor_core::types::AgentKind;
#[cfg(unix)]
use conductor_executors::executor::ExecutorOutput;
use std::collections::HashMap;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
use super::types::{
    DetachedPtyHostCommand, DetachedPtyHostReady, DetachedPtyHostResponse,
    DetachedRuntimeMetadata,
};
use super::types::DETACHED_PTY_PROTOCOL_VERSION as PROTOCOL_VERSION_FOR_CHECK;
#[cfg(unix)]
use crate::state::types::TerminalStreamEvent;
use crate::state::AppState;
#[cfg(unix)]
use crate::state::SessionRecord;

pub(super) fn prepare_detached_runtime_env(
    kind: AgentKind,
    interactive: bool,
    env: &mut HashMap<String, String>,
) {
    if kind == AgentKind::QwenCode && interactive {
        // Qwen's TUI currently crashes if its active theme resolves to a
        // gradient with fewer than two stops. Force the no-color theme for
        // detached interactive launches until the upstream CLI fixes that path.
        env.entry("NO_COLOR".to_string())
            .or_insert_with(|| "1".to_string());
    }
}

pub(super) fn detached_runtime_disabled() -> bool {
    !cfg!(unix)
        || std::env::var("CONDUCTOR_DISABLE_DETACHED_PTY_HOST")
            .map(|value| value.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(cfg!(test))
}

pub(super) fn ensure_detached_protocol_version(version: u16) -> Result<()> {
    if version == PROTOCOL_VERSION_FOR_CHECK {
        Ok(())
    } else {
        Err(anyhow!(
            "Unsupported detached PTY protocol version: {version} (expected {})",
            PROTOCOL_VERSION_FOR_CHECK
        ))
    }
}

pub(super) fn resolve_detached_runtime_launcher() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CONDUCTOR_PTY_HOST_LAUNCHER") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }

    let current = std::env::current_exe().ok()?;
    let current_name = current.file_stem()?.to_string_lossy();
    if current_name == "conductor" {
        return Some(current);
    }

    let parent = current.parent()?;
    if parent.file_name().and_then(|value| value.to_str()) == Some("deps") {
        let exe_name = if cfg!(windows) {
            "conductor.exe"
        } else {
            "conductor"
        };
        let candidate = parent.parent()?.join(exe_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

pub(super) fn configure_detached_process_group(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

#[cfg(unix)]
pub(super) fn detached_runtime_unreachable(error: &anyhow::Error) -> bool {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .map(|io_error| {
                matches!(
                    io_error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::AddrNotAvailable
                )
            })
            .unwrap_or(false)
    }) {
        return true;
    }

    let message = error.to_string();
    message.contains("Connection refused")
        || message.contains("failed to lookup address information")
        || message.contains("No route to host")
        || message.contains("No such file or directory")
}

#[cfg(unix)]
pub(super) async fn flush_detached_partial_line(
    output_tx: &mpsc::Sender<ExecutorOutput>,
    partial: &mut Vec<u8>,
) -> Result<()> {
    if partial.is_empty() {
        return Ok(());
    }
    let line = String::from_utf8_lossy(partial)
        .trim_end_matches('\r')
        .to_string();
    partial.clear();
    if line.is_empty() {
        return Ok(());
    }
    if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
        return Err(anyhow!("Detached runtime output receiver dropped"));
    }
    Ok(())
}

#[cfg(unix)]
pub(super) async fn emit_detached_runtime_exit(
    state: &AppState,
    session_id: &str,
    output_tx: &mpsc::Sender<ExecutorOutput>,
    exit_code: i32,
) {
    state
        .emit_terminal_stream_event(session_id, TerminalStreamEvent::Exit(exit_code))
        .await;
    let event = if exit_code == 0 {
        ExecutorOutput::Completed { exit_code }
    } else {
        ExecutorOutput::Failed {
            error: format!("Process exited with code {exit_code}"),
            exit_code: Some(exit_code),
        }
    };
    let _ = output_tx.send(event).await;
}

#[cfg(unix)]
pub(super) async fn emit_detached_runtime_error(
    state: &AppState,
    session_id: &str,
    output_tx: &mpsc::Sender<ExecutorOutput>,
    message: String,
    exit_code: Option<i32>,
) {
    state
        .emit_terminal_stream_event(session_id, TerminalStreamEvent::Error(message.clone()))
        .await;
    let _ = output_tx
        .send(ExecutorOutput::Failed {
            error: message,
            exit_code,
        })
        .await;
}

#[cfg(unix)]
pub(super) fn split_detached_log_lines(partial: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    partial.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(index) = partial.iter().position(|byte| *byte == b'\n') {
        let line = partial.drain(..=index).collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&line)
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines
}

#[cfg(unix)]
pub(super) async fn read_detached_exit_code(path: &Path) -> Result<Option<i32>> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.parse::<i32>().with_context(|| {
        format!("Invalid exit code '{trimmed}' in {}", path.display())
    })?))
}

#[cfg(unix)]
pub(super) async fn wait_for_detached_ready(
    path: &Path,
    timeout: Duration,
) -> Result<DetachedPtyHostReady> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::fs::read(path).await {
            Ok(bytes) => return Ok(serde_json::from_slice::<DetachedPtyHostReady>(&bytes)?),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "Detached PTY host did not become ready before timeout ({})",
                path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(unix)]
pub(super) fn detached_runtime_metadata(
    session: &SessionRecord,
) -> Option<DetachedRuntimeMetadata> {
    use super::types::*;
    Some(DetachedRuntimeMetadata {
        protocol_version: session
            .metadata
            .get(DETACHED_PROTOCOL_VERSION_METADATA_KEY)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(DETACHED_PTY_PROTOCOL_VERSION),
        host_pid: session
            .metadata
            .get("detachedPid")?
            .parse::<u32>()
            .ok()?,
        control_socket_path: PathBuf::from(
            session
                .metadata
                .get(DETACHED_CONTROL_SOCKET_METADATA_KEY)?
                .clone(),
        ),
        stream_socket_path: session
            .metadata
            .get(DETACHED_STREAM_SOCKET_METADATA_KEY)
            .map(PathBuf::from),
        control_token: session
            .metadata
            .get(DETACHED_CONTROL_TOKEN_METADATA_KEY)?
            .clone(),
        log_path: PathBuf::from(
            session
                .metadata
                .get(DETACHED_LOG_PATH_METADATA_KEY)?
                .clone(),
        ),
        exit_path: PathBuf::from(
            session
                .metadata
                .get(DETACHED_EXIT_PATH_METADATA_KEY)?
                .clone(),
        ),
    })
}

#[cfg(unix)]
pub(super) async fn ping_detached_runtime(
    metadata: &DetachedRuntimeMetadata,
) -> Result<Option<DetachedPtyHostResponse>> {
    match super::control::send_detached_runtime_request(metadata, DetachedPtyHostCommand::Ping)
        .await
    {
        Ok(response) if response.ok => Ok(Some(response)),
        Ok(_) => Ok(None),
        Err(error) if detached_runtime_unreachable(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
