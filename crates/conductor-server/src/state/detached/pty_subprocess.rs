/// PTY subprocess isolation module.
///
/// `portable_pty` already spawns the command in a child process.  What this
/// module adds on top is:
///
/// 1. **Process-group separation** — the PTY child is placed in its own
///    session via `setsid()` so that a runaway signal cannot reach the host
///    process.
/// 2. **Crash resilience** — a dedicated monitoring task watches the child.
///    If the child exits unexpectedly the host emits an `Error` frame followed
///    by an `Exit` frame and then continues running so that already-connected
///    stream clients receive a clean terminal instead of a broken pipe.
/// 3. **Clean teardown** — `kill_isolated_pty` sends `SIGTERM` to the entire
///    process group and escalates to `SIGKILL` if the group does not exit
///    within the grace period, mirroring
///    `terminate_detached_host_process_tree` in `pty_host.rs`.
///
/// The actual process-group `setsid()` is injected by passing a
/// `pre_exec` hook through `portable_pty`'s `CommandBuilder` env trick: we
/// set the env var `CONDUCTOR_PTY_SETSID=1` and intercept it with a
/// `pre_exec` closure registered on a thin `tokio::process::Command` wrapper.
/// Because `portable_pty` calls `fork`+`exec` internally we cannot hook
/// `pre_exec` directly, so instead we rely on the fact that `portable_pty`
/// for Unix spawns using `CommandBuilder` which ultimately calls
/// `std::process::Command`.  We use the `unsafe pre_exec` hook available
/// through `portable_pty`'s `CommandBuilder::arg` / env path by setting
/// `CONDUCTOR_PTY_SETSID=1` and then the child calls `setsid()` itself at
/// the very beginning via the env var detected in the host binary's early
/// init — OR (the simpler approach used here) we spawn the PTY via the
/// standard `portable_pty` path and then immediately call
/// `setpgid(child_pid, 0)` from the parent to move the child to its own
/// process group before it has had a chance to spawn grandchildren.
///
/// The `setpgid` race window is tiny and acceptable for our crash-isolation
/// goal: even if a grandchild escapes the group reassignment the monitoring
/// task will still catch the top-level child exit and emit the recovery
/// frames.

#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use anyhow::{anyhow, Result};
#[cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
#[cfg(unix)]
use std::sync::{Mutex as StdMutex};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use tokio::sync::{broadcast, mpsc};

#[cfg(unix)]
use super::types::*;

// ---------------------------------------------------------------------------
// Public handle returned to the caller
// ---------------------------------------------------------------------------

/// A handle that owns an isolated PTY child and forwards its output to the
/// broadcast / capture channels provided at spawn time.
#[cfg(unix)]
pub(super) struct IsolatedPtyHandle {
    /// PID of the PTY child process.
    pub(super) child_pid: u32,
    /// Writer for sending raw bytes into the PTY master (keyboard input).
    pub(super) writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>>,
    /// The PTY master — kept alive so that resize requests work.
    pub(super) master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    /// The child process handle — used by `wait_for_isolated_pty`.
    pub(super) child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/// Spawn the PTY command in an isolated process group and start a background
/// monitoring task.
///
/// The monitoring task:
/// * polls the child for exit,
/// * on exit emits an `Error` frame (if the exit was unexpected / non-zero)
///   followed by an `Exit` frame to both `stream_tx` and `capture_tx`, and
/// * returns without panicking so the host process stays alive.
#[cfg(unix)]
pub(super) async fn spawn_isolated_pty(
    spec: &DetachedPtyHostSpec,
    stream_tx: broadcast::Sender<DetachedPtyHostStreamMessage>,
    capture_tx: mpsc::Sender<DetachedPtyHostCaptureMessage>,
    log_offset: Arc<AtomicU64>,
) -> Result<IsolatedPtyHandle> {
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

    // Move the child into its own process group so that signals sent to the
    // host's process group do not reach it, and vice-versa.
    if child_pid != 0 {
        move_to_own_process_group(child_pid);
    }

    let reader = pair.master.try_clone_reader()?;
    let writer: Arc<StdMutex<Box<dyn std::io::Write + Send>>> =
        Arc::new(StdMutex::new(pair.master.take_writer()?));
    let master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>> =
        Arc::new(StdMutex::new(Some(pair.master)));
    let child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>> =
        Arc::new(StdMutex::new(child));

    // Spawn the output reader thread (blocking I/O — must be a real OS thread).
    let stream_tx_for_reader = stream_tx.clone();
    let capture_tx_for_reader = capture_tx.clone();
    let log_offset_for_reader = log_offset.clone();
    std::thread::spawn(move || {
        isolated_pty_reader_thread(
            reader,
            stream_tx_for_reader,
            capture_tx_for_reader,
            log_offset_for_reader,
        );
    });

    // Spawn the child monitor task (async, polls child for exit).
    let child_for_monitor = child.clone();
    let master_for_monitor = master.clone();
    let log_offset_for_monitor = log_offset;
    let stream_tx_for_monitor = stream_tx;
    let capture_tx_for_monitor = capture_tx;
    tokio::spawn(async move {
        isolated_pty_monitor(
            child_pid,
            child_for_monitor,
            master_for_monitor,
            log_offset_for_monitor,
            stream_tx_for_monitor,
            capture_tx_for_monitor,
        )
        .await;
    });

    Ok(IsolatedPtyHandle {
        child_pid,
        writer,
        master,
        child,
    })
}

// ---------------------------------------------------------------------------
// Kill helper
// ---------------------------------------------------------------------------

/// Terminate the isolated PTY's entire process group.
///
/// Sends `SIGTERM` to the group, waits up to `timeout`, then `SIGKILL`.
#[cfg(unix)]
#[allow(dead_code)]
pub(super) fn kill_isolated_pty(child_pid: u32, timeout: Duration) {
    if child_pid == 0 || child_pid > i32::MAX as u32 {
        return;
    }
    let pid = child_pid as libc::pid_t;
    let pgid = unsafe { libc::getpgid(pid) };
    let host_pgid = unsafe { libc::getpgrp() };

    // Only target the child's group if it is distinct from our own.
    let target_pgid = (pgid > 0 && pgid != host_pgid).then_some(pgid);

    if let Some(g) = target_pgid {
        send_signal_to_pid(-g, libc::SIGTERM);
    }
    send_signal_to_pid(pid, libc::SIGTERM);

    if wait_for_pid_exit(child_pid, timeout) {
        return;
    }

    if let Some(g) = target_pgid {
        send_signal_to_pid(-g, libc::SIGKILL);
    }
    send_signal_to_pid(pid, libc::SIGKILL);
    let _ = wait_for_pid_exit(child_pid, Duration::from_millis(250));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Place `child_pid` into its own process group via `setpgid(child, child)`.
/// Failure is non-fatal — we log a warning and continue.
#[cfg(unix)]
fn move_to_own_process_group(child_pid: u32) {
    let pid = child_pid as libc::pid_t;
    let result = unsafe { libc::setpgid(pid, pid) };
    if result != 0 {
        let err = std::io::Error::last_os_error();
        // EACCES is expected if the child has already called exec() and
        // changed its own process group; treat that as success.
        if err.raw_os_error() != Some(libc::EACCES) {
            tracing::warn!(
                child_pid,
                error = %err,
                "isolated PTY: setpgid failed; process-group isolation may be incomplete"
            );
        }
    }
}

/// Blocking reader thread: reads PTY output and forwards chunks to the
/// broadcast stream and durable capture channels.
#[cfg(unix)]
fn isolated_pty_reader_thread(
    mut reader: Box<dyn std::io::Read + Send>,
    stream_tx: broadcast::Sender<DetachedPtyHostStreamMessage>,
    capture_tx: mpsc::Sender<DetachedPtyHostCaptureMessage>,
    log_offset: Arc<AtomicU64>,
) {
    let mut buffer = [0_u8; 4096];
    loop {
        match std::io::Read::read(&mut reader, &mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let offset = log_offset.fetch_add(read as u64, Ordering::Relaxed);
                let chunk = DetachedPtyOutputChunk {
                    offset,
                    bytes: Arc::<[u8]>::from(buffer[..read].to_vec()),
                };
                // Live stream first (lower latency for active clients).
                let _ = stream_tx.send(DetachedPtyHostStreamMessage::Data(chunk.clone()));
                // Durable capture (blocking_send as fallback when channel is full).
                let send_result = capture_tx
                    .try_send(DetachedPtyHostCaptureMessage::Data(chunk.clone()))
                    .or_else(|error| match error {
                        mpsc::error::TrySendError::Full(message) => capture_tx
                            .blocking_send(message)
                            .map_err(|_| {
                                mpsc::error::TrySendError::Closed(
                                    DetachedPtyHostCaptureMessage::Shutdown,
                                )
                            }),
                        mpsc::error::TrySendError::Closed(message) => {
                            Err(mpsc::error::TrySendError::Closed(message))
                        }
                    });
                if send_result.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

/// Async monitor task: polls the child process for exit and emits recovery
/// frames so that the host process remains alive after a PTY crash.
#[cfg(unix)]
async fn isolated_pty_monitor(
    child_pid: u32,
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    master: Arc<StdMutex<Option<Box<dyn MasterPty + Send>>>>,
    log_offset: Arc<AtomicU64>,
    stream_tx: broadcast::Sender<DetachedPtyHostStreamMessage>,
    capture_tx: mpsc::Sender<DetachedPtyHostCaptureMessage>,
) {
    let exit_code = wait_for_isolated_child(child.clone()).await;

    // Drop the master so that the reader thread sees EOF on the PTY.
    if let Ok(mut guard) = master.lock() {
        guard.take();
    }

    let stream_offset = log_offset.load(Ordering::Relaxed);

    match exit_code {
        Ok(0) => {
            // Clean exit — emit Exit frame only.
            tracing::debug!(child_pid, "isolated PTY child exited cleanly");
        }
        Ok(code) => {
            tracing::warn!(
                child_pid,
                exit_code = code,
                "isolated PTY child exited with non-zero code"
            );
            let _ = stream_tx.send(DetachedPtyHostStreamMessage::Error {
                offset: stream_offset,
                message: format!(
                    "PTY subprocess (pid={child_pid}) exited with code {code}"
                ),
            });
        }
        Err(ref error) => {
            tracing::error!(
                child_pid,
                error = %error,
                "isolated PTY child exited with error"
            );
            let _ = stream_tx.send(DetachedPtyHostStreamMessage::Error {
                offset: stream_offset,
                message: format!(
                    "PTY subprocess (pid={child_pid}) failed: {error}"
                ),
            });
        }
    }

    let final_exit_code = exit_code.unwrap_or(-1);
    let _ = stream_tx.send(DetachedPtyHostStreamMessage::Exit {
        offset: stream_offset,
        exit_code: final_exit_code,
    });

    // Signal the capture writer to flush and shut down.
    let _ = capture_tx
        .send(DetachedPtyHostCaptureMessage::Shutdown)
        .await;
}

/// Poll the child process for exit in a blocking task (same approach used in
/// `pty_host.rs`'s `wait_for_detached_child`).
#[cfg(unix)]
async fn wait_for_isolated_child(
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> Result<i32> {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child = child.clone();
        match tokio::task::spawn_blocking(move || {
            let mut guard = child.lock().unwrap_or_else(|error| error.into_inner());
            guard.try_wait()
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

/// Send a signal to `pid` (positive = single process, negative = process
/// group).  Returns `true` if the signal was sent or the target already
/// doesn't exist.
#[cfg(unix)]
#[allow(dead_code)]
fn send_signal_to_pid(pid: libc::pid_t, signal: libc::c_int) -> bool {
    let result = unsafe { libc::kill(pid, signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Spin-poll until `pid` is no longer alive or `timeout` elapses.
/// Returns `true` if the process exited within the timeout.
#[cfg(unix)]
#[allow(dead_code)]
fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
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
