use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::error;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum TerminalMessage {
    Raw(Vec<u8>),
    Chat(String),
    Thought(String),
}

/// Handle that keeps the PTY master file descriptor alive for the duration of
/// a spawned terminal session.  When this value is dropped the underlying FD
/// is closed, which signals EOF to the reader/writer that were cloned from it.
#[derive(Clone)]
pub struct PtyMasterHandle {
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}

impl PtyMasterHandle {
    /// Resize the PTY to the given dimensions.  Returns `Ok(())` if the
    /// resize succeeds or the master has already been dropped.
    pub fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        let mut guard = self
            .master
            .lock()
            .map_err(|e| anyhow::anyhow!("PTY master mutex poisoned: {e}"))?;
        if let Some(master) = guard.as_mut() {
            master.resize(size)?;
        }
        Ok(())
    }

    /// Take and drop the inner master FD, closing it explicitly.
    pub fn close(&self) {
        if let Ok(mut guard) = self.master.lock() {
            guard.take();
        }
    }
}

pub struct TerminalHost {
    pty_system: Mutex<Box<dyn PtySystem + Send>>,
}

impl Default for TerminalHost {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalHost {
    pub fn new() -> Self {
        Self {
            pty_system: Mutex::new(native_pty_system()),
        }
    }

    /// Spawn a PTY child process and return communication channels plus task handles.
    ///
    /// Returns `(output_rx, input_tx, child, reader_handle, writer_handle, master_handle)`
    /// so the caller can manage the lifecycle of the background tasks (e.g. abort them
    /// when the PTY session ends).  The `PtyMasterHandle` must be kept alive for as long
    /// as the reader/writer tasks are running; dropping it closes the underlying FD.
    pub async fn spawn(
        &self,
        command: String,
        args: Vec<String>,
        size: PtySize,
        cwd: Option<&std::path::Path>,
        env: Option<&std::collections::HashMap<String, String>>,
    ) -> anyhow::Result<(
        mpsc::Receiver<TerminalMessage>,
        mpsc::Sender<Vec<u8>>,
        Box<dyn portable_pty::Child + Send>,
        JoinHandle<()>,
        JoinHandle<()>,
        PtyMasterHandle,
    )> {
        // Wrap openpty in spawn_blocking since PTY allocation may involve
        // blocking kernel calls that would starve the async runtime.
        let pty_mutex = &self.pty_system;
        let pair = {
            let pty_system = pty_mutex
                .lock()
                .map_err(|e| anyhow::anyhow!("PTY system mutex poisoned: {e}"))?;
            // openpty is a blocking syscall — we hold the mutex for the
            // minimum time and the call itself is fast in practice.
            pty_system.openpty(size)?
        };
        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        if let Some(env) = env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave); // Slave is owned by the child process

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // Keep the master FD alive so the cloned reader/writer remain valid.
        let master_handle = PtyMasterHandle {
            master: Arc::new(Mutex::new(Some(pair.master))),
        };

        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(1024);
        let (out_tx, out_rx) = mpsc::channel::<TerminalMessage>(1024);

        // Read thread - returns handle so caller can abort/join
        let reader_handle = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if out_tx
                    .blocking_send(TerminalMessage::Raw(buf[..n].to_vec()))
                    .is_err()
                {
                    break;
                }
            }
        });

        // Write task - uses spawn_blocking to avoid blocking the async runtime
        // since `writer` is a synchronous `std::io::Write` backed by a PTY FD.
        let writer_handle = tokio::task::spawn_blocking(move || {
            let mut writer = writer;
            while let Some(data) = rx.blocking_recv() {
                if let Err(e) = writer.write_all(&data) {
                    error!("Failed to write to PTY: {:?}", e);
                    break;
                }
            }
        });

        Ok((
            out_rx,
            tx,
            child,
            reader_handle,
            writer_handle,
            master_handle,
        ))
    }
}
