#[cfg(unix)]
use anyhow::{anyhow, Result};
#[cfg(unix)]
use conductor_executors::executor::ExecutorOutput;
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
use super::frame::{
    decode_detached_exit_payload, DetachedPtyStreamFrameDecoder, DetachedPtyStreamFrameKind,
};
#[cfg(unix)]
use super::helpers::{
    emit_detached_runtime_error, emit_detached_runtime_exit, ensure_detached_protocol_version,
    flush_detached_partial_line, read_detached_exit_code, split_detached_log_lines,
};
#[cfg(unix)]
use super::log_tail::read_detached_log_chunk;
#[cfg(unix)]
use super::types::{
    DetachedOutputForwarder, DetachedPtyHostStreamRequest, DetachedPtyHostStreamResponse,
    DetachedRuntimeMetadata, DETACHED_EXIT_WAIT_TIMEOUT, DETACHED_OUTPUT_OFFSET_METADATA_KEY,
    DETACHED_STREAM_RECONNECT_INTERVAL,
};
#[cfg(unix)]
use crate::state::AppState;

/// Maximum line size for detached PTY stream handshake responses (64 KiB).
#[cfg(unix)]
const MAX_STREAM_HANDSHAKE_LINE_SIZE: usize = 64 * 1024;

#[cfg(unix)]
impl AppState {
    pub(super) async fn forward_detached_output(
        self: std::sync::Arc<Self>,
        mut forwarder: DetachedOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        // If stream_socket_path is not set, try to construct the expected path
        // using the same hash pattern as detached_socket_paths(). This covers
        // sessions that were persisted before stream_socket_path was stored.
        if forwarder.metadata.stream_socket_path.is_none() {
            let (_, inferred_stream_path) = self.detached_socket_paths(&forwarder.session_id);
            // Check if the inferred socket is reachable before committing to it.
            if tokio::net::UnixStream::connect(&inferred_stream_path)
                .await
                .is_ok()
            {
                forwarder.metadata.stream_socket_path = Some(inferred_stream_path);
            }
        }

        if forwarder.metadata.stream_socket_path.is_some() {
            self.forward_detached_stream_output(forwarder, output_tx)
                .await
        } else {
            let session_id = &forwarder.session_id;
            tracing::warn!(
                session_id,
                "Falling back to deprecated log-tail output path; stream socket is unavailable"
            );
            self.forward_detached_log_output(forwarder, output_tx).await
        }
    }

    pub(super) async fn forward_detached_stream_output(
        self: std::sync::Arc<Self>,
        forwarder: DetachedOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        let DetachedOutputForwarder {
            session_id,
            metadata,
            mut offset,
        } = forwarder;
        let mut partial = Vec::new();
        let mut exit_deadline = None;

        loop {
            match connect_detached_runtime_stream(&metadata, offset).await {
                Ok(mut stream) => {
                    exit_deadline = None;
                    let mut decoder = DetachedPtyStreamFrameDecoder::default();
                    let mut buffer = [0_u8; 8192];
                    loop {
                        let read = match stream.read(&mut buffer).await {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(err) => {
                                tracing::debug!(session_id, error = %err, "Detached PTY stream read error, reconnecting");
                                break;
                            }
                        };
                        let frames = match decoder.push(&buffer[..read]) {
                            Ok(frames) => frames,
                            Err(err) => {
                                tracing::warn!(
                                    session_id,
                                    error = %err,
                                    "Detached PTY stream frame decode failed, reconnecting"
                                );
                                break;
                            }
                        };
                        for frame in frames {
                            match frame.kind {
                                DetachedPtyStreamFrameKind::Data => {
                                    let next_offset = frame.offset + frame.payload.len() as u64;
                                    if next_offset <= offset {
                                        continue;
                                    }
                                    let skip = offset.saturating_sub(frame.offset) as usize;
                                    if skip >= frame.payload.len() {
                                        offset = next_offset;
                                        self.update_detached_output_offset(&session_id, offset)
                                            .await?;
                                        continue;
                                    }
                                    let chunk = frame.payload[skip..].to_vec();
                                    self.emit_terminal_bytes(&session_id, &chunk).await;
                                    let lines = split_detached_log_lines(&mut partial, &chunk);
                                    for line in lines {
                                        if output_tx
                                            .send(ExecutorOutput::Stdout(line))
                                            .await
                                            .is_err()
                                        {
                                            return Ok(());
                                        }
                                    }
                                    offset = next_offset;
                                    self.update_detached_output_offset(&session_id, offset)
                                        .await?;
                                }
                                DetachedPtyStreamFrameKind::Exit => {
                                    flush_detached_partial_line(&output_tx, &mut partial).await?;
                                    let exit_code = decode_detached_exit_payload(&frame.payload)?;
                                    emit_detached_runtime_exit(
                                        &self,
                                        &session_id,
                                        &output_tx,
                                        exit_code,
                                    )
                                    .await;
                                    return Ok(());
                                }
                                DetachedPtyStreamFrameKind::Error => {
                                    flush_detached_partial_line(&output_tx, &mut partial).await?;
                                    let error = String::from_utf8_lossy(&frame.payload).to_string();
                                    emit_detached_runtime_error(
                                        &self,
                                        &session_id,
                                        &output_tx,
                                        error,
                                        None,
                                    )
                                    .await;
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    tracing::debug!(session_id, error = %err, "Detached PTY stream connect failed");
                }
            }

            if !crate::state::workspace::is_process_alive(metadata.host_pid) {
                let deadline = exit_deadline.get_or_insert_with(|| {
                    tokio::time::Instant::now() + DETACHED_EXIT_WAIT_TIMEOUT
                });
                // Catch up on any output written to the log file that the stream
                // forwarder missed (e.g. when the agent exits before the stream
                // connection is fully established).
                if let Ok(Some((next_offset, chunk))) =
                    read_detached_log_chunk(&metadata.log_path, offset).await
                {
                    self.emit_terminal_bytes(&session_id, &chunk).await;
                    let lines = split_detached_log_lines(&mut partial, &chunk);
                    for line in lines {
                        if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                            return Ok(());
                        }
                    }
                    offset = next_offset;
                    self.update_detached_output_offset(&session_id, offset)
                        .await?;
                }
                flush_detached_partial_line(&output_tx, &mut partial).await?;
                if let Some(exit_code) = read_detached_exit_code(&metadata.exit_path).await? {
                    emit_detached_runtime_exit(&self, &session_id, &output_tx, exit_code).await;
                    return Ok(());
                }
                if tokio::time::Instant::now() >= *deadline {
                    // Build a more descriptive error: check if the log file
                    // is empty (0 bytes) which usually means the agent binary
                    // crashed before producing any output.
                    let log_detail = match tokio::fs::metadata(&metadata.log_path).await {
                        Ok(m) if m.len() == 0 => {
                            " (no output captured — the agent process likely crashed on startup)"
                        }
                        _ => "",
                    };
                    emit_detached_runtime_error(
                        &self,
                        &session_id,
                        &output_tx,
                        format!(
                            "Detached PTY runtime exited unexpectedly (host pid {} died without writing exit status){}",
                            metadata.host_pid,
                            log_detail,
                        ),
                        None,
                    )
                    .await;
                    return Ok(());
                }
            } else {
                exit_deadline = None;
            }

            tokio::time::sleep(DETACHED_STREAM_RECONNECT_INTERVAL).await;
        }
    }

    pub(super) async fn update_detached_output_offset(
        &self,
        session_id: &str,
        offset: u64,
    ) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let Some(current) = sessions.get_mut(session_id) else {
            return Ok(());
        };

        let current_offset = current
            .metadata
            .get(DETACHED_OUTPUT_OFFSET_METADATA_KEY)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if current_offset == offset {
            return Ok(());
        }

        current.metadata.insert(
            DETACHED_OUTPUT_OFFSET_METADATA_KEY.to_string(),
            offset.to_string(),
        );
        Ok(())
    }
}

#[cfg(unix)]
pub(super) async fn connect_detached_runtime_stream(
    metadata: &DetachedRuntimeMetadata,
    offset: u64,
) -> Result<UnixStream> {
    let stream_path = metadata
        .stream_socket_path
        .as_ref()
        .ok_or_else(|| anyhow!("Detached PTY stream socket is unavailable"))?;
    let mut stream = UnixStream::connect(stream_path).await?;
    let request = DetachedPtyHostStreamRequest {
        protocol_version: metadata.protocol_version,
        token: metadata.control_token.clone(),
        offset,
    };
    stream.write_all(&serde_json::to_vec(&request)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;

    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 && line.is_empty() {
        return Err(anyhow!("Detached PTY host closed the stream socket"));
    }
    if line.len() > MAX_STREAM_HANDSHAKE_LINE_SIZE {
        return Err(anyhow!(
            "Detached PTY stream handshake response exceeded maximum line size ({MAX_STREAM_HANDSHAKE_LINE_SIZE} bytes)"
        ));
    }
    let response = serde_json::from_slice::<DetachedPtyHostStreamResponse>(&line)?;
    ensure_detached_protocol_version(response.protocol_version)?;
    if response.ok {
        Ok(reader.into_inner())
    } else {
        Err(anyhow!(response.error.unwrap_or_else(|| {
            "Detached PTY stream request failed".to_string()
        })))
    }
}
