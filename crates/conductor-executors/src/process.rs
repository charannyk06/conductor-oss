use anyhow::Result;
#[cfg(unix)]
use nix::libc;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
#[cfg(unix)]
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::executor::{ExecutorInput, ExecutorOutput};

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
    spawn_process_with_pty_size(binary, args, cwd, env, PtyDimensions::default()).await
}

/// Spawn a CLI process with PTY support and configurable PTY dimensions.
pub async fn spawn_process_with_pty_size(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
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
    for (key, value) in env {
        cmd.env(key, value);
    }

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
    let (terminal_tx, terminal_rx) = mpsc::channel::<Vec<u8>>(256);
    let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (resize_tx, mut resize_rx) = mpsc::channel::<PtyDimensions>(8);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let stdout_tx = output_tx.clone();
    let terminal_stream_tx = terminal_tx.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut pending = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    if let Some(line) = flush_terminal_line_buffer(&mut pending) {
                        if stdout_tx
                            .blocking_send(ExecutorOutput::Stdout(line))
                            .is_err()
                        {
                            break;
                        }
                    }
                    break;
                }
                Ok(read) => {
                    let chunk = buffer[..read].to_vec();
                    let _ = terminal_stream_tx.blocking_send(chunk.clone());
                    pending.extend_from_slice(&chunk);
                    for line in drain_terminal_lines(&mut pending) {
                        if stdout_tx
                            .blocking_send(ExecutorOutput::Stdout(line))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = stdout_tx.blocking_send(ExecutorOutput::Failed {
                        error: error.to_string(),
                        exit_code: None,
                    });
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

    let exit_tx = output_tx;
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
                    // Drop the master handle to close PTY file descriptors.
                    if let Ok(mut guard) = master_for_cleanup.lock() {
                        guard.take();
                    }
                    let _ = exit_tx.send(ExecutorOutput::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(-9),
                    }).await;
                }
            }
            result = async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
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
                // Drop the master handle on normal exit too.
                if let Ok(mut guard) = master.lock() {
                    guard.take();
                }
                match result {
                    Ok(code) => {
                        let _ = exit_tx.send(ExecutorOutput::Completed { exit_code: code }).await;
                    }
                    Err(error) => {
                        let _ = exit_tx.send(ExecutorOutput::Failed {
                            error,
                            exit_code: None,
                        }).await;
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
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    for (key, value) in env {
        cmd.env(key, value);
    }

    let mut child = cmd.spawn()?;
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
    // Input channel is intentionally created and receiver dropped — stdin is closed for
    // this process variant. The sender is required by ProcessHandle's API contract.
    let (input_tx, _input_rx) = mpsc::channel::<ExecutorInput>(1);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let stdout_tx = output_tx.clone();
    tokio::spawn(async move {
        let reader = AsyncBufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stdout_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                break;
            }
        }
    });

    let stderr_tx = output_tx.clone();
    tokio::spawn(async move {
        let reader = AsyncBufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stderr_tx.send(ExecutorOutput::Stderr(line)).await.is_err() {
                break;
            }
        }
    });

    let exit_tx = output_tx;
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                match status {
                    Ok(s) => {
                        let code = s.code().unwrap_or(-1);
                        let _ = exit_tx.send(ExecutorOutput::Completed { exit_code: code }).await;
                    }
                    Err(e) => {
                        let _ = exit_tx.send(ExecutorOutput::Failed {
                            error: e.to_string(),
                            exit_code: None,
                        }).await;
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
                        let _ = exit_tx.send(ExecutorOutput::Failed {
                            error: "killed".to_string(),
                            exit_code: Some(-15),
                        }).await;
                        return;
                    }
                    // SIGKILL fallback
                    let _ = child.kill().await;
                    let _ = exit_tx.send(ExecutorOutput::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(-9),
                    }).await;
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

#[cfg(test)]
mod tests {
    use super::{is_process_alive, spawn_process, ExecutorOutput};
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
        assert!(
            is_process_alive(child_pid),
            "child should be alive before kill"
        );

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
