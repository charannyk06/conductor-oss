use anyhow::Result;
use conductor_core::event::{Event, EventBus};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Board file watcher that detects Kanban board changes.
pub struct BoardWatcher {
    #[allow(dead_code)]
    event_bus: EventBus,
    #[allow(dead_code)]
    watched_paths: Arc<Mutex<HashMap<PathBuf, String>>>, // path -> content hash
    _watcher: RecommendedWatcher,
}

impl BoardWatcher {
    /// Create a new board watcher with the given event bus.
    pub fn new(
        event_bus: EventBus,
        boards: Vec<(String, PathBuf)>, // (project_id, board_path)
    ) -> Result<Self> {
        let watched_paths = Arc::new(Mutex::new(HashMap::new()));

        // Initialize content hashes.
        {
            let mut paths = watched_paths.lock().unwrap();
            for (_, path) in &boards {
                if path.exists() {
                    let content = std::fs::read_to_string(path).unwrap_or_default();
                    let hash = content_hash(&content);
                    paths.insert(path.clone(), hash);
                }
            }
        }

        let (tx, mut rx) = mpsc::channel(256);

        // Create file system watcher.
        let watcher_tx = tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    if watcher_tx.try_send(event).is_err() {
                        // Channel full or closed — drop event (debounce will catch next change)
                    }
                }
            },
            Config::default(),
        )?;

        // Watch each board file's parent directory.
        for (_, path) in &boards {
            if let Some(parent) = path.parent() {
                if parent.exists() {
                    watcher.watch(parent, RecursiveMode::NonRecursive)?;
                }
            }
        }

        let bus = event_bus.clone();
        let paths = watched_paths.clone();
        let board_map: HashMap<PathBuf, String> = boards
            .into_iter()
            .map(|(project_id, path)| (path, project_id))
            .collect();

        // Spawn event processing task.
        tokio::spawn(async move {
            // Debounce: wait 500ms after last change before processing.
            let mut debounce_timer: Option<tokio::time::Instant> = None;
            let mut pending_paths: Vec<PathBuf> = Vec::new();

            loop {
                tokio::select! {
                    event = rx.recv() => {
                        let Some(event) = event else {
                            // Sender dropped (watcher dropped), exit the loop.
                            break;
                        };
                        if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                            for path in event.paths {
                                if board_map.contains_key(&path) {
                                    pending_paths.push(path);
                                    debounce_timer = Some(tokio::time::Instant::now() + std::time::Duration::from_millis(500));
                                }
                            }
                        }
                    }
                    _ = async {
                        if let Some(timer) = debounce_timer {
                            tokio::time::sleep_until(timer).await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {
                        debounce_timer = None;
                        for path in pending_paths.drain(..) {
                            if let Ok(content) = tokio::fs::read_to_string(&path).await {
                                let new_hash = content_hash(&content);
                                let mut hashes = paths.lock().unwrap();
                                let changed = hashes.get(&path) != Some(&new_hash);
                                if changed {
                                    hashes.insert(path.clone(), new_hash);
                                    if let Some(project_id) = board_map.get(&path) {
                                        tracing::info!("Board changed: {project_id} ({})", path.display());
                                        bus.publish(Event::BoardChanged {
                                            project_id: project_id.clone(),
                                            path: path.display().to_string(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            event_bus,
            watched_paths,
            _watcher: watcher,
        })
    }
}

fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}
