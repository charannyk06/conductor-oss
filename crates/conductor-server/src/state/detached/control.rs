#[cfg(unix)]
use anyhow::{anyhow, Result};
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
use conductor_executors::executor::ExecutorInput;

#[cfg(unix)]
use super::helpers::{detached_runtime_unreachable, ensure_detached_protocol_version};
#[cfg(unix)]
use super::types::{
    DetachedPtyHostCommand, DetachedPtyHostRequest, DetachedPtyHostResponse,
    DetachedRuntimeMetadata, DETACHED_INPUT_BATCH_MAX_BYTES,
};

#[cfg(unix)]
pub(super) fn coalesce_detached_input_commands(
    inputs: Vec<ExecutorInput>,
) -> Vec<DetachedPtyHostCommand> {
    let mut commands = Vec::new();
    let mut pending_raw = String::new();

    for input in inputs {
        match input {
            ExecutorInput::Text(text) => {
                if !pending_raw.is_empty() {
                    commands.push(DetachedPtyHostCommand::Raw {
                        data: std::mem::take(&mut pending_raw),
                    });
                }
                commands.push(DetachedPtyHostCommand::Text { text });
            }
            ExecutorInput::Raw(raw) => {
                if raw.len() >= DETACHED_INPUT_BATCH_MAX_BYTES {
                    if !pending_raw.is_empty() {
                        commands.push(DetachedPtyHostCommand::Raw {
                            data: std::mem::take(&mut pending_raw),
                        });
                    }
                    commands.push(DetachedPtyHostCommand::Raw { data: raw });
                    continue;
                }

                if pending_raw.len() + raw.len() > DETACHED_INPUT_BATCH_MAX_BYTES
                    && !pending_raw.is_empty()
                {
                    commands.push(DetachedPtyHostCommand::Raw {
                        data: std::mem::take(&mut pending_raw),
                    });
                }
                pending_raw.push_str(&raw);
            }
        }
    }

    if !pending_raw.is_empty() {
        commands.push(DetachedPtyHostCommand::Raw { data: pending_raw });
    }

    commands
}

#[cfg(unix)]
pub(super) async fn connect_detached_runtime_control(
    metadata: &DetachedRuntimeMetadata,
) -> Result<BufReader<UnixStream>> {
    let stream = UnixStream::connect(&metadata.control_socket_path).await?;
    Ok(BufReader::new(stream))
}

#[cfg(unix)]
pub(super) async fn send_detached_runtime_request_over_connection(
    reader: &mut BufReader<UnixStream>,
    metadata: &DetachedRuntimeMetadata,
    command: DetachedPtyHostCommand,
) -> Result<DetachedPtyHostResponse> {
    let request = DetachedPtyHostRequest {
        protocol_version: metadata.protocol_version,
        token: metadata.control_token.clone(),
        command,
    };
    reader
        .get_mut()
        .write_all(&serde_json::to_vec(&request)?)
        .await?;
    reader.get_mut().write_all(b"\n").await?;
    reader.get_mut().flush().await?;

    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Err(anyhow!("Detached PTY host closed the control socket"));
    }
    let response = serde_json::from_slice::<DetachedPtyHostResponse>(&line)?;
    ensure_detached_protocol_version(response.protocol_version)?;
    if response.ok {
        Ok(response)
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "Detached PTY host request failed".to_string()
        })))
    }
}

#[cfg(unix)]
pub(super) async fn run_detached_runtime_control_queue(
    metadata: DetachedRuntimeMetadata,
    session_id: String,
    mut control_rx: mpsc::Receiver<DetachedPtyHostCommand>,
) {
    let mut connection: Option<BufReader<UnixStream>> = None;

    while let Some(command) = control_rx.recv().await {
        let mut pending = Some(command);
        let mut retries = 0_u8;

        while let Some(next_command) = pending.take() {
            if connection.is_none() {
                match connect_detached_runtime_control(&metadata).await {
                    Ok(reader) => {
                        connection = Some(reader);
                    }
                    Err(err) => {
                        tracing::warn!(session_id, error = %err, "Failed to connect detached PTY control socket");
                        break;
                    }
                }
            }

            let Some(reader) = connection.as_mut() else {
                break;
            };

            match send_detached_runtime_request_over_connection(
                reader,
                &metadata,
                next_command.clone(),
            )
            .await
            {
                Ok(_) => break,
                Err(err) if retries == 0 && detached_runtime_unreachable(&err) => {
                    connection = None;
                    pending = Some(next_command);
                    retries += 1;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(err) => {
                    tracing::warn!(session_id, error = %err, "Detached PTY control command failed");
                    connection = None;
                    break;
                }
            }
        }
    }
}

#[cfg(unix)]
pub(super) async fn send_detached_runtime_request(
    metadata: &DetachedRuntimeMetadata,
    command: DetachedPtyHostCommand,
) -> Result<DetachedPtyHostResponse> {
    let mut reader = connect_detached_runtime_control(metadata).await?;
    send_detached_runtime_request_over_connection(&mut reader, metadata, command).await
}
