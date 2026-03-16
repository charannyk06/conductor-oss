/// PTY spawn and async I/O using `portable_pty`.
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use tokio::sync::{broadcast, mpsc};

/// Handle wrapping a PTY master for async read/write.
pub struct PtyHandle {
    /// Write end — send bytes to the PTY (terminal input).
    pub input_tx: mpsc::Sender<Vec<u8>>,
    /// Resize channel.
    pub resize_tx: mpsc::Sender<(u16, u16)>,
    /// Broadcast of PTY output bytes.
    pub output_tx: broadcast::Sender<Vec<u8>>,
    /// Child process wait handle.
    child: Option<Box<dyn portable_pty::Child + Send>>,
}

impl PtyHandle {
    /// Wait for the child process to exit and return its exit code.
    pub async fn wait(&mut self) -> Option<i32> {
        let child = self.child.take()?;
        // portable_pty::Child::wait is blocking, run on a blocking thread.
        tokio::task::spawn_blocking(move || {
            let mut child = child;
            child.wait().ok().map(|status| {
                if status.success() {
                    0
                } else {
                    1
                }
            })
        })
        .await
        .ok()
        .flatten()
    }

    /// Kill the child process.
    pub fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
        }
    }
}

/// Configuration for spawning a PTY.
pub struct PtySpawnConfig {
    pub command: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Spawn a new PTY process and return the handle.
///
/// This starts background tokio tasks for reading output and writing input.
/// The output is broadcast so multiple WebSocket clients can subscribe.
pub fn spawn_pty(config: PtySpawnConfig) -> Result<PtyHandle, PtySpawnError> {
    let pty_system = native_pty_system();

    let pty_pair = pty_system
        .openpty(PtySize {
            rows: config.rows,
            cols: config.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| PtySpawnError::Open(e.to_string()))?;

    let mut cmd = CommandBuilder::new(&config.command[0]);
    if config.command.len() > 1 {
        cmd.args(&config.command[1..]);
    }
    cmd.cwd(Path::new(&config.cwd));

    for (key, value) in &config.env {
        cmd.env(key, value);
    }

    if !config.env.contains_key("TERM") {
        cmd.env("TERM", "xterm-256color");
    }
    if !config.env.contains_key("COLORTERM") {
        cmd.env("COLORTERM", "truecolor");
    }

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| PtySpawnError::Spawn(e.to_string()))?;

    // Drop the slave — we only need the master side.
    drop(pty_pair.slave);

    let (output_tx, _) = broadcast::channel::<Vec<u8>>(256);
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(8);

    let master = pty_pair.master;

    // Clone the reader from the master (non-consuming).
    let reader = master
        .try_clone_reader()
        .map_err(|e| PtySpawnError::Open(format!("clone reader: {}", e)))?;

    // Take the writer (consuming — must happen before passing master to resize handler).
    let writer = master
        .take_writer()
        .map_err(|e| PtySpawnError::Open(format!("take writer: {}", e)))?;

    // Spawn output reader task
    start_output_reader(reader, output_tx.clone());

    // Spawn input writer task
    start_input_writer(writer, input_rx);

    // Spawn resize handler task (master is moved here for resize calls)
    start_resize_handler(master, resize_rx);

    Ok(PtyHandle {
        input_tx,
        resize_tx,
        output_tx,
        child: Some(child),
    })
}

fn start_output_reader(
    reader: Box<dyn Read + Send>,
    output_tx: broadcast::Sender<Vec<u8>>,
) {
    // PTY reads are blocking, so run on a dedicated thread.
    std::thread::Builder::new()
        .name("ttyd-pty-reader".into())
        .spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(error = %e, "PTY read error");
                        break;
                    }
                }
            }
        })
        .ok();
}

fn start_input_writer(
    writer: Box<dyn std::io::Write + Send>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
) {
    tokio::spawn(async move {
        use std::io::Write;
        let mut writer = writer;
        while let Some(data) = input_rx.recv().await {
            if writer.write_all(&data).is_err() {
                break;
            }
            if writer.flush().is_err() {
                break;
            }
        }
    });
}

fn start_resize_handler(
    master: Box<dyn MasterPty + Send>,
    mut resize_rx: mpsc::Receiver<(u16, u16)>,
) {
    tokio::spawn(async move {
        while let Some((cols, rows)) = resize_rx.recv().await {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    });
}

#[derive(Debug, thiserror::Error)]
pub enum PtySpawnError {
    #[error("failed to open PTY: {0}")]
    Open(String),
    #[error("failed to spawn command: {0}")]
    Spawn(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spawn_echo() {
        let config = PtySpawnConfig {
            command: vec![
                "bash".to_string(),
                "-c".to_string(),
                "echo hello && exit 0".to_string(),
            ],
            cwd: ".".to_string(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };

        let mut handle = spawn_pty(config).expect("spawn_pty should succeed");
        let mut rx = handle.output_tx.subscribe();

        let mut output = Vec::new();
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
        loop {
            tokio::select! {
                Ok(chunk) = rx.recv() => {
                    output.extend_from_slice(&chunk);
                    let s = String::from_utf8_lossy(&output);
                    if s.contains("hello") {
                        break;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    break;
                }
            }
        }

        let output_str = String::from_utf8_lossy(&output);
        assert!(output_str.contains("hello"), "output should contain 'hello', got: {output_str}");

        let exit_code = handle.wait().await;
        assert_eq!(exit_code, Some(0));
    }

    #[tokio::test]
    async fn test_pty_input() {
        let config = PtySpawnConfig {
            command: vec!["cat".to_string()],
            cwd: ".".to_string(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };

        let mut handle = spawn_pty(config).expect("spawn_pty should succeed");
        let mut rx = handle.output_tx.subscribe();

        handle.input_tx.send(b"test\n".to_vec()).await.unwrap();

        let mut output = Vec::new();
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
        loop {
            tokio::select! {
                Ok(chunk) = rx.recv() => {
                    output.extend_from_slice(&chunk);
                    let s = String::from_utf8_lossy(&output);
                    if s.contains("test") {
                        break;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    break;
                }
            }
        }

        let output_str = String::from_utf8_lossy(&output);
        assert!(output_str.contains("test"), "output should echo 'test', got: {output_str}");

        handle.kill();
    }
}
