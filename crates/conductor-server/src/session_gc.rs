//! Background task that periodically cleans stale session and tmux state files.
//!
//! Sessions accumulate `.exit`, `.log`, `.terminal`, `.terminal-state.json`,
//! and `.json` files under `.conductor/rust-backend/sessions/` and
//! `.conductor/rust-backend/tmux/`. Without cleanup this directory grows
//! without bound. This module runs a periodic sweep that removes files for
//! sessions that look inactive based on file modification time.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tracing::{debug, info, warn};

/// How long to keep session state files after last modification.
const SESSION_FILE_TTL: Duration = Duration::from_secs(24 * 60 * 60); // 24h

/// How often to run the cleanup sweep.
const GC_INTERVAL: Duration = Duration::from_secs(30 * 60); // 30 min

/// Maximum number of files to remove in a single sweep to avoid long pauses.
const MAX_REMOVALS_PER_SWEEP: usize = 500;

/// Run the session GC loop until notified to stop.
pub async fn run_session_gc(conductor_dir: PathBuf, cancel: Arc<tokio::sync::Notify>) {
    let sessions_dir = conductor_dir.join("rust-backend").join("sessions");
    let tmux_dir = conductor_dir.join("rust-backend").join("tmux");

    if !sessions_dir.exists() && !tmux_dir.exists() {
        debug!("session GC: no session/tmux directories found, skipping");
        return;
    }

    let mut interval = tokio::time::interval(GC_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                info!("session GC shutting down");
                return;
            }
            _ = interval.tick() => {
                sweep(&sessions_dir, &tmux_dir).await;
            }
        }
    }
}

async fn sweep(sessions_dir: &PathBuf, tmux_dir: &PathBuf) {
    let now = SystemTime::now();
    let cutoff = now - SESSION_FILE_TTL;
    let mut removed = 0usize;
    let mut scanned = 0usize;

    // Clean session files
    if sessions_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(sessions_dir) {
            for entry in entries.flatten() {
                if removed >= MAX_REMOVALS_PER_SWEEP {
                    break;
                }
                let path = entry.path();
                scanned += 1;

                // Only remove if the file was modified before the cutoff
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        if modified < cutoff {
                            match std::fs::remove_file(&path) {
                                Ok(()) => {
                                    debug!(file = ?path, "removed stale session file");
                                    removed += 1;
                                }
                                Err(e) => {
                                    warn!(file = ?path, error = %e, "failed to remove stale session file");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Clean tmux files
    if tmux_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(tmux_dir) {
            for entry in entries.flatten() {
                if removed >= MAX_REMOVALS_PER_SWEEP {
                    break;
                }
                let path = entry.path();
                scanned += 1;

                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        if modified < cutoff {
                            match std::fs::remove_file(&path) {
                                Ok(()) => {
                                    debug!(file = ?path, "removed stale tmux file");
                                    removed += 1;
                                }
                                Err(e) => {
                                    warn!(file = ?path, error = %e, "failed to remove stale tmux file");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if removed > 0 || scanned > 0 {
        info!(scanned, removed, "session GC sweep complete");
    } else {
        debug!("session GC sweep: nothing to clean");
    }
}

#[cfg(test)]
mod tests {
    use super::{GC_INTERVAL, MAX_REMOVALS_PER_SWEEP, SESSION_FILE_TTL};
    use std::time::Duration;

    // The sweep logic is straightforward file-age-based cleanup.
    // Integration tests should create temp directories with known-age files.
    // Unit-level: just verify the TTL and interval constants are reasonable.
    #[test]
    fn constants_are_reasonable() {
        assert!(SESSION_FILE_TTL >= Duration::from_secs(3600)); // at least 1h
        assert!(GC_INTERVAL >= Duration::from_secs(60)); // at least 1min
        assert!(MAX_REMOVALS_PER_SWEEP > 0);
    }
}
