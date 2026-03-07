use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::executor::{ExecutorInput, ExecutorOutput};

/// PTY dimensions configuration.
pub struct PtyDimensions {
    pub rows: u16,
    pub cols: u16,
}

impl Default for PtyDimensions {
    fn default() -> Self {
        Self { rows: 48, cols: 160 }
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
    let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let stdout_tx = output_tx.clone();
    tokio::task::spawn_blocking(move || {
        let reader = BufReader::new(reader);
        let mut lines = reader.lines();
        loop {
            match lines.next() {
                Some(Ok(line)) => {
                    if stdout_tx.blocking_send(ExecutorOutput::Stdout(line)).is_err() {
                        break;
                    }
                }
                Some(Err(error)) => {
                    let _ = stdout_tx.blocking_send(ExecutorOutput::Failed {
                        error: error.to_string(),
                        exit_code: None,
                    });
                    break;
                }
                None => break,
            }
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
                        let _ = child.kill();
                        let _ = child.wait(); // reap zombie process
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

    let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("stdout not piped"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow::anyhow!("stderr not piped"))?;

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
        kill_tx,
    })
}

/// Raw process handle with I/O channels.
pub struct ProcessHandle {
    pub pid: u32,
    pub output_rx: mpsc::Receiver<ExecutorOutput>,
    pub input_tx: mpsc::Sender<ExecutorInput>,
    pub kill_tx: oneshot::Sender<()>,
}
