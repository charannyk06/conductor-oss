use anyhow::Result;
#[cfg(unix)]
use anyhow::{anyhow, Context};
#[cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::sync::{Arc, Mutex as StdMutex};
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(unix)]
use tokio::sync::{broadcast, mpsc, oneshot, Notify};

#[cfg(unix)]
use tokio::fs::OpenOptions;

#[cfg(unix)]
use super::frame::{write_detached_stream_frame, DetachedPtyStreamFrameKind};
#[cfg(unix)]
use super::helpers::ensure_detached_protocol_version;
#[cfg(unix)]
use super::pty_subprocess::spawn_isolated_pty;
#[cfg(unix)]
use super::stream::detached_log_len;
#[cfg(unix)]
use super::types::*;

#[cfg(unix)]
pub async fn run_detached_pty_host(spec_path: PathBuf) -> Result<()> {
    let spec = serde_json::from_slice::<DetachedPtyHostSpec>(&tokio::fs::read(&spec_path).await?)
        .with_context(|| {
        format!("Failed to parse detached PTY spec {}", spec_path.display())
    })?;
    ensure_detached_protocol_version(spec.protocol_version)?;

    if let Some(parent) = spec.log_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.exit_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.ready_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.control_socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Some(parent) = spec.stream_socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let _ = tokio::fs::remove_file(&spec.control_socket_path).await;
    let _ = tokio::fs::remove_file(&spec.stream_socket_path).await;
    let _ = tokio::fs::remove_file(&spec.log_path).await;
    let _ = tokio::fs::remove_file(&spec.exit_path).await;
    let _ = tokio::fs::remove_file(&spec.ready_path).await;

    let control_listener = UnixListener::bind(&spec.control_socket_path)
        .context("Failed to bind detached PTY control listener")?;
    let stream_listener = UnixListener::bind(&spec.stream_socket_path)
        .context("Failed to bind detached PTY stream listener")?;

    // Determine whether subprocess isolation is requested.  This is opt-in
    // via the spec's `isolation_mode` field or the environment variable
    // `CONDUCTOR_PTY_SUBPROCESS_ISOLATION=1`.
    let use_subprocess_isolation = spec
        .isolation_mode
        .as_deref()
        .map(|m| m == DETACHED_PTY_SUBPROCESS_ISOLATION_MODE)
        .unwrap_or(false)
        || std::env::var("CONDUCTOR_PTY_SUBPROCESS_ISOLATION")
            .map(|v| v.trim().eq_ignore_ascii_case("1") || v.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);

    let (capture_tx, capture_rx) = mpsc::channel(DETACHED_CAPTURE_CHANNEL_CAPACITY);
    tokio::spawn(run_detached_capture_writer(
        spec.log_path.clone(),
        capture_rx,
    ));

    let (stream_tx, _) = broadcast::channel(2048);
    let log_offset = Arc::new(AtomicU64::new(0));

    let (child_pid, writer, master, child) = if use_subprocess_isolation {
        tracing::debug!("detached PTY host: using subprocess isolation mode");
        let handle = spawn_isolated_pty(
            &spec,
            stream_tx.clone(),
            capture_tx.clone(),
            log_offset.clone(),
        )
        .await?;
        (handle.child_pid, handle.writer, handle.master, handle.child)
    } else {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: spec.rows.max(1),
            cols: spec.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&spec.binary);
        cmd.cwd(&spec.cwd);
        for arg in &spec.args {
            cmd.arg(arg);
        }
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let child_pid = child.process_id().unwrap_or(0);
        let reader = pair.master.try_clone_reader()?;
        let writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>> =
            Arc::new(StdMutex::new(pair.master.take_writer()?));
        let master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>> =
            Arc::new(StdMutex::new(Some(pair.master)));
        let child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>> =
            Arc::new(StdMutex::new(child));

        // Spawn the output reader thread for the in-process (non-isolated) path.
        let stream_tx_for_output = stream_tx.clone();
        let capture_tx_for_output = capture_tx.clone();
        let log_offset_for_output = log_offset.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buffer = [0_u8; 4096];
            loop {
                match std::io::Read::read(&mut reader, &mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let offset = log_offset_for_output
                            .fetch_add(read as u64, Ordering::Relaxed);
                        let chunk = DetachedPtyOutputChunk {
                            offset,
                            bytes: Arc::<[u8]>::from(buffer[..read].to_vec()),
                        };
                        // Prioritize the live stream before durable capture so reconnect safety
                        // does not add avoidable latency to the active terminal path.
                        let _ = stream_tx_for_output
                            .send(DetachedPtyHostStreamMessage::Data(chunk.clone()));
                        if capture_tx_for_output
                            .try_send(DetachedPtyHostCaptureMessage::Data(chunk.clone()))
                            .or_else(|error| match error {
                                mpsc::error::TrySendError::Full(message) => capture_tx_for_output
                                    .blocking_send(message)
                                    .map_err(|_| {
                                        mpsc::error::TrySendError::Closed(
                                            DetachedPtyHostCaptureMessage::Shutdown,
                                        )
                                    }),
                                mpsc::error::TrySendError::Closed(message) => {
                                    Err(mpsc::error::TrySendError::Closed(message))
                                }
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        (child_pid, writer, master, child)
    };

    let shared = Arc::new(DetachedHostState {
        protocol_version: spec.protocol_version,
        token: spec.token.clone(),
        child_pid,
        writer,
        master,
        child,
        capture_tx: capture_tx.clone(),
        stream_tx,
        log_offset: {
            // Transfer the Arc<AtomicU64> value into the owned AtomicU64 in
            // DetachedHostState.  Both paths have been writing through the Arc
            // so we read the current count here.
            AtomicU64::new(log_offset.load(Ordering::Relaxed))
        },
        log_path: spec.log_path.clone(),
        stream_batch: DetachedStreamBatchConfig {
            flush_interval: Duration::from_millis(spec.stream_flush_interval_ms.max(1)),
            max_batch_bytes: spec.stream_max_batch_bytes.max(1024),
        },
    });

    let ready = DetachedPtyHostReady {
        protocol_version: spec.protocol_version,
        host_pid: std::process::id(),
        child_pid,
    };
    tokio::fs::write(&spec.ready_path, serde_json::to_vec(&ready)?).await?;

    let shutdown = Arc::new(Notify::new());
    let shutdown_for_wait = shutdown.clone();
    let exit_path = spec.exit_path.clone();
    let shared_for_wait = shared.clone();
    // When subprocess isolation is active the monitor task in `pty_subprocess`
    // already emits Error/Exit stream frames and sends the Capture::Shutdown
    // message.  The waiter below is still responsible for writing the exit
    // file and triggering the host-level shutdown notification.
    tokio::spawn(async move {
        let result = wait_for_detached_child(shared_for_wait.child.clone()).await;
        if let Ok(mut guard) = shared_for_wait.master.lock() {
            guard.take();
        }

        let stream_offset = shared_for_wait.log_offset.load(Ordering::Relaxed);
        let stream_error = result.as_ref().err().map(ToString::to_string);
        let exit_code = result.unwrap_or(-1);

        let _ = flush_detached_capture(&shared_for_wait.capture_tx).await;
        let _ = tokio::fs::write(&exit_path, exit_code.to_string()).await;

        if !use_subprocess_isolation {
            // Subprocess isolation mode: the monitor task in pty_subprocess.rs
            // already sent these frames; skip them here to avoid duplicates.
            if let Some(message) = stream_error {
                let _ = shared_for_wait
                    .stream_tx
                    .send(DetachedPtyHostStreamMessage::Error {
                        offset: stream_offset,
                        message,
                    });
            }
            let _ = shared_for_wait
                .stream_tx
                .send(DetachedPtyHostStreamMessage::Exit {
                    offset: stream_offset,
                    exit_code,
                });
            let _ = shared_for_wait
                .capture_tx
                .send(DetachedPtyHostCaptureMessage::Shutdown)
                .await;
        }

        shutdown_for_wait.notify_waiters();
    });

    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = control_listener.accept() => {
                let (stream, _) = accepted?;
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _ = handle_detached_host_connection(stream, shared).await;
                });
            }
            accepted = stream_listener.accept() => {
                let (stream, _) = accepted?;
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _ = handle_detached_stream_connection(stream, shared).await;
                });
            }
        }
    }

    let _ = tokio::fs::remove_file(&spec.control_socket_path).await;
    let _ = tokio::fs::remove_file(&spec.stream_socket_path).await;
    Ok(())
}

#[cfg(not(unix))]
pub async fn run_detached_pty_host(_spec_path: PathBuf) -> Result<()> {
    Err(anyhow::anyhow!(
        "Detached PTY host is only supported on Unix platforms"
    ))
}

#[cfg(unix)]
async fn handle_detached_host_connection(
    stream: UnixStream,
    state: Arc<DetachedHostState>,
) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = reader.read_until(b'\n', &mut line).await?;
        if count == 0 {
            return Ok(());
        }
        let request = serde_json::from_slice::<DetachedPtyHostRequest>(&line)
            .context("Failed to parse detached PTY host request")?;
        let mut kill_after_response = false;
        let response =
            if let Err(error) = ensure_detached_protocol_version(request.protocol_version) {
                DetachedPtyHostResponse {
                    protocol_version: state.protocol_version,
                    ok: false,
                    child_pid: Some(state.child_pid),
                    error: Some(error.to_string()),
                }
            } else if request.token != state.token {
                DetachedPtyHostResponse {
                    protocol_version: state.protocol_version,
                    ok: false,
                    child_pid: Some(state.child_pid),
                    error: Some("Unauthorized detached PTY host request".to_string()),
                }
            } else {
                match request.command {
                    DetachedPtyHostCommand::Ping => DetachedPtyHostResponse {
                        protocol_version: state.protocol_version,
                        ok: true,
                        child_pid: Some(state.child_pid),
                        error: None,
                    },
                    DetachedPtyHostCommand::Text { text } => {
                        write_detached_host_input(&state.writer, &text, true).await?;
                        DetachedPtyHostResponse {
                            protocol_version: state.protocol_version,
                            ok: true,
                            child_pid: Some(state.child_pid),
                            error: None,
                        }
                    }
                    DetachedPtyHostCommand::Raw { data } => {
                        write_detached_host_input(&state.writer, &data, false).await?;
                        DetachedPtyHostResponse {
                            protocol_version: state.protocol_version,
                            ok: true,
                            child_pid: Some(state.child_pid),
                            error: None,
                        }
                    }
                    DetachedPtyHostCommand::Resize { cols, rows } => {
                        resize_detached_host(&state.master, cols, rows).await?;
                        DetachedPtyHostResponse {
                            protocol_version: state.protocol_version,
                            ok: true,
                            child_pid: Some(state.child_pid),
                            error: None,
                        }
                    }
                    DetachedPtyHostCommand::Kill => {
                        kill_after_response = true;
                        DetachedPtyHostResponse {
                            protocol_version: state.protocol_version,
                            ok: true,
                            child_pid: Some(state.child_pid),
                            error: None,
                        }
                    }
                }
            };

        reader
            .get_mut()
            .write_all(&serde_json::to_vec(&response)?)
            .await?;
        reader.get_mut().write_all(b"\n").await?;
        reader.get_mut().flush().await?;

        if kill_after_response {
            kill_detached_host_child(&state.child).await?;
            return Ok(());
        }
    }
}

#[cfg(unix)]
async fn handle_detached_stream_connection(
    stream: UnixStream,
    state: Arc<DetachedHostState>,
) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let count = reader.read_until(b'\n', &mut line).await?;
    if count == 0 {
        return Ok(());
    }
    let request = serde_json::from_slice::<DetachedPtyHostStreamRequest>(&line)
        .context("Failed to parse detached PTY stream request")?;
    let mut stream = reader.into_inner();
    if let Err(error) = ensure_detached_protocol_version(request.protocol_version) {
        let response = DetachedPtyHostStreamResponse {
            protocol_version: state.protocol_version,
            ok: false,
            child_pid: Some(state.child_pid),
            error: Some(error.to_string()),
        };
        stream.write_all(&serde_json::to_vec(&response)?).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        return Ok(());
    }
    if request.token != state.token {
        let response = DetachedPtyHostStreamResponse {
            protocol_version: state.protocol_version,
            ok: false,
            child_pid: Some(state.child_pid),
            error: Some("Unauthorized detached PTY stream request".to_string()),
        };
        stream.write_all(&serde_json::to_vec(&response)?).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        return Ok(());
    }

    let rx = state.stream_tx.subscribe();

    flush_detached_capture(&state.capture_tx).await?;
    let replay_limit = detached_log_len(&state.log_path).await?;
    let response = DetachedPtyHostStreamResponse {
        protocol_version: state.protocol_version,
        ok: true,
        child_pid: Some(state.child_pid),
        error: None,
    };
    stream.write_all(&serde_json::to_vec(&response)?).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    forward_detached_host_stream(
        stream,
        state.log_path.clone(),
        request.offset,
        replay_limit,
        state.stream_batch,
        rx,
    )
    .await
}

#[cfg(unix)]
async fn forward_detached_host_stream(
    mut stream: UnixStream,
    log_path: PathBuf,
    requested_offset: u64,
    replay_limit: u64,
    stream_batch: DetachedStreamBatchConfig,
    mut rx: broadcast::Receiver<DetachedPtyHostStreamMessage>,
) -> Result<()> {
    let mut stream_floor = requested_offset.min(replay_limit);
    replay_detached_log_range(&mut stream, &log_path, stream_floor, replay_limit).await?;
    stream_floor = replay_limit;

    let mut pending_offset = None;
    let mut pending = Vec::new();
    let mut flush_deadline = None;

    loop {
        if let Some(deadline) = flush_deadline {
            tokio::select! {
                recv_result = rx.recv() => {
                    match recv_result {
                        Ok(message) => {
                            if handle_detached_host_stream_message(
                                &mut stream,
                                &mut stream_floor,
                                &mut pending_offset,
                                &mut pending,
                                &mut flush_deadline,
                                stream_batch,
                                message,
                            )
                            .await? {
                                return Ok(());
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            flush_detached_stream_batch(&mut stream, &mut pending_offset, &mut pending).await?;
                            return Ok(());
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(
                                "Detached PTY stream receiver lagged by {} messages; catching up from durable log",
                                n
                            );
                        }
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    flush_detached_stream_batch(&mut stream, &mut pending_offset, &mut pending).await?;
                    flush_deadline = None;
                }
            }
        } else {
            match rx.recv().await {
                Ok(message) => {
                    if handle_detached_host_stream_message(
                        &mut stream,
                        &mut stream_floor,
                        &mut pending_offset,
                        &mut pending,
                        &mut flush_deadline,
                        stream_batch,
                        message,
                    )
                    .await?
                    {
                        return Ok(());
                    }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    flush_detached_stream_batch(&mut stream, &mut pending_offset, &mut pending).await?;
                    return Ok(());
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "Detached PTY stream receiver lagged by {} messages; catching up from durable log",
                        n
                    );
                }
            }
        }
    }
}

#[cfg(unix)]
async fn handle_detached_host_stream_message(
    stream: &mut UnixStream,
    stream_floor: &mut u64,
    pending_offset: &mut Option<u64>,
    pending: &mut Vec<u8>,
    flush_deadline: &mut Option<tokio::time::Instant>,
    stream_batch: DetachedStreamBatchConfig,
    message: DetachedPtyHostStreamMessage,
) -> Result<bool> {
    match message {
        DetachedPtyHostStreamMessage::Data(chunk) => {
            let chunk_end = chunk.offset + chunk.bytes.len() as u64;
            if chunk_end <= *stream_floor {
                return Ok(false);
            }
            let skip = stream_floor.saturating_sub(chunk.offset) as usize;
            let effective_offset = chunk.offset + skip as u64;
            let bytes = &chunk.bytes[skip..];
            if bytes.is_empty() {
                *stream_floor = (*stream_floor).max(chunk_end);
                return Ok(false);
            }

            let expected_offset = pending_offset.map(|offset| offset + pending.len() as u64);
            if expected_offset.is_some() && expected_offset != Some(effective_offset) {
                flush_detached_stream_batch(stream, pending_offset, pending).await?;
                *flush_deadline = None;
            }
            if pending_offset.is_none() {
                *pending_offset = Some(effective_offset);
                *flush_deadline = Some(tokio::time::Instant::now() + stream_batch.flush_interval);
            }
            pending.extend_from_slice(bytes);
            *stream_floor = (*stream_floor).max(chunk_end);

            if pending.len() >= stream_batch.max_batch_bytes {
                flush_detached_stream_batch(stream, pending_offset, pending).await?;
                *flush_deadline = None;
            }

            Ok(false)
        }
        DetachedPtyHostStreamMessage::Exit { offset, exit_code } => {
            flush_detached_stream_batch(stream, pending_offset, pending).await?;
            let payload = exit_code.to_be_bytes();
            write_detached_stream_frame(
                stream,
                DetachedPtyStreamFrameKind::Exit,
                offset.max(*stream_floor),
                &payload,
            )
            .await?;
            stream.flush().await?;
            Ok(true)
        }
        DetachedPtyHostStreamMessage::Error { offset, message } => {
            flush_detached_stream_batch(stream, pending_offset, pending).await?;
            write_detached_stream_frame(
                stream,
                DetachedPtyStreamFrameKind::Error,
                offset.max(*stream_floor),
                message.as_bytes(),
            )
            .await?;
            stream.flush().await?;
            Ok(true)
        }
    }
}

#[cfg(unix)]
async fn replay_detached_log_range(
    stream: &mut UnixStream,
    log_path: &std::path::Path,
    start_offset: u64,
    end_offset: u64,
) -> Result<()> {
    if end_offset <= start_offset {
        return Ok(());
    }

    use tokio::io::{AsyncSeekExt, SeekFrom};
    let mut file = match OpenOptions::new().read(true).open(log_path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    file.seek(SeekFrom::Start(start_offset)).await?;

    let mut current_offset = start_offset;
    let mut buffer = vec![0_u8; DETACHED_STREAM_MAX_BATCH_BYTES.min(64 * 1024)];
    while current_offset < end_offset {
        let remaining = (end_offset - current_offset) as usize;
        let read_len = remaining.min(buffer.len());
        let read = file.read(&mut buffer[..read_len]).await?;
        if read == 0 {
            break;
        }
        write_detached_stream_frame(
            stream,
            DetachedPtyStreamFrameKind::Data,
            current_offset,
            &buffer[..read],
        )
        .await?;
        current_offset += read as u64;
    }

    stream.flush().await?;
    Ok(())
}

#[cfg(unix)]
async fn flush_detached_stream_batch(
    stream: &mut UnixStream,
    pending_offset: &mut Option<u64>,
    pending: &mut Vec<u8>,
) -> Result<()> {
    let Some(offset) = pending_offset.take() else {
        pending.clear();
        return Ok(());
    };
    if pending.is_empty() {
        return Ok(());
    }
    write_detached_stream_frame(stream, DetachedPtyStreamFrameKind::Data, offset, pending).await?;
    stream.flush().await?;
    pending.clear();
    Ok(())
}

#[cfg(unix)]
async fn run_detached_capture_writer(
    log_path: PathBuf,
    mut rx: mpsc::Receiver<DetachedPtyHostCaptureMessage>,
) {
    let _ = async {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .await?;
        let mut writer = BufWriter::with_capacity(DETACHED_CAPTURE_BUFFER_CAPACITY, file);
        let mut pending_bytes = 0usize;
        let mut dirty = false;

        loop {
            tokio::select! {
                maybe_message = rx.recv() => {
                    let Some(message) = maybe_message else {
                        if dirty {
                            writer.flush().await?;
                        }
                        return Ok::<(), anyhow::Error>(());
                    };
                    match message {
                        DetachedPtyHostCaptureMessage::Data(chunk) => {
                            writer.write_all(&chunk.bytes).await?;
                            pending_bytes = pending_bytes.saturating_add(chunk.bytes.len());
                            dirty = true;
                            if pending_bytes >= DETACHED_CAPTURE_FORCE_FLUSH_BYTES {
                                writer.flush().await?;
                                pending_bytes = 0;
                                dirty = false;
                            }
                        }
                        DetachedPtyHostCaptureMessage::Flush { ack } => {
                            if dirty {
                                writer.flush().await?;
                                pending_bytes = 0;
                                dirty = false;
                            }
                            let _ = ack.send(());
                        }
                        DetachedPtyHostCaptureMessage::Shutdown => {
                            if dirty {
                                writer.flush().await?;
                            }
                            return Ok(());
                        }
                    }
                }
                _ = tokio::time::sleep(DETACHED_CAPTURE_FLUSH_INTERVAL), if dirty => {
                    writer.flush().await?;
                    pending_bytes = 0;
                    dirty = false;
                }
            }
        }
    }
    .await;
}

#[cfg(unix)]
async fn flush_detached_capture(
    capture_tx: &mpsc::Sender<DetachedPtyHostCaptureMessage>,
) -> Result<()> {
    let (ack_tx, ack_rx) = oneshot::channel();
    capture_tx
        .send(DetachedPtyHostCaptureMessage::Flush { ack: ack_tx })
        .await
        .map_err(|_| anyhow!("Detached PTY capture channel is unavailable"))?;
    ack_rx
        .await
        .map_err(|_| anyhow!("Detached PTY capture flush acknowledgement was dropped"))?;
    Ok(())
}

#[cfg(unix)]
async fn write_detached_host_input(
    writer: &Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    value: &str,
    logical_text: bool,
) -> Result<()> {
    let writer = writer.clone();
    let value = value.to_string();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut writer = writer.lock().unwrap_or_else(|error| error.into_inner());
        writer.write_all(value.as_bytes())?;
        if logical_text && !value.ends_with('\n') && !value.ends_with('\r') {
            writer.write_all(b"\r")?;
        }
        writer.flush()?;
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
async fn resize_detached_host(
    master: &Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let master = master.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut guard = master.lock().unwrap_or_else(|error| error.into_inner());
        let Some(master) = guard.as_mut() else {
            return Ok(());
        };
        master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
async fn kill_detached_host_child(
    child: &Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> Result<()> {
    let child = child.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
        #[cfg(unix)]
        {
            if let Some(pid) = child.process_id() {
                terminate_detached_host_process_tree(pid, Duration::from_secs(1));
                let _ = child.wait();
                return Ok(());
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(unix)]
fn terminate_detached_host_process_tree(root_pid: u32, timeout: Duration) {
    if root_pid == 0 || root_pid > i32::MAX as u32 {
        return;
    }

    let pid = root_pid as libc::pid_t;
    let host_pgid = unsafe { libc::getpgrp() };
    let pgid = unsafe { libc::getpgid(pid) };
    let target_pgid = (pgid > 0 && pgid != host_pgid).then_some(pgid);

    if let Some(pgid) = target_pgid {
        let _ = send_detached_host_signal(-pgid, libc::SIGTERM);
    }
    let _ = send_detached_host_signal(pid, libc::SIGTERM);

    if wait_for_detached_host_exit(root_pid, timeout) {
        return;
    }

    if let Some(pgid) = target_pgid {
        let _ = send_detached_host_signal(-pgid, libc::SIGKILL);
    }
    let _ = send_detached_host_signal(pid, libc::SIGKILL);
    let _ = wait_for_detached_host_exit(root_pid, Duration::from_millis(250));
}

#[cfg(unix)]
fn wait_for_detached_host_exit(pid: u32, timeout: Duration) -> bool {
    let poll_interval = Duration::from_millis(50);
    let iterations = (timeout.as_millis() / poll_interval.as_millis()).max(1) as usize;

    for _ in 0..iterations {
        if !crate::state::workspace::is_process_alive(pid) {
            return true;
        }
        std::thread::sleep(poll_interval);
    }

    !crate::state::workspace::is_process_alive(pid)
}

#[cfg(unix)]
fn send_detached_host_signal(pid: libc::pid_t, signal: libc::c_int) -> bool {
    let result = unsafe { libc::kill(pid, signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(unix)]
async fn wait_for_detached_child(
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> Result<i32> {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child = child.clone();
        match tokio::task::spawn_blocking(move || {
            let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
            child.try_wait()
        })
        .await
        {
            Ok(Ok(Some(status))) => return Ok(status.exit_code() as i32),
            Ok(Ok(None)) => continue,
            Ok(Err(error)) => return Err(error.into()),
            Err(error) => return Err(anyhow!(error.to_string())),
        }
    }
}
