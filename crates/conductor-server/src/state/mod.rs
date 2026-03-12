mod app_update;
mod board_collaboration;
mod detached_runtime;
mod helpers;
mod runtime_status;
mod session_manager;
mod session_store;
mod spawn_queue;
mod terminal_hosts;
mod tmux_runtime;
pub mod types;
mod workspace;

pub use app_update::{AppInstallMode, AppUpdateConfig, AppUpdateJobStatus, AppUpdateStatus};
pub use board_collaboration::{BoardActivityRecord, BoardCommentRecord, WebhookDeliveryRecord};
pub use detached_runtime::run_detached_pty_host;
pub use helpers::{
    build_normalized_chat_feed, resolve_board_file, session_to_dashboard_value, trim_lines_tail,
};
pub use runtime_status::{build_session_runtime_status, SessionRuntimeStatus};
pub(crate) use session_manager::OutputConsumerConfig;
pub(crate) use tmux_runtime::{
    capture_tmux_pane, tmux_runtime_metadata, tmux_session_exists, TMUX_LOG_PATH_METADATA_KEY,
};
pub use types::{
    ConversationEntry, LiveSessionHandle, SessionPrInfo, SessionRecord, SessionStatus,
    SpawnRequest, TerminalRestoreSnapshot, TerminalStreamChunk, TerminalStreamEvent,
    TERMINAL_RESTORE_SNAPSHOT_FORMAT, TERMINAL_RESTORE_SNAPSHOT_VERSION,
};
pub use workspace::{expand_path, resolve_workspace_path};

use anyhow::Result;
use board_collaboration::BoardCollaborationStore;
use chrono::{DateTime, Utc};
use conductor_core::config::{ConductorConfig, DashboardAccessConfig, PreferencesConfig};
use conductor_core::support::{startup_config_sync, sync_workspace_support_files};
use conductor_core::types::AgentKind;
use conductor_db::Database;
use conductor_executors::executor::{Executor, ExecutorInput};
use conductor_executors::process::PtyDimensions;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use terminal_hosts::TerminalHostRegistry;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};

pub(crate) struct DevServerRecord {
    pub pid: u32,
    pub log_path: String,
}

pub(crate) struct DevServerLaunch {
    pub log_path: Option<String>,
    pub preview_url: Option<String>,
    pub preview_port: Option<u16>,
}

struct RuntimeStatusCacheEntry {
    fetched_at: Instant,
    status: Option<SessionRuntimeStatus>,
}

struct DashboardSessionCacheEntry {
    value: Value,
    serialized: String,
}

#[derive(Default)]
struct DashboardSnapshotCache {
    ordered_ids: Vec<String>,
    sessions_by_id: HashMap<String, DashboardSessionCacheEntry>,
}

struct FeedPayloadCacheEntry {
    payload: Value,
}

const RUNTIME_STATUS_CACHE_TTL: Duration = Duration::from_millis(1500);
const TERMINAL_CAPTURE_BUFFER_CAPACITY: usize = 64 * 1024;
const TERMINAL_CAPTURE_FLUSH_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_CAPTURE_FORCE_FLUSH_BYTES: usize = 16 * 1024;
const TERMINAL_RESTORE_PERSIST_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_RESTORE_FORCE_SEQUENCE_DELTA: u64 = 24;
const TERMINAL_HOST_MAINTENANCE_INTERVAL: Duration = Duration::from_millis(500);
const TERMINAL_HOST_IDLE_EVICTION_TTL: Duration = Duration::from_secs(45);

/// Shared application state for the HTTP server.
pub struct AppState {
    pub config_path: PathBuf,
    pub workspace_path: PathBuf,
    pub config: RwLock<ConductorConfig>,
    pub db: Database,
    pub executors: RwLock<HashMap<AgentKind, Arc<dyn Executor>>>,
    pub sessions: RwLock<HashMap<String, SessionRecord>>,
    terminal_hosts: TerminalHostRegistry,
    pub event_snapshots: broadcast::Sender<String>,
    /// Sends (session_id, delta_line) for incremental output updates.
    pub output_updates: broadcast::Sender<(String, String)>,
    pub app_update_config: AppUpdateConfig,
    app_update: Mutex<app_update::AppUpdateRuntime>,
    pub started_at: DateTime<Utc>,
    board_collaboration: RwLock<BoardCollaborationStore>,
    /// Serializes board-triggered spawns to prevent TOCTOU races in limit checks.
    pub spawn_guard: Mutex<()>,
    dev_servers: Mutex<HashMap<String, DevServerRecord>>,
    runtime_status_cache: Mutex<HashMap<String, RuntimeStatusCacheEntry>>,
    dashboard_snapshot_cache: Mutex<DashboardSnapshotCache>,
    feed_payload_cache: Mutex<HashMap<String, FeedPayloadCacheEntry>>,
}

impl AppState {
    pub async fn new(config_path: PathBuf, config: ConductorConfig, db: Database) -> Arc<Self> {
        let workspace_path = resolve_workspace_path(&config_path, &config.workspace);
        let (event_snapshots, _) = broadcast::channel(256);
        let (output_updates, _) = broadcast::channel(512);
        let app_update_config = AppUpdateConfig::from_env();
        let app_update_state = app_update::AppUpdateRuntime::new(&app_update_config);
        let state = Arc::new(Self {
            config_path,
            workspace_path,
            config: RwLock::new(config),
            db,
            executors: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            terminal_hosts: TerminalHostRegistry::default(),
            event_snapshots,
            output_updates,
            app_update: Mutex::new(app_update_state),
            app_update_config,
            started_at: Utc::now(),
            board_collaboration: RwLock::new(BoardCollaborationStore::default()),
            spawn_guard: Mutex::new(()),
            dev_servers: Mutex::new(HashMap::new()),
            runtime_status_cache: Mutex::new(HashMap::new()),
            dashboard_snapshot_cache: Mutex::new(DashboardSnapshotCache::default()),
            feed_payload_cache: Mutex::new(HashMap::new()),
        });
        state.ensure_session_store();
        state.load_sessions_from_disk().await;
        state.load_board_collaboration_from_disk().await;
        state
    }

    pub async fn discover_executors(self: &Arc<Self>) {
        let discovered = conductor_executors::discover_executors().await;
        let mut executors = self.executors.write().await;
        *executors = discovered;
        drop(executors);
        self.kick_spawn_supervisor().await;
    }

    pub async fn save_config(&self) -> Result<()> {
        let config = self.config.read().await.clone();
        config.save(&self.config_path)?;
        let _ = startup_config_sync(&config, &self.workspace_path, false)?;
        let _ = sync_workspace_support_files(&config, &self.workspace_path)?;
        Ok(())
    }

    pub async fn update_preferences(
        &self,
        preferences: PreferencesConfig,
    ) -> Result<PreferencesConfig> {
        {
            let mut config = self.config.write().await;
            let previous_agent = config.preferences.coding_agent.clone();
            if previous_agent != preferences.coding_agent {
                for project in config.projects.values_mut() {
                    if project.agent.as_deref() == Some(previous_agent.as_str()) {
                        project.agent = None;
                    }
                }
            }
            config.preferences = preferences.clone();
        }
        self.save_config().await?;
        Ok(preferences)
    }

    pub async fn update_access(
        &self,
        access: DashboardAccessConfig,
    ) -> Result<DashboardAccessConfig> {
        {
            let mut config = self.config.write().await;
            config.access = access.clone();
        }
        self.save_config().await?;
        Ok(access)
    }

    async fn refresh_dashboard_snapshot_cache(&self) -> (Vec<Value>, Vec<String>) {
        let sessions = self.sessions.read().await;
        let mut list: Vec<SessionRecord> = sessions
            .values()
            .filter(|session| session.status != SessionStatus::Archived)
            .cloned()
            .collect();
        list.sort_by(|left, right| right.created_at.cmp(&left.created_at));

        let mut queued = list
            .iter()
            .filter(|session| session.status == SessionStatus::Queued)
            .map(|session| (session.created_at.clone(), session.id.clone()))
            .collect::<Vec<_>>();
        queued.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
        let queue_depth = queued.len();
        let queue_positions = queued
            .into_iter()
            .enumerate()
            .map(|(index, (_, id))| (id, index + 1))
            .collect::<HashMap<_, _>>();

        let mut cache = self.dashboard_snapshot_cache.lock().await;
        let mut changed_sessions = Vec::new();
        let mut ordered_ids = Vec::with_capacity(list.len());
        let active_ids = list
            .iter()
            .map(|session| session.id.clone())
            .collect::<HashSet<_>>();

        let removed_ids = cache
            .sessions_by_id
            .keys()
            .filter(|session_id| !active_ids.contains(*session_id))
            .cloned()
            .collect::<Vec<_>>();

        for session_id in &removed_ids {
            cache.sessions_by_id.remove(session_id);
        }

        for mut session in list {
            if let Some(position) = queue_positions.get(&session.id) {
                session
                    .metadata
                    .insert("queuePosition".to_string(), position.to_string());
                session
                    .metadata
                    .insert("queueDepth".to_string(), queue_depth.to_string());
            }

            let value = session_to_dashboard_value(&session);
            let serialized = serde_json::to_string(&value).unwrap_or_default();
            let session_id = session.id.clone();
            ordered_ids.push(session_id.clone());

            let changed = cache
                .sessions_by_id
                .get(&session_id)
                .map(|entry| entry.serialized != serialized)
                .unwrap_or(true);

            if changed {
                cache.sessions_by_id.insert(
                    session_id,
                    DashboardSessionCacheEntry {
                        value: value.clone(),
                        serialized,
                    },
                );
                changed_sessions.push(value);
            }
        }

        cache.ordered_ids = ordered_ids;
        (changed_sessions, removed_ids)
    }

    async fn cached_snapshot_sessions(&self) -> Vec<Value> {
        let cache = self.dashboard_snapshot_cache.lock().await;
        cache
            .ordered_ids
            .iter()
            .filter_map(|session_id| cache.sessions_by_id.get(session_id))
            .map(|entry| entry.value.clone())
            .collect()
    }

    pub async fn snapshot_sessions(&self) -> Vec<Value> {
        let _ = self.refresh_dashboard_snapshot_cache().await;
        self.cached_snapshot_sessions().await
    }

    pub async fn snapshot_event_json(&self) -> String {
        let _ = self.refresh_dashboard_snapshot_cache().await;
        serde_json::to_string(&json!({
            "type": "snapshot",
            "sessions": self.cached_snapshot_sessions().await,
            "appUpdate": self.app_update_snapshot().await,
        }))
        .unwrap_or_else(|_| "{\"type\":\"snapshot\",\"sessions\":[]}".to_string())
    }

    pub async fn publish_snapshot(&self) {
        let (sessions, removed_session_ids) = self.refresh_dashboard_snapshot_cache().await;
        let payload = serde_json::to_string(&json!({
            "type": "snapshot_delta",
            "sessions": sessions,
            "removedSessionIds": removed_session_ids,
            "appUpdate": self.app_update_snapshot().await,
        }))
        .unwrap_or_else(|_| "{\"type\":\"snapshot_delta\",\"sessions\":[]}".to_string());
        let _ = self.event_snapshots.send(payload);
    }

    pub async fn all_sessions(&self) -> Vec<SessionRecord> {
        let sessions = self.sessions.read().await;
        let mut list: Vec<SessionRecord> = sessions.values().cloned().collect();
        list.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        list
    }

    pub async fn get_session(&self, session_id: &str) -> Option<SessionRecord> {
        self.sessions.read().await.get(session_id).cloned()
    }

    pub async fn dashboard_session(&self, session_id: &str) -> Option<Value> {
        let _ = self.refresh_dashboard_snapshot_cache().await;
        let cache = self.dashboard_snapshot_cache.lock().await;
        cache
            .sessions_by_id
            .get(session_id)
            .map(|entry| entry.value.clone())
    }

    pub async fn session_runtime_status(
        &self,
        session: &SessionRecord,
    ) -> Option<SessionRuntimeStatus> {
        {
            let cache = self.runtime_status_cache.lock().await;
            if let Some(entry) = cache.get(&session.id) {
                if entry.fetched_at.elapsed() < RUNTIME_STATUS_CACHE_TTL {
                    return entry.status.clone();
                }
            }
        }

        let status = build_session_runtime_status(session).await;
        let mut cache = self.runtime_status_cache.lock().await;
        cache.insert(
            session.id.clone(),
            RuntimeStatusCacheEntry {
                fetched_at: Instant::now(),
                status: status.clone(),
            },
        );
        status
    }

    pub(crate) async fn invalidate_session_caches(&self, session_id: &str) {
        self.runtime_status_cache.lock().await.remove(session_id);
        self.feed_payload_cache.lock().await.remove(session_id);
    }

    pub(crate) async fn cached_feed_payload(&self, session_id: &str) -> Option<Value> {
        self.feed_payload_cache
            .lock()
            .await
            .get(session_id)
            .map(|entry| entry.payload.clone())
    }

    pub(crate) async fn store_feed_payload(&self, session_id: &str, payload: Value) {
        self.feed_payload_cache
            .lock()
            .await
            .insert(session_id.to_string(), FeedPayloadCacheEntry { payload });
    }

    pub(crate) fn start_terminal_host_watchdog(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(TERMINAL_HOST_MAINTENANCE_INTERVAL);
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = state.terminal_hosts.wait_for_flush_request() => {}
                }
                state.maintain_terminal_hosts().await;
            }
        });
    }

    async fn maintain_terminal_hosts(&self) {
        for (session_id, handle) in self.terminal_hosts.dirty_capture_hosts().await {
            self.flush_terminal_capture_handle(&session_id, &handle)
                .await;
        }

        for (session_id, handle) in self.terminal_hosts.dirty_hosts().await {
            self.flush_terminal_restore_snapshot_handle(&session_id, &handle)
                .await;
        }

        for (session_id, handle) in self
            .terminal_hosts
            .idle_eviction_candidates(TERMINAL_HOST_IDLE_EVICTION_TTL)
            .await
        {
            self.flush_terminal_restore_snapshot_handle(&session_id, &handle)
                .await;
            if self
                .terminal_hosts
                .remove_if_same(&session_id, &handle)
                .await
            {
                tracing::debug!(session_id, "Evicted idle terminal host");
            }
        }
    }

    pub(crate) async fn has_terminal_host(&self, session_id: &str) -> bool {
        self.terminal_hosts.contains(session_id).await
    }

    pub(crate) async fn attached_terminal_session_ids(&self) -> Vec<String> {
        self.terminal_hosts.attached_session_ids().await
    }

    pub async fn take_terminal_host(&self, session_id: &str) -> Option<Arc<LiveSessionHandle>> {
        self.terminal_hosts.remove(session_id).await
    }

    pub(crate) async fn ensure_terminal_host(&self, session_id: &str) -> Arc<LiveSessionHandle> {
        if let Some(handle) = self.terminal_hosts.get(session_id).await {
            return handle;
        }

        let persisted_snapshot = match self.load_terminal_restore_snapshot(session_id).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                tracing::debug!(
                    session_id,
                    error = %err,
                    "Failed to load persisted terminal restore snapshot"
                );
                None
            }
        };

        self.terminal_hosts
            .ensure_host(session_id, persisted_snapshot.as_ref())
            .await
    }

    pub(crate) async fn attach_terminal_runtime(
        &self,
        session_id: &str,
        input_tx: mpsc::Sender<ExecutorInput>,
        resize_tx: Option<mpsc::Sender<PtyDimensions>>,
        kill_tx: oneshot::Sender<()>,
    ) -> Arc<LiveSessionHandle> {
        let handle = self.ensure_terminal_host(session_id).await;
        self.terminal_hosts
            .attach_runtime(&handle, input_tx, resize_tx, kill_tx)
            .await;
        handle
    }

    pub(crate) async fn detach_terminal_runtime(&self, session_id: &str) {
        self.flush_terminal_capture(session_id).await;
        self.flush_terminal_restore_snapshot(session_id).await;
        let Some(handle) = self.terminal_hosts.peek(session_id).await else {
            return;
        };
        self.terminal_hosts.detach_runtime(&handle).await;
    }

    pub(crate) async fn terminal_runtime_attached(&self, session_id: &str) -> bool {
        self.terminal_hosts.runtime_attached(session_id).await
    }

    pub(crate) async fn emit_terminal_stream_event(
        &self,
        session_id: &str,
        event: TerminalStreamEvent,
    ) {
        if matches!(
            &event,
            TerminalStreamEvent::Exit(_) | TerminalStreamEvent::Error(_)
        ) {
            self.flush_terminal_capture(session_id).await;
            self.flush_terminal_restore_snapshot(session_id).await;
        }
        if let Some(handle) = self.terminal_hosts.get(session_id).await {
            let _ = handle.terminal_tx.send(event);
        }
    }

    fn should_flush_terminal_capture(capture: &types::TerminalCaptureState) -> bool {
        capture.pending_bytes >= TERMINAL_CAPTURE_FORCE_FLUSH_BYTES
            || capture
                .last_flushed_at
                .map(|flushed_at| flushed_at.elapsed() >= TERMINAL_CAPTURE_FLUSH_INTERVAL)
                .unwrap_or(true)
    }

    async fn append_terminal_capture_buffered(
        &self,
        session_id: &str,
        handle: &Arc<LiveSessionHandle>,
        bytes: &[u8],
    ) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }

        let path = self.session_terminal_capture_path(session_id);
        let mut capture = handle.terminal_capture.lock().await;
        if capture.writer.is_none() {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await?;
            capture.writer = Some(tokio::io::BufWriter::with_capacity(
                TERMINAL_CAPTURE_BUFFER_CAPACITY,
                file,
            ));
        }

        let write_result = capture
            .writer
            .as_mut()
            .expect("terminal capture writer should exist after lazy open")
            .write_all(bytes)
            .await;
        if let Err(err) = write_result {
            capture.writer = None;
            return Err(err.into());
        }

        capture.dirty = true;
        capture.pending_bytes = capture.pending_bytes.saturating_add(bytes.len());
        let should_request_flush = Self::should_flush_terminal_capture(&capture);
        drop(capture);
        if should_request_flush {
            self.terminal_hosts.request_flush();
        }
        Ok(())
    }

    fn should_persist_terminal_restore(
        tracking: &types::TerminalPersistenceState,
        update: &types::TerminalStateUpdate,
    ) -> bool {
        tracking.last_persisted_sequence == 0
            || update.sequence <= 1
            || update
                .sequence
                .saturating_sub(tracking.last_persisted_sequence)
                >= TERMINAL_RESTORE_FORCE_SEQUENCE_DELTA
            || tracking
                .last_persisted_at
                .map(|persisted_at| persisted_at.elapsed() >= TERMINAL_RESTORE_PERSIST_INTERVAL)
                .unwrap_or(true)
    }

    async fn record_terminal_restore_persisted(handle: &Arc<LiveSessionHandle>, sequence: u64) {
        let mut tracking = handle.terminal_persistence.lock().await;
        tracking.last_persisted_sequence = sequence;
        tracking.last_persisted_at = Some(Instant::now());
        tracking.dirty = false;
    }

    async fn maybe_checkpoint_terminal_restore_snapshot(
        &self,
        handle: &Arc<LiveSessionHandle>,
        update: &types::TerminalStateUpdate,
    ) {
        let should_request_flush = {
            let mut tracking = handle.terminal_persistence.lock().await;
            tracking.dirty = true;
            tracking.last_touched_at = Instant::now();
            Self::should_persist_terminal_restore(&tracking, update)
        };

        if should_request_flush {
            self.terminal_hosts.request_flush();
        }
    }

    async fn flush_terminal_restore_snapshot_handle(
        &self,
        session_id: &str,
        handle: &Arc<LiveSessionHandle>,
    ) {
        let snapshot = match handle.terminal_store.lock() {
            Ok(store) => store.restore_snapshot(),
            Err(_) => return,
        };

        let should_flush = {
            let tracking = handle.terminal_persistence.lock().await;
            tracking.dirty || tracking.last_persisted_sequence != snapshot.sequence
        };
        if !should_flush {
            return;
        }

        if let Err(err) = self
            .persist_terminal_restore_snapshot(session_id, &snapshot)
            .await
        {
            tracing::debug!(
                session_id,
                error = %err,
                "Failed to flush terminal restore snapshot"
            );
            let mut tracking = handle.terminal_persistence.lock().await;
            tracking.dirty = true;
            return;
        }

        Self::record_terminal_restore_persisted(handle, snapshot.sequence).await;
    }

    async fn flush_terminal_capture_handle(
        &self,
        session_id: &str,
        handle: &Arc<LiveSessionHandle>,
    ) {
        let mut capture = handle.terminal_capture.lock().await;
        if !capture.dirty {
            return;
        }

        let Some(writer) = capture.writer.as_mut() else {
            capture.dirty = false;
            capture.pending_bytes = 0;
            capture.last_flushed_at = Some(Instant::now());
            return;
        };

        if let Err(err) = writer.flush().await {
            tracing::debug!(
                session_id,
                error = %err,
                "Failed to flush terminal capture bytes"
            );
            capture.writer = None;
            capture.dirty = true;
            return;
        }

        capture.dirty = false;
        capture.pending_bytes = 0;
        capture.last_flushed_at = Some(Instant::now());
    }

    pub(crate) async fn flush_terminal_capture(&self, session_id: &str) {
        let Some(handle) = self.terminal_hosts.peek(session_id).await else {
            return;
        };
        self.flush_terminal_capture_handle(session_id, &handle)
            .await;
    }

    pub(crate) async fn flush_terminal_restore_snapshot(&self, session_id: &str) {
        let Some(handle) = self.terminal_hosts.peek(session_id).await else {
            return;
        };
        self.flush_terminal_restore_snapshot_handle(session_id, &handle)
            .await;
    }

    async fn apply_terminal_output(
        &self,
        session_id: &str,
        bytes: &[u8],
    ) -> Option<(Arc<LiveSessionHandle>, types::TerminalStateUpdate)> {
        if bytes.is_empty() {
            return None;
        }

        let handle = self.ensure_terminal_host(session_id).await;
        if let Err(err) = self
            .append_terminal_capture_buffered(session_id, &handle, bytes)
            .await
        {
            tracing::debug!(
                session_id,
                error = %err,
                "Failed to persist terminal capture bytes"
            );
        }
        let update = if let Ok(mut store) = handle.terminal_store.lock() {
            store.apply_output(bytes)
        } else {
            None
        };
        if let Some(update) = update.as_ref() {
            self.maybe_checkpoint_terminal_restore_snapshot(&handle, update)
                .await;
        }
        update.map(|update| (handle, update))
    }

    pub(crate) async fn emit_terminal_bytes(&self, session_id: &str, bytes: &[u8]) {
        let Some((handle, update)) = self.apply_terminal_output(session_id, bytes).await else {
            return;
        };

        let _ = handle
            .terminal_tx
            .send(TerminalStreamEvent::Stream(TerminalStreamChunk {
                sequence: update.sequence,
                bytes: bytes.to_vec(),
            }));
    }

    pub(crate) async fn emit_terminal_text(&self, session_id: &str, text: impl AsRef<str>) {
        self.emit_terminal_bytes(session_id, text.as_ref().as_bytes())
            .await;
    }

    pub(crate) async fn resize_terminal_store(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(handle) = self.terminal_hosts.get(session_id).await {
            let snapshot = if let Ok(mut store) = handle.terminal_store.lock() {
                Some(store.resize(cols, rows))
            } else {
                None
            };
            if let Some(snapshot) = snapshot.as_ref() {
                if let Err(err) = self
                    .persist_terminal_restore_snapshot(session_id, snapshot)
                    .await
                {
                    tracing::debug!(
                        session_id,
                        error = %err,
                        "Failed to persist resized terminal restore snapshot"
                    );
                } else {
                    Self::record_terminal_restore_persisted(&handle, snapshot.sequence).await;
                }
            }
        }
    }

    pub(crate) async fn current_terminal_restore_snapshot(
        &self,
        session_id: &str,
    ) -> Option<TerminalRestoreSnapshot> {
        if let Some(handle) = self.terminal_hosts.get(session_id).await {
            if let Some(snapshot) = handle
                .terminal_store
                .lock()
                .ok()
                .map(|store| store.restore_snapshot())
                .filter(|snapshot| !snapshot.is_empty())
            {
                return Some(snapshot);
            }
        }

        match self.load_terminal_restore_snapshot(session_id).await {
            Ok(snapshot) => snapshot.filter(|snapshot| !snapshot.is_empty()),
            Err(err) => {
                tracing::debug!(
                    session_id,
                    error = %err,
                    "Failed to load persisted terminal restore snapshot"
                );
                None
            }
        }
    }

    pub fn config_projects_payload(&self, config: &ConductorConfig) -> Value {
        let workspace_path = self.workspace_path.clone();
        let projects = config
            .projects
            .iter()
            .map(|(id, project)| {
                let board_dir = project.board_dir.clone().unwrap_or_else(|| id.clone());
                json!({
                    "id": id,
                    "repo": project.repo,
                    "path": expand_path(&project.path, &workspace_path).to_string_lossy().to_string(),
                    "iconUrl": project.icon_url,
                    "boardDir": board_dir,
                    "boardFile": resolve_board_file(&workspace_path, &board_dir, Some(&project.path)),
                    "description": project.description,
                    "githubProject": project.github_project.clone(),
                    "defaultBranch": project.default_branch.clone(),
                    "agent": project.agent.clone().unwrap_or_else(|| config.preferences.coding_agent.clone()),
                    "agentPermissions": project.agent_config.permissions,
                    "agentModel": project.agent_config.model,
                    "agentReasoningEffort": project.agent_config.reasoning_effort,
                })
            })
            .collect::<Vec<_>>();
        json!({ "projects": projects })
    }
}
