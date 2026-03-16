/// Per-session state: PTY handle, broadcast channel, flow control.
use crate::pty::{PtyHandle, PtySpawnConfig, PtySpawnError};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::protocol::DEFAULT_PAUSE_BUFFER_CAPACITY;

/// A single terminal session backed by a native PTY.
pub struct TtydSession {
    /// PTY handle (owns child process).
    pty: Mutex<PtyHandle>,
    /// Broadcast channel for PTY output (subscribers get live data).
    output_tx: broadcast::Sender<Vec<u8>>,
    /// Send input bytes to the PTY.
    input_tx: mpsc::Sender<Vec<u8>>,
    /// Send resize events to the PTY.
    resize_tx: mpsc::Sender<(u16, u16)>,
    /// Flow control: true when the client has sent PAUSE.
    paused: AtomicBool,
    /// Buffered output during PAUSE (bounded to prevent OOM).
    pause_buffer: Mutex<PauseBuffer>,
    /// Session ID for logging/identification.
    pub session_id: String,
}

struct PauseBuffer {
    chunks: VecDeque<Vec<u8>>,
    total_bytes: usize,
    capacity: usize,
}

impl PauseBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_bytes: 0,
            capacity,
        }
    }

    /// Push a chunk, dropping oldest if over capacity.
    fn push(&mut self, chunk: Vec<u8>) {
        let len = chunk.len();
        self.chunks.push_back(chunk);
        self.total_bytes += len;

        // Drop oldest chunks until we're under capacity
        while self.total_bytes > self.capacity && !self.chunks.is_empty() {
            if let Some(oldest) = self.chunks.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(oldest.len());
            }
        }
    }

    /// Drain all buffered chunks.
    fn drain(&mut self) -> Vec<Vec<u8>> {
        self.total_bytes = 0;
        self.chunks.drain(..).collect()
    }
}

impl TtydSession {
    /// Spawn a new session with the given command.
    pub fn spawn(
        session_id: String,
        config: PtySpawnConfig,
    ) -> Result<Arc<Self>, PtySpawnError> {
        let pty = crate::pty::spawn_pty(config)?;

        let output_tx = pty.output_tx.clone();
        let input_tx = pty.input_tx.clone();
        let resize_tx = pty.resize_tx.clone();

        Ok(Arc::new(Self {
            pty: Mutex::new(pty),
            output_tx,
            input_tx,
            resize_tx,
            paused: AtomicBool::new(false),
            pause_buffer: Mutex::new(PauseBuffer::new(DEFAULT_PAUSE_BUFFER_CAPACITY)),
            session_id,
        }))
    }

    /// Subscribe to output. Returns a broadcast receiver that gets live PTY output.
    pub fn subscribe_output(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    /// Send raw input bytes to the PTY.
    pub async fn send_input(&self, data: Vec<u8>) -> Result<(), mpsc::error::SendError<Vec<u8>>> {
        self.input_tx.send(data).await
    }

    /// Resize the PTY.
    pub async fn resize(&self, cols: u16, rows: u16) {
        let _ = self.resize_tx.send((cols, rows)).await;
    }

    /// Set the paused state. When paused, output is buffered.
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    /// Check if the session is paused.
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Buffer a chunk of output during pause.
    pub async fn buffer_output(&self, chunk: Vec<u8>) {
        let mut buffer = self.pause_buffer.lock().await;
        buffer.push(chunk);
    }

    /// Flush the pause buffer, returning all buffered chunks.
    pub async fn flush_pause_buffer(&self) -> Vec<Vec<u8>> {
        let mut buffer = self.pause_buffer.lock().await;
        buffer.drain()
    }

    /// Wait for the child process to exit.
    pub async fn wait(&self) -> Option<i32> {
        let mut pty = self.pty.lock().await;
        pty.wait().await
    }

    /// Kill the child process.
    pub async fn kill(&self) {
        let mut pty = self.pty.lock().await;
        pty.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_pause_buffer() {
        let config = PtySpawnConfig {
            command: vec!["bash".into(), "-c".into(), "sleep 60".into()],
            cwd: ".".into(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };

        let session = TtydSession::spawn("test".into(), config).expect("spawn should work");

        // Buffer some data
        session.set_paused(true);
        assert!(session.is_paused());

        session.buffer_output(b"chunk1".to_vec()).await;
        session.buffer_output(b"chunk2".to_vec()).await;

        // Flush
        let chunks = session.flush_pause_buffer().await;
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], b"chunk1");
        assert_eq!(chunks[1], b"chunk2");

        // Buffer should be empty after flush
        let chunks = session.flush_pause_buffer().await;
        assert!(chunks.is_empty());

        session.kill().await;
    }

    #[tokio::test]
    async fn test_pause_buffer_overflow() {
        let config = PtySpawnConfig {
            command: vec!["bash".into(), "-c".into(), "sleep 60".into()],
            cwd: ".".into(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };

        let session = TtydSession::spawn("test".into(), config).expect("spawn should work");
        session.set_paused(true);

        // Fill beyond capacity (64KB default). Each chunk is 32KB.
        let big_chunk = vec![0u8; 32 * 1024];
        session.buffer_output(big_chunk.clone()).await;
        session.buffer_output(big_chunk.clone()).await;
        session.buffer_output(big_chunk.clone()).await;

        let chunks = session.flush_pause_buffer().await;
        // Should have dropped the oldest to stay under 64KB
        assert_eq!(chunks.len(), 2);

        session.kill().await;
    }
}
