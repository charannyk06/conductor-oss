use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Semaphore, TryAcquireError};
use tokio::time::{timeout, Duration};

const DEFAULT_MAX_PENDING_WRITES: usize = 1000;
const DEFAULT_WRITE_TIMEOUT_MS: u64 = 5000;
const DEFAULT_BATCH_SIZE: usize = 4096;

#[derive(Debug, Clone)]
pub struct PtyWriteQueueConfig {
    pub max_pending_writes: usize,
    pub write_timeout_ms: u64,
    pub batch_size: usize,
    pub enable_backpressure: bool,
}

impl Default for PtyWriteQueueConfig {
    fn default() -> Self {
        Self {
            max_pending_writes: DEFAULT_MAX_PENDING_WRITES,
            write_timeout_ms: DEFAULT_WRITE_TIMEOUT_MS,
            batch_size: DEFAULT_BATCH_SIZE,
            enable_backpressure: true,
        }
    }
}

#[derive(Debug)]
pub enum PtyWriteRequest {
    Text(Vec<u8>),
    Data(Vec<u8>),
    Flush(mpsc::Sender<()>),
    Close,
}

pub struct PtyWriteQueue {
    config: PtyWriteQueueConfig,
    pending_count: Arc<AtomicUsize>,
    semaphore: Arc<Semaphore>,
    tx: mpsc::Sender<PtyWriteRequest>,
}

impl PtyWriteQueue {
    pub fn new(config: PtyWriteQueueConfig) -> (Self, mpsc::Receiver<PtyWriteRequest>) {
        let (tx, rx) = mpsc::channel(config.max_pending_writes);
        let semaphore = Arc::new(Semaphore::new(config.max_pending_writes));

        let pending_count = Arc::new(AtomicUsize::new(0));

        (
            Self {
                config,
                pending_count,
                semaphore,
                tx,
            },
            rx,
        )
    }

    pub async fn write(&self, data: Vec<u8>) -> Result<(), PtyWriteError> {
        let permit = if self.config.enable_backpressure {
            Some(
                timeout(
                    Duration::from_millis(self.config.write_timeout_ms),
                    self.semaphore.acquire(),
                )
                .await
                .map_err(|_| PtyWriteError::BackpressureTimeout)?
                .map_err(|_| PtyWriteError::QueueClosed)?,
            )
        } else {
            None
        };

        self.pending_count.fetch_add(1, Ordering::Relaxed);

        let result = timeout(
            Duration::from_millis(self.config.write_timeout_ms),
            self.tx.send(PtyWriteRequest::Data(data)),
        )
        .await;

        match result {
            Ok(Ok(())) => {
                // Permit is intentionally NOT returned to the semaphore here.
                // The consumer calls release_permit() after processing the message,
                // which is the sole mechanism for returning the permit.
                if let Some(permit) = permit {
                    permit.forget();
                }
                Ok(())
            }
            Ok(Err(_)) => {
                // Send failed — permit drops naturally, returning to semaphore
                self.pending_count.fetch_sub(1, Ordering::Relaxed);
                Err(PtyWriteError::QueueClosed)
            }
            Err(_) => {
                // Timeout — permit drops naturally, returning to semaphore
                self.pending_count.fetch_sub(1, Ordering::Relaxed);
                Err(PtyWriteError::WriteTimeout)
            }
        }
    }

    pub fn try_write(&self, data: Vec<u8>) -> Result<PtyWriteEnqueueStatus, PtyWriteError> {
        if self.config.enable_backpressure {
            let permit = self.semaphore.try_acquire().map_err(|err| match err {
                TryAcquireError::Closed => PtyWriteError::QueueClosed,
                TryAcquireError::NoPermits => PtyWriteError::QueueFull,
            })?;

            match self.tx.try_send(PtyWriteRequest::Data(data)) {
                Ok(()) => {
                    self.pending_count.fetch_add(1, Ordering::Relaxed);
                    permit.forget(); // Consumer's release_permit() returns the permit
                    Ok(PtyWriteEnqueueStatus::Queued)
                }
                Err(err) => match err {
                    mpsc::error::TrySendError::Full(_) => Err(PtyWriteError::QueueFull),
                    mpsc::error::TrySendError::Closed(_) => Err(PtyWriteError::QueueClosed),
                },
            }
        } else {
            match self.tx.try_send(PtyWriteRequest::Data(data)) {
                Ok(()) => {
                    self.pending_count.fetch_add(1, Ordering::Relaxed);
                    Ok(PtyWriteEnqueueStatus::Queued)
                }
                Err(err) => match err {
                    mpsc::error::TrySendError::Full(_) => Err(PtyWriteError::QueueFull),
                    mpsc::error::TrySendError::Closed(_) => Err(PtyWriteError::QueueClosed),
                },
            }
        }
    }

    pub async fn write_text(&self, text: String) -> Result<(), PtyWriteError> {
        let permit = if self.config.enable_backpressure {
            Some(
                timeout(
                    Duration::from_millis(self.config.write_timeout_ms),
                    self.semaphore.acquire(),
                )
                .await
                .map_err(|_| PtyWriteError::BackpressureTimeout)?
                .map_err(|_| PtyWriteError::QueueClosed)?,
            )
        } else {
            None
        };

        self.pending_count.fetch_add(1, Ordering::Relaxed);

        let result = timeout(
            Duration::from_millis(self.config.write_timeout_ms),
            self.tx.send(PtyWriteRequest::Text(text.into_bytes())),
        )
        .await;

        match result {
            Ok(Ok(())) => {
                if let Some(permit) = permit {
                    permit.forget(); // Consumer's release_permit() returns the permit
                }
                Ok(())
            }
            Ok(Err(_)) => {
                self.pending_count.fetch_sub(1, Ordering::Relaxed);
                Err(PtyWriteError::QueueClosed)
            }
            Err(_) => {
                self.pending_count.fetch_sub(1, Ordering::Relaxed);
                Err(PtyWriteError::WriteTimeout)
            }
        }
    }

    pub fn try_write_text(&self, text: String) -> Result<PtyWriteEnqueueStatus, PtyWriteError> {
        self.try_write(text.into_bytes())
    }

    pub async fn write_all(&self, data: &[u8]) -> Result<(), PtyWriteError> {
        if data.len() <= self.config.batch_size {
            return self.write(data.to_vec()).await;
        }

        for chunk in data.chunks(self.config.batch_size) {
            self.write(chunk.to_vec()).await?;
        }

        Ok(())
    }

    pub async fn flush(&self) -> Result<(), PtyWriteError> {
        let (tx, mut rx) = mpsc::channel(1);

        timeout(
            Duration::from_millis(self.config.write_timeout_ms),
            self.tx.send(PtyWriteRequest::Flush(tx)),
        )
        .await
        .map_err(|_| PtyWriteError::WriteTimeout)?
        .map_err(|_| PtyWriteError::QueueClosed)?;

        timeout(
            Duration::from_millis(self.config.write_timeout_ms),
            rx.recv(),
        )
        .await
        .map_err(|_| PtyWriteError::FlushTimeout)?
        .ok_or(PtyWriteError::FlushCancelled)?;

        Ok(())
    }

    pub async fn close(&self) -> Result<(), PtyWriteError> {
        timeout(
            Duration::from_millis(self.config.write_timeout_ms),
            self.tx.send(PtyWriteRequest::Close),
        )
        .await
        .map_err(|_| PtyWriteError::WriteTimeout)?
        .map_err(|_| PtyWriteError::QueueClosed)
    }

    pub fn pending_count(&self) -> usize {
        self.pending_count.load(Ordering::Relaxed)
    }

    pub fn release_permit(&self) {
        // Only add a permit if we actually have outstanding permits to return,
        // preventing the semaphore from growing past max_pending_writes on
        // double-release bugs.
        let prev =
            self.pending_count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    if current > 0 {
                        Some(current - 1)
                    } else {
                        None // no outstanding permits — do not decrement
                    }
                });
        if prev.is_ok() {
            self.semaphore.add_permits(1);
        }
    }

    pub fn is_full(&self) -> bool {
        self.pending_count.load(Ordering::Relaxed) >= self.config.max_pending_writes
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PtyWriteError {
    #[error("Write queue is under backpressure and timeout expired")]
    BackpressureTimeout,

    #[error("Write operation timed out")]
    WriteTimeout,

    #[error("Flush operation timed out")]
    FlushTimeout,

    #[error("Flush was cancelled")]
    FlushCancelled,

    #[error("Write queue is closed")]
    QueueClosed,

    #[error("Write queue is full")]
    QueueFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyWriteEnqueueStatus {
    Queued,
    QueueFull,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_queue_tracks_pending_count() {
        let config = PtyWriteQueueConfig {
            max_pending_writes: 2,
            enable_backpressure: false,
            ..Default::default()
        };

        let (queue, _rx) = PtyWriteQueue::new(config);

        queue.write(b"test1".to_vec()).await.unwrap();
        assert_eq!(queue.pending_count(), 1);

        queue.write(b"test2".to_vec()).await.unwrap();
        assert_eq!(queue.pending_count(), 2);
    }

    #[tokio::test]
    async fn write_queue_checks_full() {
        let config = PtyWriteQueueConfig {
            max_pending_writes: 1,
            enable_backpressure: false,
            ..Default::default()
        };

        let (queue, _rx) = PtyWriteQueue::new(config);

        assert!(!queue.is_full());

        queue.write(b"test".to_vec()).await.unwrap();

        assert!(queue.is_full());
    }

    #[tokio::test]
    async fn try_write_rejects_when_full() {
        let config = PtyWriteQueueConfig {
            max_pending_writes: 1,
            enable_backpressure: true,
            ..Default::default()
        };

        let (queue, _rx) = PtyWriteQueue::new(config);

        let first = queue.try_write(b"first".to_vec()).unwrap();
        assert_eq!(first, PtyWriteEnqueueStatus::Queued);
        assert!(queue.is_full());
        assert!(matches!(
            queue.try_write(b"second".to_vec()),
            Err(PtyWriteError::QueueFull)
        ));
    }

    /// Verifies the semaphore permit lifecycle: write() forgets the permit,
    /// consumer calls release_permit(), and the slot becomes available again.
    #[tokio::test]
    async fn semaphore_permit_lifecycle_write_consume_release() {
        let config = PtyWriteQueueConfig {
            max_pending_writes: 1,
            enable_backpressure: true,
            ..Default::default()
        };

        let (queue, mut rx) = PtyWriteQueue::new(config);
        let queue = Arc::new(queue);

        // Fill the single slot
        queue.write(b"msg1".to_vec()).await.unwrap();
        assert_eq!(queue.pending_count(), 1);

        // Queue is full — try_write should fail
        assert!(matches!(
            queue.try_write(b"blocked".to_vec()),
            Err(PtyWriteError::QueueFull)
        ));

        // Consumer receives the message
        let msg = rx.recv().await.expect("should receive message");
        assert!(matches!(msg, PtyWriteRequest::Data(_)));

        // Consumer releases the permit
        queue.release_permit();
        assert_eq!(queue.pending_count(), 0);

        // Slot is available again
        let result = queue.try_write(b"msg2".to_vec());
        assert_eq!(result.unwrap(), PtyWriteEnqueueStatus::Queued);
    }

    /// Verifies that permits are correctly managed across multiple write/release cycles
    /// without the semaphore growing unbounded (the bug that permit.forget() fixes).
    #[tokio::test]
    async fn semaphore_does_not_grow_unbounded() {
        let config = PtyWriteQueueConfig {
            max_pending_writes: 2,
            enable_backpressure: true,
            ..Default::default()
        };

        let (queue, mut rx) = PtyWriteQueue::new(config);
        let queue = Arc::new(queue);

        // Run 10 write/consume/release cycles through 2 slots
        for _ in 0..10 {
            queue.write(b"data".to_vec()).await.unwrap();
            let _ = rx.recv().await.unwrap();
            queue.release_permit();
        }

        // After all cycles, we should still have exactly max_pending_writes
        // capacity (2), not more. Fill both slots.
        queue.try_write(b"a".to_vec()).unwrap();
        queue.try_write(b"b".to_vec()).unwrap();

        // Third write should fail — proves semaphore didn't grow
        assert!(matches!(
            queue.try_write(b"c".to_vec()),
            Err(PtyWriteError::QueueFull)
        ));
    }
}
