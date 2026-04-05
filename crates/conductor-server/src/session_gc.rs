//! Background task that periodically cleans stale session and tmux state files.
//!
//! Sessions accumulate `.exit`, `.log`, `.terminal`, `.terminal-state.json`,
//! and `.json` files under `.conductor/rust-backend/sessions/` and
//! `.conductor/rust-backend/tmux/`. Without cleanup this directory grows
//! without bound. This module runs a periodic sweep that removes files for
//! sessions that look inactive based on file modification time.
//!
//! The GC skips files belonging to sessions that are still active in the
//! in-memory registry, so long-running idle sessions never lose their state.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
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
pub async fn run_session_gc(
    conductor_dir: PathBuf,
    active_session_ids: Vec<String>,
    cancel: Arc<tokio::sync::Notify>,
) {
    let sessions_dir = conductor_dir.join("rust-backend").join("sessions");
    let tmux_dir = conductor_dir.join("rust-backend").join("tmux");
    let active_set: HashSet<String> = active_session_ids.into_iter().collect();

    let mut interval = tokio::time::interval(GC_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                info!("session GC shutting down");
                return;
            }
            _ = interval.tick() => {
                sweep(&sessions_dir, &tmux_dir, &active_set).await;
            }
        }
    }
}

async fn sweep(sessions_dir: &Path, tmux_dir: &Path, active_ids: &HashSet<String>) {
    let cutoff = SystemTime::now() - SESSION_FILE_TTL;
    let sessions_dir = sessions_dir.to_path_buf();
    let tmux_dir = tmux_dir.to_path_buf();
    let active_ids = active_ids.clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut state = SweepState::new();
        sweep_directory(&sessions_dir, cutoff, &mut state, "session", &active_ids);
        sweep_directory(&tmux_dir, cutoff, &mut state, "tmux", &active_ids);
        state
    })
    .await;

    match result {
        Ok(state) => {
            if state.removed > 0 || state.scanned > 0 {
                info!(
                    scanned = state.scanned,
                    removed = state.removed,
                    "session GC sweep complete"
                );
            } else {
                debug!("session GC sweep: nothing to clean");
            }
        }
        Err(e) => {
            warn!(error = %e, "session GC sweep task panicked");
        }
    }
}

struct SweepState {
    removed: usize,
    scanned: usize,
}

impl SweepState {
    fn new() -> Self {
        Self {
            removed: 0,
            scanned: 0,
        }
    }
}

/// Sweep a single directory, removing stale files while skipping active sessions.
fn sweep_directory(
    dir: &Path,
    cutoff: SystemTime,
    state: &mut SweepState,
    dir_name: &str,
    active_ids: &HashSet<String>,
) {
    if !dir.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if state.removed >= MAX_REMOVALS_PER_SWEEP {
                break;
            }
            let path = entry.path();
            state.scanned += 1;

            // Skip files belonging to sessions still active in the registry.
            if let Some(session_id) = extract_session_id(&path) {
                if active_ids.contains(&session_id) {
                    continue;
                }
            }

            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < cutoff {
                        match std::fs::remove_file(&path) {
                            Ok(()) => {
                                debug!(file = ?path, "removed stale {} file", dir_name);
                                state.removed += 1;
                            }
                            Err(e) => {
                                warn!(file = ?path, error = %e, "failed to remove stale {} file", dir_name);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Extract a session ID from a session file path.
///
/// Session files follow the pattern `<session_id>.<ext>` (e.g. `abc123.json`,
/// `abc123.terminal`, `abc123.terminal-state.json`). We take the filename
/// stem before the first dot.
fn extract_session_id(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?;
    let dot_pos = file_name.find('.')?;
    Some(file_name[..dot_pos].to_string())
}

#[cfg(test)]
mod tests {
    use super::{extract_session_id, GC_INTERVAL, MAX_REMOVALS_PER_SWEEP, SESSION_FILE_TTL};
    use std::time::Duration;

    #[test]
    fn constants_are_reasonable() {
        assert!(SESSION_FILE_TTL >= Duration::from_secs(3600)); // at least 1h
        assert!(GC_INTERVAL >= Duration::from_secs(60)); // at least 1min
        assert!(MAX_REMOVALS_PER_SWEEP > 0);
    }

    #[test]
    fn extract_session_id_from_paths() {
        use std::path::PathBuf;

        assert_eq!(
            extract_session_id(&PathBuf::from("abc123.json")),
            Some("abc123".to_string())
        );
        assert_eq!(
            extract_session_id(&PathBuf::from("abc123.terminal")),
            Some("abc123".to_string())
        );
        assert_eq!(
            extract_session_id(&PathBuf::from("abc123.terminal-state.json")),
            Some("abc123".to_string())
        );
        assert_eq!(
            extract_session_id(&PathBuf::from("/some/path/xyz-456.log")),
            Some("xyz-456".to_string())
        );
        assert_eq!(extract_session_id(&PathBuf::from("noext")), None);
    }
}
