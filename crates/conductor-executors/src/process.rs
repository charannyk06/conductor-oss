use anyhow::Result;
#[cfg(unix)]
use nix::libc;
use portable_pty::PtySize;
use std::collections::HashMap;
#[cfg(unix)]
use std::collections::HashSet;
use std::path::Path;
#[cfg(unix)]
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::executor::{ExecutorInput, ExecutorOutput};
use conductor_terminal_host::{TerminalHost, TerminalMessage};

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

/// Raw process handle with I/O channels.
pub struct ProcessHandle {
    pub pid: u32,
    pub output_rx: mpsc::Receiver<ExecutorOutput>,
    pub input_tx: mpsc::Sender<ExecutorInput>,
    pub terminal_rx: Option<mpsc::Receiver<Vec<u8>>>,
    pub resize_tx: Option<mpsc::Sender<PtyDimensions>>,
    pub kill_tx: oneshot::Sender<()>,
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
    let host = TerminalHost::new();
    let size = PtySize {
        rows: pty_dims.rows,
        cols: pty_dims.cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let binary_str = binary.to_string_lossy().to_string();
    let args_vec = args.to_vec();

    let (mut terminal_rx_stream, terminal_tx, child, _reader_handle, _writer_handle, master_handle) =
        host.spawn(binary_str, args_vec, size, Some(cwd), Some(env))
            .await?;
    let pid = child.process_id().unwrap_or(0);

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let stdout_tx = output_tx.clone();

    // Create channel for terminal raw output to match existing API expectation
    let (terminal_raw_tx, terminal_raw_rx) = mpsc::channel::<Vec<u8>>(256);

    // Move a clone of the master handle into the output reader task so the PTY
    // master FD stays alive as long as the reader is running.  Dropping it
    // prematurely would close the underlying FD and cause the reader/writer
    // to see EOF.
    let reader_master = master_handle.clone();
    tokio::spawn(async move {
        let _master = reader_master; // prevent drop until task ends
        while let Some(msg) = terminal_rx_stream.recv().await {
            match msg {
                TerminalMessage::Raw(chunk) => {
                    let _ = terminal_raw_tx.send(chunk.clone()).await;
                    // Only emit to the structured output channel if the chunk
                    // is valid UTF-8.  Using from_utf8_lossy would silently
                    // replace non-UTF-8 bytes with U+FFFD, corrupting binary
                    // terminal data (e.g. image protocols, sixel).  The raw
                    // channel above always gets the unmodified bytes.
                    if let Ok(text) = std::str::from_utf8(&chunk) {
                        let _ = stdout_tx
                            .send(ExecutorOutput::Stdout(text.to_string()))
                            .await;
                    }
                }
                TerminalMessage::Chat(text) => {
                    // Handle Chat message (could route to a specific feed channel)
                    let _ = stdout_tx
                        .send(ExecutorOutput::Stdout(format!("[Chat]: {}", text)))
                        .await;
                }
                TerminalMessage::Thought(text) => {
                    // Handle Thought message
                    let _ = stdout_tx
                        .send(ExecutorOutput::Stdout(format!("[Thought]: {}", text)))
                        .await;
                }
            }
        }
    });

    // Forward input to PTY
    let input_terminal_tx = terminal_tx;
    tokio::spawn(async move {
        while let Some(input) = input_rx.recv().await {
            let data = match input {
                ExecutorInput::Text(text) => text.into_bytes(),
                ExecutorInput::Raw(raw) => raw.into_bytes(),
            };
            if input_terminal_tx.send(data).await.is_err() {
                break;
            }
        }
    });

    let (resize_tx, mut resize_rx) = mpsc::channel::<PtyDimensions>(8);

    // Forward resize events to the PTY master via the PtyMasterHandle.
    let resize_master = master_handle.clone();
    tokio::spawn(async move {
        while let Some(dims) = resize_rx.recv().await {
            let master = resize_master.clone();
            let _ = tokio::task::spawn_blocking(move || {
                master.resize(PtySize {
                    rows: dims.rows.max(1),
                    cols: dims.cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
            })
            .await;
        }
    });

    // Monitor process lifecycle — detect natural exit or handle kill signal.
    let kill_pid = pid;
    let kill_master = master_handle.clone();
    let exit_tx = output_tx;
    tokio::spawn(async move {
        // The child is a `Box<dyn portable_pty::Child>` (not tokio::process::Child),
        // so we must poll it in a blocking context.
        let child_pid = kill_pid;
        let (child_exit_tx, child_exit_rx) = oneshot::channel::<Option<u32>>();
        tokio::task::spawn_blocking(move || {
            // `child` is moved into this closure — we wait for it to exit.
            let mut child = child;
            let status = child.wait();
            let exit_code = status.ok().map(|s| s.exit_code());
            let _ = child_exit_tx.send(exit_code);
            drop(child);
        });

        tokio::select! {
            // Natural process exit
            result = child_exit_rx => {
                let exit_code = result.ok().flatten().unwrap_or(0);
                kill_master.close();
                let _ = exit_tx.send(ExecutorOutput::Completed {
                    exit_code: exit_code as i32,
                }).await;
            }
            // Explicit kill signal
            _ = kill_rx => {
                #[cfg(unix)]
                {
                    if child_pid > 0 {
                        let _ = tokio::task::spawn_blocking(move || {
                            terminate_process_tree(child_pid, Duration::from_secs(5));
                        })
                        .await;
                    }
                }
                // Close the PTY master FD to signal EOF to reader/writer.
                kill_master.close();
                let _ = exit_tx
                    .send(ExecutorOutput::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(-9),
                    })
                    .await;
            }
        }
    });

    Ok(ProcessHandle {
        pid,
        output_rx,
        input_tx,
        terminal_rx: Some(terminal_raw_rx),
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
    let kill_pid = pid;
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                let exit_code = status
                    .ok()
                    .and_then(|s| s.code())
                    .unwrap_or(-1);
                let _ = exit_tx.send(ExecutorOutput::Completed { exit_code }).await;
            }
            _ = kill_rx => {
                #[cfg(unix)]
                {
                    if kill_pid > 0 {
                        let _ = tokio::task::spawn_blocking(move || {
                            terminate_process_tree(kill_pid, Duration::from_secs(5));
                        }).await;
                    }
                }
                let status = child.wait().await;
                let exit_code = status
                    .ok()
                    .and_then(|s| s.code())
                    .unwrap_or(-9);
                let _ = exit_tx.send(ExecutorOutput::Failed {
                    error: "killed".to_string(),
                    exit_code: Some(exit_code),
                }).await;
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
