use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::executor::ExecutorOutput;

/// Spawn a CLI process with PTY support and return channels for I/O.
pub async fn spawn_process(
    binary: &Path,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<ProcessHandle> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Set environment variables.
    for (key, value) in env {
        cmd.env(key, value);
    }

    let mut child = cmd.spawn()?;
    let pid = child.id().unwrap_or(0);

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let stdin = child.stdin.take().expect("stdin piped");

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (input_tx, mut input_rx) = mpsc::channel::<String>(64);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    // Stdout reader task.
    let stdout_tx = output_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stdout_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                break;
            }
        }
    });

    // Stderr reader task.
    let stderr_tx = output_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if stderr_tx.send(ExecutorOutput::Stderr(line)).await.is_err() {
                break;
            }
        }
    });

    // Stdin writer task.
    tokio::spawn(async move {
        let mut writer = stdin;
        while let Some(text) = input_rx.recv().await {
            if writer.write_all(text.as_bytes()).await.is_err() {
                break;
            }
            if writer.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    // Process monitor task.
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
            _ = kill_rx => {
                let _ = child.kill().await;
                let _ = exit_tx.send(ExecutorOutput::Failed {
                    error: "killed".to_string(),
                    exit_code: Some(-9),
                }).await;
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
    pub input_tx: mpsc::Sender<String>,
    pub kill_tx: oneshot::Sender<()>,
}
