#[cfg(unix)]
use anyhow::Result;
#[cfg(unix)]
use conductor_executors::executor::ExecutorOutput;
#[cfg(unix)]
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use tokio::fs::OpenOptions;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
use super::helpers::{
    emit_detached_runtime_error, emit_detached_runtime_exit, flush_detached_partial_line,
    read_detached_exit_code, split_detached_log_lines,
};
#[cfg(unix)]
use super::types::{
    DetachedOutputForwarder, DETACHED_EXIT_WAIT_TIMEOUT, DETACHED_LOG_WATCH_FALLBACK_INTERVAL,
};
#[cfg(unix)]
use crate::state::AppState;

#[cfg(unix)]
impl AppState {
    pub(super) async fn forward_detached_log_output(
        self: std::sync::Arc<Self>,
        forwarder: DetachedOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        let DetachedOutputForwarder {
            session_id,
            metadata,
            mut offset,
        } = forwarder;
        tracing::warn!(session_id, "Using deprecated log-tail output path; stream transport is preferred");
        let (_watcher, mut log_events) = watch_detached_log(&metadata.log_path)?;
        let mut partial = Vec::new();
        let mut exit_deadline = None;

        loop {
            if let Some((next_offset, chunk)) =
                read_detached_log_chunk(&metadata.log_path, offset).await?
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

            if !crate::state::workspace::is_process_alive(metadata.host_pid) {
                let deadline = exit_deadline.get_or_insert_with(|| {
                    tokio::time::Instant::now() + DETACHED_EXIT_WAIT_TIMEOUT
                });
                flush_detached_partial_line(&output_tx, &mut partial).await?;

                if let Some(exit_code) = read_detached_exit_code(&metadata.exit_path).await? {
                    emit_detached_runtime_exit(&self, &session_id, &output_tx, exit_code).await;
                    return Ok(());
                }

                if tokio::time::Instant::now() >= *deadline {
                    emit_detached_runtime_error(
                        &self,
                        &session_id,
                        &output_tx,
                        "Detached PTY runtime exited unexpectedly".to_string(),
                        None,
                    )
                    .await;
                    return Ok(());
                }
            } else {
                exit_deadline = None;
            }

            tokio::select! {
                event = log_events.recv() => {
                    if event.is_none() {
                        tokio::time::sleep(DETACHED_LOG_WATCH_FALLBACK_INTERVAL).await;
                    }
                }
                _ = tokio::time::sleep(DETACHED_LOG_WATCH_FALLBACK_INTERVAL) => {}
            }
        }
    }
}

#[cfg(unix)]
pub(super) async fn read_detached_log_chunk(
    log_path: &Path,
    offset: u64,
) -> Result<Option<(u64, Vec<u8>)>> {
    let mut file = match OpenOptions::new().read(true).open(log_path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    file.seek(SeekFrom::Start(offset)).await?;
    let mut chunk = Vec::new();
    file.read_to_end(&mut chunk).await?;
    if chunk.is_empty() {
        return Ok(None);
    }
    Ok(Some((offset + chunk.len() as u64, chunk)))
}

#[cfg(unix)]
pub(super) fn watch_detached_log(
    log_path: &Path,
) -> Result<(RecommendedWatcher, mpsc::UnboundedReceiver<()>)> {
    let watch_path = log_path.parent().unwrap_or(log_path).to_path_buf();
    let callback_path = log_path.to_path_buf();
    let (tx, rx) = mpsc::unbounded_channel();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| match res {
            Ok(event) => {
                if detached_log_event_matches(&callback_path, &event) {
                    let _ = tx.send(());
                }
            }
            Err(err) => {
                tracing::debug!(
                    path = %callback_path.display(),
                    error = %err,
                    "detached PTY log watcher callback error"
                );
            }
        },
        Config::default(),
    )?;
    watcher.watch(&watch_path, RecursiveMode::NonRecursive)?;
    Ok((watcher, rx))
}

#[cfg(unix)]
pub(super) fn detached_log_event_matches(log_path: &Path, event: &Event) -> bool {
    if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
        return false;
    }

    let parent = log_path.parent();
    event.paths.iter().any(|path| {
        path == log_path
            || parent
                .map(|candidate| path == candidate)
                .unwrap_or(false)
            || (path.parent().is_none() && path.file_name() == log_path.file_name())
    })
}
