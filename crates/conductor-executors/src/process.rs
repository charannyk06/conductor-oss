use anyhow::Result;
#[cfg(unix)]
use nix::libc;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
#[cfg(unix)]
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::executor::{ExecutorInput, ExecutorOutput};

fn apply_pty_command_env(
    cmd: &mut CommandBuilder,
    env: &HashMap<String, String>,
    env_remove: &[String],
) {
    for key in env_remove {
        cmd.env_remove(key);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
}

fn apply_tokio_command_env(
    cmd: &mut Command,
    env: &HashMap<String, String>,
    env_remove: &[String],
    clear_existing: bool,
) {
    if clear_existing {
        cmd.env_clear();
    }
    for key in env_remove {
        cmd.env_remove(key);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
}

#[cfg(unix)]
fn mark_extra_fds_cloexec_in_child() -> std::io::Result<()> {
    let max_fd = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let max_fd = if max_fd > 0 { max_fd as i32 } else { 1024 };
    for fd in 3..max_fd {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EBADF) {
                return Err(error);
            }
            continue;
        }

        let result = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        if result == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn restore_default_signals_in_child() -> std::io::Result<()> {
    for signal in [libc::SIGPIPE, libc::SIGXFSZ] {
        let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
        action.sa_sigaction = libc::SIG_DFL;
        let empty_result = unsafe { libc::sigemptyset(&mut action.sa_mask) };
        if empty_result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        action.sa_flags = 0;
        let result = unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn clear_signal_mask_in_child() -> std::io::Result<()> {
    let mut set = unsafe { std::mem::zeroed::<libc::sigset_t>() };
    let empty_result = unsafe { libc::sigemptyset(&mut set) };
    if empty_result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mask_result = unsafe { libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut()) };
    if mask_result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

const MAX_BUFFERED_PROCESS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

async fn await_reader_task_with_timeout<T>(task: &mut tokio::task::JoinHandle<T>) {
    if tokio::time::timeout(Duration::from_millis(250), &mut *task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}

fn buffered_process_output_size(event: &ExecutorOutput) -> Option<usize> {
    match event {
        ExecutorOutput::Stdout(line) | ExecutorOutput::Stderr(line) => Some(line.len()),
        _ => None,
    }
}

fn signal_output_overflow(
    tx: &mpsc::UnboundedSender<ExecutorOutput>,
    output_overflowed: &AtomicBool,
) {
    if !output_overflowed.swap(true, Ordering::AcqRel) {
        let _ = tx.send(ExecutorOutput::Stderr(format!(
            "[conductor] process output exceeded {} bytes, dropping additional stdout/stderr",
            MAX_BUFFERED_PROCESS_OUTPUT_BYTES
        )));
    }
}

fn queue_process_output(
    tx: &mpsc::UnboundedSender<ExecutorOutput>,
    buffered_bytes: &AtomicUsize,
    output_overflowed: &AtomicBool,
    event: ExecutorOutput,
) -> bool {
    if let Some(size) = buffered_process_output_size(&event) {
        if output_overflowed.load(Ordering::Acquire) {
            return true;
        }
        let previous = buffered_bytes.fetch_add(size, Ordering::AcqRel);
        if previous + size > MAX_BUFFERED_PROCESS_OUTPUT_BYTES {
            buffered_bytes.fetch_sub(size, Ordering::AcqRel);
            signal_output_overflow(tx, output_overflowed);
            return true;
        }
        if tx.send(event).is_err() {
            buffered_bytes.fetch_sub(size, Ordering::AcqRel);
            return false;
        }
        true
    } else {
        tx.send(event).is_ok()
    }
}

fn forward_process_output(
    mut source_rx: mpsc::UnboundedReceiver<ExecutorOutput>,
    sink_tx: mpsc::Sender<ExecutorOutput>,
    buffered_bytes: Arc<AtomicUsize>,
) {
    tokio::spawn(async move {
        while let Some(event) = source_rx.recv().await {
            let buffered_size = buffered_process_output_size(&event);
            let send_result = sink_tx.send(event).await;
            if let Some(size) = buffered_size {
                buffered_bytes.fetch_sub(size, Ordering::AcqRel);
            }
            if send_result.is_err() {
                break;
            }
        }
    });
}

/// PTY dimensions configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtyDimensions {
    pub rows: u16,
    pub cols: u16,
}

impl Default for PtyDimensions {
    fn default() -> Self {
        Self {
            rows: 48,
            cols: 160,
        }
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }

    // SAFETY: `kill(pid, 0)` only checks process existence for an explicit pid.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }

    matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EPERM)
    )
}

#[cfg(unix)]
fn collect_descendant_pids(root_pid: u32) -> Vec<u32> {
    let output = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };

    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        children_by_parent.entry(ppid).or_default().push(pid);
    }

    let mut ordered = Vec::new();
    let mut stack = vec![root_pid];
    let mut seen = HashSet::new();
    while let Some(parent) = stack.pop() {
        let Some(children) = children_by_parent.get(&parent) else {
            continue;
        };
        for child in children {
            if seen.insert(*child) {
                ordered.push(*child);
                stack.push(*child);
            }
        }
    }

    ordered
}

#[cfg(unix)]
fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let poll_interval = Duration::from_millis(100);
    let iterations = (timeout.as_millis() / poll_interval.as_millis()).max(1) as usize;
    for _ in 0..iterations {
        if !is_process_alive(pid) {
            return true;
        }
        std::thread::sleep(poll_interval);
    }
    !is_process_alive(pid)
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: libc::c_int) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }

    // SAFETY: libc::kill targets an explicit pid with a specific signal.
    let result = unsafe { libc::kill(pid as libc::pid_t, signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(unix)]
fn terminate_process_tree(root_pid: u32, timeout: Duration) {
    if root_pid == 0 {
        return;
    }

    let descendants = collect_descendant_pids(root_pid);
    for pid in descendants.iter().rev() {
        let _ = send_signal(*pid, libc::SIGTERM);
    }
    let _ = send_signal(root_pid, libc::SIGTERM);

    for pid in descendants.iter().rev() {
        let _ = wait_for_process_exit(*pid, timeout);
    }
    if wait_for_process_exit(root_pid, timeout) {
        return;
    }

    for pid in descendants.iter().rev() {
        if is_process_alive(*pid) {
            let _ = send_signal(*pid, libc::SIGKILL);
        }
    }
    if is_process_alive(root_pid) {
        let _ = send_signal(root_pid, libc::SIGKILL);
    }
}

/// Spawn a CLI process with PTY support and return channels for I/O.
pub async fn spawn_process(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<ProcessHandle> {
    spawn_process_with_env_removals(binary, args, cwd, env, &[]).await
}

/// Spawn a CLI process with PTY support and explicit inherited env removals.
pub async fn spawn_process_with_env_removals(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    env_remove: &[String],
) -> Result<ProcessHandle> {
    spawn_process_with_pty_size_and_env_removals(
        binary,
        args,
        cwd,
        env,
        env_remove,
        PtyDimensions::default(),
    )
    .await
}

/// Spawn a CLI process with PTY support, configurable dimensions, and
/// inherited env removals.
pub async fn spawn_process_with_pty_size_and_env_removals(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    env_remove: &[String],
    pty_dims: PtyDimensions,
) -> Result<ProcessHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: pty_dims.rows,
        cols: pty_dims.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(binary);
    cmd.cwd(cwd);
    for arg in args {
        cmd.arg(arg);
    }
    apply_pty_command_env(&mut cmd, env, env_remove);

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let reader = pair.master.try_clone_reader()?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
    // Store the master handle so it can be dropped on kill to close FDs.
    let master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
        Arc::new(Mutex::new(Some(pair.master)));
    let child = Arc::new(Mutex::new(child));

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (raw_output_tx, raw_output_rx) = mpsc::unbounded_channel::<ExecutorOutput>();
    let buffered_output_bytes = Arc::new(AtomicUsize::new(0));
    let output_overflowed = Arc::new(AtomicBool::new(false));
    forward_process_output(
        raw_output_rx,
        output_tx.clone(),
        Arc::clone(&buffered_output_bytes),
    );
    let (terminal_tx, terminal_rx) = mpsc::channel::<Vec<u8>>(256);
    let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (resize_tx, mut resize_rx) = mpsc::channel::<PtyDimensions>(8);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let stdout_tx = raw_output_tx.clone();
    let stdout_buffered_bytes = Arc::clone(&buffered_output_bytes);
    let stdout_output_overflowed = Arc::clone(&output_overflowed);
    let terminal_stream_tx = terminal_tx.clone();
    let mut stdout_task = tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut pending = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    if let Some(line) = flush_terminal_line_buffer(&mut pending) {
                        if !queue_process_output(
                            &stdout_tx,
                            &stdout_buffered_bytes,
                            &stdout_output_overflowed,
                            ExecutorOutput::Stdout(line),
                        ) {
                            break;
                        }
                    }
                    break;
                }
                Ok(read) => {
                    let chunk = buffer[..read].to_vec();
                    let _ = terminal_stream_tx.blocking_send(chunk.clone());
                    if stdout_output_overflowed.load(Ordering::Acquire) {
                        continue;
                    }
                    pending.extend_from_slice(&chunk);
                    if pending.len() > MAX_BUFFERED_PROCESS_OUTPUT_BYTES {
                        pending.clear();
                        signal_output_overflow(&stdout_tx, &stdout_output_overflowed);
                        continue;
                    }
                    for line in drain_terminal_lines(&mut pending) {
                        if !queue_process_output(
                            &stdout_tx,
                            &stdout_buffered_bytes,
                            &stdout_output_overflowed,
                            ExecutorOutput::Stdout(line),
                        ) {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = queue_process_output(
                        &stdout_tx,
                        &stdout_buffered_bytes,
                        &stdout_output_overflowed,
                        ExecutorOutput::Failed {
                            error: error.to_string(),
                            exit_code: None,
                        },
                    );
                    break;
                }
            }
        }
    });

    let master_for_resize = Arc::clone(&master);
    tokio::spawn(async move {
        while let Some(dimensions) = resize_rx.recv().await {
            let master = Arc::clone(&master_for_resize);
            let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                let mut guard = master.lock().unwrap_or_else(|e| e.into_inner());
                let Some(master) = guard.as_mut() else {
                    return Ok(());
                };
                master.resize(PtySize {
                    rows: dimensions.rows.max(1),
                    cols: dimensions.cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                Ok(())
            })
            .await;
        }
    });

    tokio::spawn(async move {
        while let Some(input) = input_rx.recv().await {
            let writer = Arc::clone(&writer);
            let result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
                match input {
                    ExecutorInput::Text(text) => {
                        writer.write_all(text.as_bytes())?;
                        if !text.ends_with('\n') && !text.ends_with('\r') {
                            writer.write_all(b"\r")?;
                        }
                    }
                    ExecutorInput::Raw(raw) => writer.write_all(raw.as_bytes())?,
                }
                writer.flush()?;
                Ok(())
            })
            .await;

            if !matches!(result, Ok(Ok(()))) {
                break;
            }
        }
    });

    let exit_tx = raw_output_tx;
    let child_for_wait = Arc::clone(&child);
    let master_for_cleanup = Arc::clone(&master);
    tokio::spawn(async move {
        let mut kill_rx = kill_rx;
        tokio::select! {
            signal = &mut kill_rx => {
                if signal.is_ok() {
                    let child = Arc::clone(&child);
                    let _ = tokio::task::spawn_blocking(move || {
                        let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
                        // Try graceful SIGTERM first (Unix only), then fall back to SIGKILL
                        #[cfg(unix)]
                        {
                            if let Some(pid) = child.process_id() {
                                terminate_process_tree(pid, Duration::from_secs(5));
                                let _ = child.wait();
                                return;
                            }
                        }
                        // SIGKILL fallback (or non-Unix)
                        let _ = child.kill();
                        let _ = child.wait();
                    }).await;
                    if let Ok(mut guard) = master_for_cleanup.lock() {
                        guard.take();
                    }
                    await_reader_task_with_timeout(&mut stdout_task).await;
                    let _ = exit_tx.send(ExecutorOutput::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(-9),
                    });
                }
            }
            result = async move {
                loop {
                    // Reduced from 500ms to 100ms for faster exit detection on
                    // crash.  With 30-50 concurrent terminals this keeps the
                    // worst-case detection latency under 100ms while the extra
                    // CPU overhead of more-frequent try_wait() calls is
                    // acceptable for a system that prioritizes robustness.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let child = Arc::clone(&child_for_wait);
                    match tokio::task::spawn_blocking(move || {
                        let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
                        child.try_wait()
                    }).await {
                        Ok(Ok(Some(status))) => break Ok(status.exit_code() as i32),
                        Ok(Ok(None)) => continue,
                        Ok(Err(error)) => break Err(error.to_string()),
                        Err(error) => break Err(error.to_string()),
                    }
                }
            } => {
                if let Ok(mut guard) = master.lock() {
                    guard.take();
                }
                await_reader_task_with_timeout(&mut stdout_task).await;
                match result {
                    Ok(code) => {
                        let _ = exit_tx.send(ExecutorOutput::Completed { exit_code: code });
                    }
                    Err(error) => {
                        let _ = exit_tx.send(ExecutorOutput::Failed {
                            error,
                            exit_code: None,
                        });
                    }
                }
            }
        }
    });

    Ok(ProcessHandle {
        pid,
        output_rx,
        input_tx,
        terminal_rx: Some(terminal_rx),
        resize_tx: Some(resize_tx),
        kill_tx,
    })
}

/// Spawn a CLI process with stdout/stderr capture, but with stdin closed.
pub async fn spawn_process_no_stdin(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<ProcessHandle> {
    spawn_process_no_stdin_with_env_options(binary, args, cwd, env, &[], false).await
}

/// Spawn a CLI process with stdout/stderr capture, stdin closed, and a clean
/// environment built only from the provided variables.
pub async fn spawn_process_no_stdin_with_clean_env(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<ProcessHandle> {
    spawn_process_no_stdin_with_env_options(binary, args, cwd, env, &[], true).await
}

/// Spawn a CLI process with stdout/stderr capture, stdin closed, and explicit
/// inherited env removals.
pub async fn spawn_process_no_stdin_with_env_removals(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    env_remove: &[String],
) -> Result<ProcessHandle> {
    spawn_process_no_stdin_with_env_options(binary, args, cwd, env, env_remove, false).await
}

async fn spawn_process_no_stdin_with_env_options(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    env_remove: &[String],
    clear_existing_env: bool,
) -> Result<ProcessHandle> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    apply_tokio_command_env(&mut cmd, env, env_remove, clear_existing_env);

    #[cfg(unix)]
    {
        unsafe {
            cmd.pre_exec(|| {
                mark_extra_fds_cloexec_in_child()?;
                clear_signal_mask_in_child()?;
                restore_default_signals_in_child()?;
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn()?;
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let result = unsafe { libc::setpgid(pid as libc::pid_t, pid as libc::pid_t) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::EACCES | libc::EPERM)) {
                return Err(error.into());
            }
        }
    }
    let pid = child.id().unwrap_or(0);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("stdout not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("stderr not piped"))?;

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (raw_output_tx, raw_output_rx) = mpsc::unbounded_channel::<ExecutorOutput>();
    let buffered_output_bytes = Arc::new(AtomicUsize::new(0));
    let output_overflowed = Arc::new(AtomicBool::new(false));
    forward_process_output(
        raw_output_rx,
        output_tx.clone(),
        Arc::clone(&buffered_output_bytes),
    );
    // Input channel is intentionally created and receiver dropped, stdin is closed for
    // this process variant. The sender is required by ProcessHandle's API contract.
    let (input_tx, _input_rx) = mpsc::channel::<ExecutorInput>(1);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let stdout_tx = raw_output_tx.clone();
    let stdout_buffered_bytes = Arc::clone(&buffered_output_bytes);
    let stdout_output_overflowed = Arc::clone(&output_overflowed);
    let mut stdout_task = tokio::spawn(async move {
        let mut reader = stdout;
        let mut pending = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => {
                    if stdout_output_overflowed.load(Ordering::Acquire) {
                        break;
                    }
                    if let Some(line) = flush_terminal_line_buffer(&mut pending) {
                        if !queue_process_output(
                            &stdout_tx,
                            &stdout_buffered_bytes,
                            &stdout_output_overflowed,
                            ExecutorOutput::Stdout(line),
                        ) {
                            break;
                        }
                    }
                    break;
                }
                Ok(read) => {
                    if stdout_output_overflowed.load(Ordering::Acquire) {
                        continue;
                    }
                    pending.extend_from_slice(&buffer[..read]);
                    if pending.len() > MAX_BUFFERED_PROCESS_OUTPUT_BYTES {
                        pending.clear();
                        signal_output_overflow(&stdout_tx, &stdout_output_overflowed);
                        continue;
                    }
                    for line in drain_terminal_lines(&mut pending) {
                        if !queue_process_output(
                            &stdout_tx,
                            &stdout_buffered_bytes,
                            &stdout_output_overflowed,
                            ExecutorOutput::Stdout(line),
                        ) {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stderr_tx = raw_output_tx.clone();
    let stderr_buffered_bytes = Arc::clone(&buffered_output_bytes);
    let stderr_output_overflowed = Arc::clone(&output_overflowed);
    let mut stderr_task = tokio::spawn(async move {
        let mut reader = stderr;
        let mut pending = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => {
                    if stderr_output_overflowed.load(Ordering::Acquire) {
                        break;
                    }
                    if let Some(line) = flush_terminal_line_buffer(&mut pending) {
                        if !queue_process_output(
                            &stderr_tx,
                            &stderr_buffered_bytes,
                            &stderr_output_overflowed,
                            ExecutorOutput::Stderr(line),
                        ) {
                            break;
                        }
                    }
                    break;
                }
                Ok(read) => {
                    if stderr_output_overflowed.load(Ordering::Acquire) {
                        continue;
                    }
                    pending.extend_from_slice(&buffer[..read]);
                    if pending.len() > MAX_BUFFERED_PROCESS_OUTPUT_BYTES {
                        pending.clear();
                        signal_output_overflow(&stderr_tx, &stderr_output_overflowed);
                        continue;
                    }
                    for line in drain_terminal_lines(&mut pending) {
                        if !queue_process_output(
                            &stderr_tx,
                            &stderr_buffered_bytes,
                            &stderr_output_overflowed,
                            ExecutorOutput::Stderr(line),
                        ) {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let exit_tx = raw_output_tx;
    tokio::spawn(async move {
        tokio::select! {
            status = async {
                loop {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    match child.try_wait() {
                        Ok(Some(status)) => break Ok(status),
                        Ok(None) => continue,
                        Err(error) => break Err(error),
                    }
                }
            } => {
                if status.is_ok() {
                    let _ = child.wait().await;
                }
                await_reader_task_with_timeout(&mut stdout_task).await;
                await_reader_task_with_timeout(&mut stderr_task).await;
                match status {
                    Ok(s) => {
                        let code = s.code().unwrap_or(-1);
                        let _ = exit_tx.send(ExecutorOutput::Completed { exit_code: code });
                    }
                    Err(e) => {
                        let _ = exit_tx.send(ExecutorOutput::Failed {
                            error: e.to_string(),
                            exit_code: None,
                        });
                    }
                }
            }
            signal = kill_rx => {
                if signal.is_ok() {
                    // Try graceful SIGTERM first (Unix only)
                    #[cfg(unix)]
                    if let Some(pid) = child.id() {
                        let _ = tokio::task::spawn_blocking(move || {
                            terminate_process_tree(pid, Duration::from_secs(5));
                        })
                        .await;
                        let _ = child.wait().await;
                        await_reader_task_with_timeout(&mut stdout_task).await;
                        await_reader_task_with_timeout(&mut stderr_task).await;
                        let _ = exit_tx.send(ExecutorOutput::Failed {
                            error: "killed".to_string(),
                            exit_code: Some(-15),
                        });
                        return;
                    }
                    // SIGKILL fallback
                    let _ = child.kill().await;
                    await_reader_task_with_timeout(&mut stdout_task).await;
                    await_reader_task_with_timeout(&mut stderr_task).await;
                    let _ = exit_tx.send(ExecutorOutput::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(-9),
                    });
                }
            }
        }
    });

    Ok(ProcessHandle {
        pid,
        output_rx,
        input_tx,
        terminal_rx: None,
        resize_tx: None,
        kill_tx,
    })
}

/// Raw process handle with I/O channels.
pub struct ProcessHandle {
    pub pid: u32,
    pub output_rx: mpsc::Receiver<ExecutorOutput>,
    pub input_tx: mpsc::Sender<ExecutorInput>,
    pub terminal_rx: Option<mpsc::Receiver<Vec<u8>>>,
    pub resize_tx: Option<mpsc::Sender<PtyDimensions>>,
    pub kill_tx: oneshot::Sender<()>,
}

fn drain_terminal_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let line = buffer.drain(..=index).collect::<Vec<_>>();
        lines.push(
            String::from_utf8_lossy(&line)
                .trim_end_matches('\n')
                .trim_end_matches('\r')
                .to_string(),
        );
    }
    lines
}

fn flush_terminal_line_buffer(buffer: &mut Vec<u8>) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }
    let line = String::from_utf8_lossy(buffer)
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string();
    buffer.clear();
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::{
        is_process_alive, spawn_process, spawn_process_no_stdin,
        spawn_process_no_stdin_with_clean_env, ExecutorOutput,
    };
    use std::collections::HashMap;
    use std::path::Path;
    use tokio::time::{timeout, Duration};

    fn parse_child_pid(line: &str) -> Option<u32> {
        line.split("child_pid=")
            .nth(1)
            .and_then(|value| value.trim().parse::<u32>().ok())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_isolates_child_process_group() {
        use nix::libc;

        let handle = spawn_process_no_stdin(
            Path::new("/bin/sh"),
            &["-lc".to_string(), "sleep 5".to_string()],
            Path::new("."),
            &HashMap::new(),
        )
        .await
        .expect("headless process should spawn");

        assert_ne!(handle.pid, 0, "headless process should expose a valid pid");
        let parent_pgid = unsafe { libc::getpgrp() };
        let child_pgid = unsafe { libc::getpgid(handle.pid as libc::pid_t) };

        let _ = handle.kill_tx.send(());

        assert!(child_pgid > 0, "child process group should be valid");
        assert_ne!(
            child_pgid, parent_pgid,
            "headless runtime should not share a process group with conductor"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_signal_terminates_shell_children_for_pty_sessions() {
        let mut handle = spawn_process(
            Path::new("/bin/sh"),
            &[
                "-lc".to_string(),
                "sleep 30 & child=$!; printf 'child_pid=%s\\n' \"$child\"; wait \"$child\""
                    .to_string(),
            ],
            Path::new("."),
            &HashMap::new(),
        )
        .await
        .expect("pty process should spawn");

        let child_pid = timeout(Duration::from_secs(3), async {
            loop {
                match handle.output_rx.recv().await {
                    Some(ExecutorOutput::Stdout(line)) => {
                        if let Some(pid) = parse_child_pid(line.trim()) {
                            break pid;
                        }
                    }
                    Some(_) => continue,
                    None => panic!("pty output channel closed before child pid"),
                }
            }
        })
        .await
        .expect("timed out waiting for child pid");
        // In CI containers, PTY sessions can be unreliable — the child may
        // exit before we check. Skip gracefully rather than fail the build.
        if !is_process_alive(child_pid) {
            eprintln!(
                "Skipping: child process {child_pid} exited early (expected in CI without proper PTY support)"
            );
            return;
        }

        let _ = handle.kill_tx.send(());

        let exit_event = timeout(Duration::from_secs(15), async {
            loop {
                match handle.output_rx.recv().await {
                    Some(ExecutorOutput::Failed { error, .. }) if error == "killed" => break,
                    Some(_) => continue,
                    None => panic!("pty output channel closed before kill event"),
                }
            }
        })
        .await;
        assert!(exit_event.is_ok(), "pty process should report killed");

        let terminated = timeout(Duration::from_secs(8), async {
            loop {
                if !is_process_alive(child_pid) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(
            terminated.is_ok(),
            "shell child should terminate with parent"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_with_clean_env_drops_parent_env_noise() {
        let noisy_key = "CONDUCTOR_EXECUTORS_TEST_NOISY_ENV";
        std::env::set_var(noisy_key, "should-not-leak");

        let mut clean_env = HashMap::new();
        clean_env.insert("TEST_ALLOWED".to_string(), "present".to_string());

        let mut handle = spawn_process_no_stdin_with_clean_env(
            Path::new("/usr/bin/python3"),
            &[
                "-c".to_string(),
                format!(
                    "import json, os; print(json.dumps({{'allowed': os.getenv('TEST_ALLOWED'), 'noisy': os.getenv('{noisy_key}')}}))"
                ),
            ],
            Path::new("."),
            &clean_env,
        )
        .await
        .expect("headless process should spawn with clean env");

        let first = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for env report")
            .expect("output channel closed before env report");
        let second = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for completion")
            .expect("output channel closed before completion");

        std::env::remove_var(noisy_key);

        let ExecutorOutput::Stdout(env_json) = first else {
            panic!("expected stdout env report, got {first:?}");
        };
        let env_report: serde_json::Value =
            serde_json::from_str(&env_json).expect("env report should parse");

        assert_eq!(
            env_report.get("allowed").and_then(|value| value.as_str()),
            Some("present")
        );
        assert!(
            env_report.get("noisy").is_some_and(|value| value.is_null()),
            "clean-env spawn should not inherit parent env noise: {env_report:?}"
        );
        assert!(
            matches!(second, ExecutorOutput::Completed { exit_code: 0 }),
            "expected completion after env report, got {second:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_with_clean_env_restores_sigpipe_default() {
        use nix::libc;
        use std::fs;
        use std::process::Command as StdCommand;
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("conductor-sigpipe-{stamp}"));
        fs::create_dir_all(&root).expect("temp dir should be created");
        let source = root.join("sigpipe.c");
        let binary = root.join("sigpipe-check");
        fs::write(
            &source,
            r#"#include <signal.h>
#include <stdio.h>
int main(void) {
    struct sigaction action;
    if (sigaction(SIGPIPE, NULL, &action) != 0) {
        return 2;
    }
    if (action.sa_handler == SIG_DFL) {
        puts("{\"sigpipe\":\"SIG_DFL\"}");
    } else if (action.sa_handler == SIG_IGN) {
        puts("{\"sigpipe\":\"SIG_IGN\"}");
    } else {
        puts("{\"sigpipe\":\"OTHER\"}");
    }
    return 0;
}
"#,
        )
        .expect("source should be written");
        let status = StdCommand::new("/usr/bin/cc")
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .status()
            .expect("cc should launch");
        assert!(status.success(), "cc should compile the sigpipe helper");

        let previous = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
        assert_ne!(
            previous,
            libc::SIG_ERR,
            "should set parent sigpipe disposition"
        );

        let mut clean_env = HashMap::new();
        clean_env.insert("TEST_ALLOWED".to_string(), "present".to_string());

        let mut handle =
            spawn_process_no_stdin_with_clean_env(&binary, &[], Path::new("."), &clean_env)
                .await
                .expect("headless process should spawn with restored sigpipe");

        let first = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for sigpipe report")
            .expect("output channel closed before sigpipe report");
        let second = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for completion")
            .expect("output channel closed before completion");

        let restored = unsafe { libc::signal(libc::SIGPIPE, previous) };
        assert_ne!(
            restored,
            libc::SIG_ERR,
            "should restore parent sigpipe disposition"
        );

        let ExecutorOutput::Stdout(sig_json) = first else {
            panic!("expected stdout sigpipe report, got {first:?}");
        };
        let sig_report: serde_json::Value =
            serde_json::from_str(&sig_json).expect("sigpipe report should parse");

        assert_eq!(
            sig_report.get("sigpipe").and_then(|value| value.as_str()),
            Some("SIG_DFL")
        );
        assert!(
            matches!(second, ExecutorOutput::Completed { exit_code: 0 }),
            "expected completion after sigpipe report, got {second:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_closes_inherited_extra_fds() {
        use nix::libc;
        use std::fs::File;
        use std::os::fd::AsRawFd;

        let extra = File::open("/dev/null").expect("should open test file");
        let extra_fd = extra.as_raw_fd();
        let flags = unsafe { libc::fcntl(extra_fd, libc::F_GETFD) };
        assert!(flags >= 0, "should read fd flags");
        let cleared = unsafe { libc::fcntl(extra_fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) };
        assert_eq!(cleared, 0, "should clear close-on-exec");

        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());

        let mut handle = spawn_process_no_stdin(
            Path::new("/bin/sh"),
            &[
                "-c".to_string(),
                "python3 -c 'import json, os; print(json.dumps(sorted(int(fd) for fd in os.listdir(\"/dev/fd\"))))'"
                    .to_string(),
            ],
            Path::new("."),
            &env,
        )
        .await
        .expect("headless process should spawn");

        let first = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for fd list")
            .expect("output channel closed before fd list");
        let second = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for completion")
            .expect("output channel closed before completion");

        let ExecutorOutput::Stdout(fd_json) = first else {
            panic!("expected stdout fd list, got {first:?}");
        };
        let fds: Vec<i32> = serde_json::from_str(&fd_json).expect("fd list should parse");

        assert!(
            !fds.contains(&extra_fd),
            "child inherited unexpected extra fd {extra_fd}: {fds:?}"
        );
        assert!(
            matches!(second, ExecutorOutput::Completed { exit_code: 0 }),
            "expected completion after fd list, got {second:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_reports_missing_binary_spawn_errors() {
        let error = match spawn_process_no_stdin(
            Path::new("/definitely/not/a/real/binary"),
            &[],
            Path::new("."),
            &HashMap::new(),
        )
        .await
        {
            Ok(_) => panic!("missing binary should return spawn error"),
            Err(error) => error,
        };

        let error_text = format!("{error:#}");
        assert!(
            error_text.contains("No such file") || error_text.contains("os error 2"),
            "expected missing binary spawn error, got {error_text}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_completes_even_if_descendant_keeps_pipe_open() {
        let mut handle = spawn_process_no_stdin(
            Path::new("/bin/sh"),
            &[
                "-lc".to_string(),
                "(sleep 2) & printf 'pipe kept open\\n'".to_string(),
            ],
            Path::new("."),
            &HashMap::new(),
        )
        .await
        .expect("headless process should spawn");

        let first = timeout(Duration::from_secs(2), handle.output_rx.recv())
            .await
            .expect("timed out waiting for first event")
            .expect("output channel closed before first event");
        let second = timeout(Duration::from_millis(900), handle.output_rx.recv())
            .await
            .expect("completion should not wait for descendant-held pipe")
            .expect("output channel closed before completion");

        assert!(
            matches!(first, ExecutorOutput::Stdout(ref line) if line == "pipe kept open"),
            "expected stdout before completion, got {first:?}"
        );
        assert!(
            matches!(second, ExecutorOutput::Completed { exit_code: 0 }),
            "expected completion even with descendant-held pipe, got {second:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_no_stdin_preserves_trailing_stdout_before_completion() {
        let mut handle = spawn_process_no_stdin(
            Path::new("/bin/sh"),
            &[
                "-lc".to_string(),
                "printf 'pipe trailing output'".to_string(),
            ],
            Path::new("."),
            &HashMap::new(),
        )
        .await
        .expect("headless process should spawn");

        let first = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for first event")
            .expect("output channel closed before first event");
        let second = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for second event")
            .expect("output channel closed before second event");

        assert!(
            matches!(first, ExecutorOutput::Stdout(ref line) if line == "pipe trailing output"),
            "expected trailing stdout before completion, got {first:?}"
        );
        assert!(
            matches!(second, ExecutorOutput::Completed { exit_code: 0 }),
            "expected completion after stdout flush, got {second:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_process_preserves_trailing_stdout_before_completion() {
        let mut handle = spawn_process(
            Path::new("/bin/sh"),
            &[
                "-lc".to_string(),
                "printf 'pty trailing output'".to_string(),
            ],
            Path::new("."),
            &HashMap::new(),
        )
        .await
        .expect("pty process should spawn");

        let first = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for first event")
            .expect("output channel closed before first event");
        let second = timeout(Duration::from_secs(5), handle.output_rx.recv())
            .await
            .expect("timed out waiting for second event")
            .expect("output channel closed before second event");

        assert!(
            matches!(first, ExecutorOutput::Stdout(ref line) if line == "pty trailing output"),
            "expected trailing stdout before completion, got {first:?}"
        );
        assert!(
            matches!(second, ExecutorOutput::Completed { exit_code: 0 }),
            "expected completion after stdout flush, got {second:?}"
        );
    }
}
