mod acp_dispatcher;
mod app_update;
mod board_collaboration;
mod bridge_registry;
mod detached;
mod helpers;
mod mcp_config;
mod runtime_status;
mod session_manager;
mod session_store;
mod spawn_queue;
mod terminal_hosts;
pub mod types;
mod workspace;

pub(crate) use acp_dispatcher::{
    dispatcher_implementation_agent_options, dispatcher_implementation_model_options,
    dispatcher_implementation_reasoning_options, dispatcher_preferred_implementation_agent,
    dispatcher_preferred_implementation_model,
    dispatcher_preferred_implementation_reasoning_effort, CreateDispatcherThreadOptions,
    DispatcherRuntimeHandle, DispatcherSelectOption, DispatcherTurnRequest,
    ACP_ACTIVE_SKILLS_METADATA_KEY,
};
pub use app_update::{AppInstallMode, AppUpdateConfig, AppUpdateJobStatus, AppUpdateStatus};
pub use board_collaboration::{BoardActivityRecord, BoardCommentRecord, WebhookDeliveryRecord};
pub(crate) use bridge_registry::{BridgeConnectionRecord, BridgeConnectionStatus};
pub(crate) use detached::DETACHED_LOG_PATH_METADATA_KEY;
pub(crate) use detached::DETACHED_PID_METADATA_KEY;
pub(crate) use detached::{
    RUNTIME_MODE_METADATA_KEY, TTYD_PID_METADATA_KEY, TTYD_RUNTIME_MODE, TTYD_WS_URL_METADATA_KEY,
};
pub(crate) use helpers::sanitize_terminal_text;
pub(crate) use helpers::session_to_dashboard_value_with_bridge;
pub use helpers::{
    build_normalized_chat_feed, resolve_board_file, session_to_dashboard_value, trim_lines_tail,
};
pub(crate) use mcp_config::{
    build_codex_mcp_config_args, deserialize_mcp_servers, merge_mcp_servers, parse_acp_mcp_servers,
    serialize_mcp_servers, ACP_SESSION_MCP_SERVERS_METADATA_KEY,
};
pub use runtime_status::{build_session_runtime_status, SessionRuntimeStatus};
pub(crate) use session_manager::OutputConsumerConfig;
pub use types::{
    ConversationEntry, LiveSessionHandle, SessionPrInfo, SessionRecord, SessionStatus,
    SpawnRequest, TerminalRestoreSnapshot, TerminalStreamChunk, TerminalStreamEvent,
    TERMINAL_RESTORE_SNAPSHOT_FORMAT, TERMINAL_RESTORE_SNAPSHOT_VERSION,
};
pub use workspace::{expand_path, resolve_workspace_path};

use anyhow::Result;
use board_collaboration::BoardCollaborationStore;
use chrono::{DateTime, Utc};
use conductor_core::config::{
    ConductorConfig, DashboardAccessConfig, McpServerConfig, PreferencesConfig, ProjectConfig,
};
use conductor_core::support::{startup_config_sync, sync_workspace_support_files};
use conductor_core::types::AgentKind;
use conductor_db::Database;
use conductor_executors::executor::{Executor, ExecutorInput};
use conductor_executors::process::PtyDimensions;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use terminal_hosts::TerminalHostRegistry;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Notify, RwLock};

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
    window_limit: usize,
}

const RUNTIME_STATUS_CACHE_TTL: Duration = Duration::from_millis(1500);
const SESSION_FLUSH_DEBOUNCE_INTERVAL: Duration = Duration::from_millis(125);
const TERMINAL_CAPTURE_BUFFER_CAPACITY: usize = 64 * 1024;
const TERMINAL_CAPTURE_FLUSH_INTERVAL: Duration = Duration::from_millis(32);
const TERMINAL_CAPTURE_FORCE_FLUSH_BYTES: usize = 64 * 1024;
const TERMINAL_RESTORE_PERSIST_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_RESTORE_FORCE_SEQUENCE_DELTA: u64 = 24;
const TERMINAL_HOST_MAINTENANCE_INTERVAL: Duration = Duration::from_millis(500);
const TERMINAL_HOST_IDLE_EVICTION_TTL: Duration = Duration::from_secs(45);
const BRIDGE_REGISTRY_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30);

#[cfg(test)]
pub(crate) fn ttyd_binary_available(workspace_path: &Path) -> bool {
    detached::ttyd_launcher::resolve_ttyd_binary(workspace_path).is_some()
}

pub(crate) fn is_project_dispatcher_session(session: &SessionRecord) -> bool {
    session.metadata.get("sessionKind").map(String::as_str) == Some("project_dispatcher")
}

pub(crate) fn is_dashboard_hidden_session(session: &SessionRecord) -> bool {
    session.metadata.get("dashboardHidden").map(String::as_str) == Some("true")
        || is_project_dispatcher_session(session)
}

/// Shared application state for the HTTP server.
pub struct AppState {
    pub config_path: PathBuf,
    pub workspace_path: PathBuf,
    pub config: RwLock<ConductorConfig>,
    pub db: Database,
    pub executors: RwLock<HashMap<AgentKind, Arc<dyn Executor>>>,
    pub sessions: RwLock<HashMap<String, SessionRecord>>,
    pub dispatcher_threads: RwLock<HashMap<String, SessionRecord>>,
    terminal_hosts: TerminalHostRegistry,
    bridge_registry: RwLock<HashMap<String, BridgeConnectionRecord>>,
    pub event_snapshots: broadcast::Sender<String>,
    /// Sends (session_id, delta_line) for incremental output updates.
    pub output_updates: broadcast::Sender<(String, String)>,
    pub feed_updates: broadcast::Sender<String>,
    pub dispatcher_updates: broadcast::Sender<String>,
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
    pending_session_flushes: Mutex<HashSet<String>>,
    session_flush_notify: Arc<Notify>,
    dispatcher_feed_payload_cache: Mutex<HashMap<String, FeedPayloadCacheEntry>>,
    dispatcher_runtimes: Mutex<HashMap<String, DispatcherRuntimeHandle>>,
    pub active_session_skills: Mutex<HashMap<String, Vec<String>>>,
}

impl AppState {
    pub async fn new(config_path: PathBuf, config: ConductorConfig, db: Database) -> Arc<Self> {
        let workspace_path = resolve_workspace_path(&config_path, &config.workspace);
        let (event_snapshots, _) = broadcast::channel(256);
        let (output_updates, _) = broadcast::channel(512);
        let (feed_updates, _) = broadcast::channel(512);
        let (dispatcher_updates, _) = broadcast::channel(256);
        let app_update_config = AppUpdateConfig::from_env();
        let app_update_state = app_update::AppUpdateRuntime::new(&app_update_config);
        let state = Arc::new(Self {
            config_path,
            workspace_path,
            config: RwLock::new(config),
            db,
            executors: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            dispatcher_threads: RwLock::new(HashMap::new()),
            terminal_hosts: TerminalHostRegistry::default(),
            bridge_registry: RwLock::new(HashMap::new()),
            event_snapshots,
            output_updates,
            feed_updates,
            dispatcher_updates,
            app_update: Mutex::new(app_update_state),
            app_update_config,
            started_at: Utc::now(),
            board_collaboration: RwLock::new(BoardCollaborationStore::default()),
            spawn_guard: Mutex::new(()),
            dev_servers: Mutex::new(HashMap::new()),
            runtime_status_cache: Mutex::new(HashMap::new()),
            dashboard_snapshot_cache: Mutex::new(DashboardSnapshotCache::default()),
            feed_payload_cache: Mutex::new(HashMap::new()),
            pending_session_flushes: Mutex::new(HashSet::new()),
            session_flush_notify: Arc::new(Notify::new()),
            dispatcher_feed_payload_cache: Mutex::new(HashMap::new()),
            dispatcher_runtimes: Mutex::new(HashMap::new()),
            active_session_skills: Mutex::new(HashMap::new()),
        });
        state.ensure_session_store();
        state.ensure_dispatcher_store();
        state.load_sessions_from_disk().await;
        state.load_dispatchers_from_disk().await;
        state.load_board_collaboration_from_disk().await;
        state.start_session_flush_watchdog();
        state
    }

    pub async fn discover_executors(self: &Arc<Self>) {
        let discovered = conductor_executors::discover_executors().await;
        let mut executors = self.executors.write().await;
        *executors = discovered;
        drop(executors);
        self.kick_spawn_supervisor().await;
    }

    pub(crate) async fn serialize_dashboard_session(&self, session: &SessionRecord) -> Value {
        let bridge = match session.bridge_id.as_deref() {
            Some(bridge_id) => self.bridge_connection(bridge_id).await,
            None => None,
        };
        session_to_dashboard_value_with_bridge(session, bridge.as_ref())
    }

    pub async fn save_config(&self) -> Result<()> {
        let config = self.config.read().await.clone();
        config.save(&self.config_path)?;
        let _ = startup_config_sync(&config, &self.workspace_path, false)?;
        let _ = sync_workspace_support_files(&config, &self.workspace_path)?;
        Ok(())
    }

    pub(crate) fn internal_conductor_mcp_server(
        &self,
        session_id: &str,
        project_id: &str,
    ) -> Option<(String, McpServerConfig)> {
        let command = std::env::current_exe().ok()?;
        let command = command.to_string_lossy().to_string();
        if command.trim().is_empty() {
            return None;
        }

        let mut env = std::collections::BTreeMap::new();
        env.insert("CONDUCTOR_SESSION_ID".to_string(), session_id.to_string());
        env.insert("CONDUCTOR_PROJECT_ID".to_string(), project_id.to_string());
        env.insert(
            "CONDUCTOR_SESSION_KIND".to_string(),
            "project_dispatcher".to_string(),
        );

        Some((
            "conductor".to_string(),
            McpServerConfig {
                command,
                args: vec![
                    "--workspace".to_string(),
                    self.workspace_path.to_string_lossy().to_string(),
                    "--config".to_string(),
                    self.config_path.to_string_lossy().to_string(),
                    "mcp-server".to_string(),
                ],
                env,
                cwd: Some(self.workspace_path.to_string_lossy().to_string()),
                enabled: true,
            },
        ))
    }

    pub(crate) fn codex_mcp_extra_args(
        &self,
        config: &ConductorConfig,
        project: &ProjectConfig,
        session_id: &str,
        project_id: &str,
        session_kind: Option<&str>,
        session_mcp_servers: &std::collections::BTreeMap<String, McpServerConfig>,
    ) -> Vec<String> {
        let internal = if session_kind == Some("project_dispatcher") {
            self.internal_conductor_mcp_server(session_id, project_id)
        } else {
            None
        };
        let merged = merge_mcp_servers(
            &config.defaults.mcp_servers,
            &project.mcp_servers,
            session_mcp_servers,
            internal,
        );
        build_codex_mcp_config_args(&merged)
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

    pub async fn record_error(
        &self,
        ctx: crate::error_logger::ErrorContext,
        message: impl Into<String>,
    ) {
        let message = message.into();
        crate::error_logger::log_error(&ctx, &message);
        if let Err(err) = crate::error_logger::persist_error(&self.db, &ctx, &message).await {
            tracing::warn!(
                category = %ctx.category,
                error = %err,
                "failed to persist error record"
            );
        }
    }

    async fn refresh_dashboard_snapshot_cache(&self) -> (Vec<Value>, Vec<String>) {
        let sessions = self.sessions.read().await;
        let mut list: Vec<SessionRecord> = sessions
            .values()
            .filter(|session| {
                session.status != SessionStatus::Archived && !is_dashboard_hidden_session(session)
            })
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

            let value = self.serialize_dashboard_session(&session).await;
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

    pub async fn latest_project_dispatcher_session(
        &self,
        project_id: &str,
        bridge_id: Option<&str>,
    ) -> Option<SessionRecord> {
        self.all_sessions()
            .await
            .into_iter()
            .filter(|session| session.project_id == project_id)
            .filter(is_project_dispatcher_session)
            .filter(|session| !session.status.is_terminal())
            .filter(|session| match bridge_id {
                Some(expected) => session.bridge_id.as_deref() == Some(expected),
                None => session.bridge_id.is_none(),
            })
            .max_by(|left, right| {
                left.last_activity_at
                    .cmp(&right.last_activity_at)
                    .then(left.created_at.cmp(&right.created_at))
            })
    }

    pub async fn get_session(&self, session_id: &str) -> Option<SessionRecord> {
        self.sessions.read().await.get(session_id).cloned()
    }

    pub async fn dashboard_session(&self, session_id: &str) -> Option<Value> {
        match self.get_session(session_id).await {
            Some(session) => Some(self.serialize_dashboard_session(&session).await),
            None => None,
        }
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
        self.invalidate_runtime_status_cache(session_id).await;
        self.invalidate_feed_payload_cache(session_id).await;
    }

    pub(crate) async fn invalidate_runtime_status_cache(&self, session_id: &str) {
        self.runtime_status_cache.lock().await.remove(session_id);
    }

    pub(crate) async fn invalidate_feed_payload_cache(&self, session_id: &str) {
        self.feed_payload_cache.lock().await.remove(session_id);
    }

    pub(crate) fn publish_feed_update(&self, session_id: &str) {
        let _ = self.feed_updates.send(session_id.to_string());
    }

    pub(crate) async fn queue_session_flush(&self, session_id: &str) {
        self.pending_session_flushes
            .lock()
            .await
            .insert(session_id.to_string());
        self.session_flush_notify.notify_one();
    }

    pub(crate) async fn queue_hot_path_session_update(
        &self,
        session_id: &str,
        invalidate_runtime_status: bool,
    ) {
        if invalidate_runtime_status {
            self.invalidate_runtime_status_cache(session_id).await;
        }
        self.invalidate_feed_payload_cache(session_id).await;
        self.publish_feed_update(session_id);
        self.queue_session_flush(session_id).await;
    }

    pub(crate) async fn cached_feed_payload(
        &self,
        session_id: &str,
        window_limit: usize,
    ) -> Option<Value> {
        self.feed_payload_cache
            .lock()
            .await
            .get(session_id)
            .filter(|entry| entry.window_limit == window_limit)
            .map(|entry| entry.payload.clone())
    }

    pub(crate) async fn store_feed_payload(
        &self,
        session_id: &str,
        window_limit: usize,
        payload: Value,
    ) {
        self.feed_payload_cache.lock().await.insert(
            session_id.to_string(),
            FeedPayloadCacheEntry {
                payload,
                window_limit,
            },
        );
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

    fn start_session_flush_watchdog(self: &Arc<Self>) {
        let notify = Arc::clone(&self.session_flush_notify);
        let state = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                notify.notified().await;

                loop {
                    tokio::time::sleep(SESSION_FLUSH_DEBOUNCE_INTERVAL).await;

                    let Some(app_state) = state.upgrade() else {
                        return;
                    };
                    let pending_ids = {
                        let mut pending = app_state.pending_session_flushes.lock().await;
                        if pending.is_empty() {
                            Vec::new()
                        } else {
                            pending.drain().collect::<Vec<_>>()
                        }
                    };

                    if pending_ids.is_empty() {
                        break;
                    }

                    let pending_sessions = {
                        let sessions = app_state.sessions.read().await;
                        pending_ids
                            .iter()
                            .filter_map(|session_id| sessions.get(session_id).cloned())
                            .collect::<Vec<_>>()
                    };

                    for session in pending_sessions {
                        if let Err(err) = app_state.persist_session_snapshot(&session).await {
                            tracing::debug!(
                                session_id = %session.id,
                                error = %err,
                                "Failed to persist queued session snapshot"
                            );
                        }
                    }

                    app_state.publish_snapshot().await;
                }
            }
        });
    }

    pub(crate) fn start_bridge_registry_watchdog(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(BRIDGE_REGISTRY_MAINTENANCE_INTERVAL);
            loop {
                interval.tick().await;
                state.maintain_bridge_registry().await;
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

    pub(crate) async fn remove_terminal_host(
        &self,
        session_id: &str,
        final_event: Option<TerminalStreamEvent>,
    ) {
        let Some(handle) = self.take_terminal_host(session_id).await else {
            return;
        };
        self.terminal_hosts.detach_runtime(&handle).await;
        if let Some(event) = final_event {
            let _ = handle.terminal_tx.send(event);
        }
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

        if let Some(cwd) = update.cwd.clone() {
            self.update_terminal_cwd(session_id, &cwd).await;
        }

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

    #[cfg_attr(not(test), allow(dead_code))]
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
                if terminal_restore_snapshot_is_valid(&snapshot) {
                    return Some(snapshot);
                }

                tracing::debug!(
                    session_id,
                    "Falling back to persisted terminal restore snapshot after invalid live snapshot"
                );
            }
        }

        match self.load_terminal_restore_snapshot(session_id).await {
            Ok(snapshot) => snapshot
                .filter(|snapshot| !snapshot.is_empty())
                .filter(terminal_restore_snapshot_is_valid),
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

    pub(crate) async fn current_terminal_transcript(
        &self,
        session_id: &str,
        lines: usize,
        max_bytes: usize,
    ) -> Option<String> {
        if let Some(handle) = self.terminal_hosts.get(session_id).await {
            if let Some(transcript) = handle
                .terminal_store
                .lock()
                .ok()
                .map(|mut store| store.transcript_tail(lines, max_bytes))
                .filter(|transcript| !transcript.trim().is_empty())
            {
                return Some(transcript);
            }
        }

        match self.load_terminal_restore_snapshot(session_id).await {
            Ok(snapshot) => snapshot
                .filter(|snapshot| !snapshot.is_empty())
                .filter(terminal_restore_snapshot_is_valid)
                .map(|snapshot| snapshot.transcript(lines, max_bytes))
                .filter(|transcript| !transcript.trim().is_empty()),
            Err(err) => {
                tracing::debug!(
                    session_id,
                    error = %err,
                    "Failed to load persisted terminal restore transcript"
                );
                None
            }
        }
    }

    async fn update_terminal_cwd(&self, session_id: &str, cwd: &str) {
        let normalized = cwd.trim();
        if normalized.is_empty() {
            return;
        }

        let updated = {
            let mut sessions = self.sessions.write().await;
            let Some(session) = sessions.get_mut(session_id) else {
                return;
            };
            if session.metadata.get("agentCwd").map(String::as_str) == Some(normalized) {
                return;
            }
            session
                .metadata
                .insert("agentCwd".to_string(), normalized.to_string());
            session.last_activity_at = Utc::now().to_rfc3339();
            session.clone()
        };

        if let Err(err) = self.persist_session(&updated).await {
            tracing::debug!(session_id, error = %err, "Failed to persist terminal cwd");
            return;
        }

        self.publish_feed_update(session_id);
        self.publish_snapshot().await;
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

fn terminal_restore_snapshot_is_valid(snapshot: &TerminalRestoreSnapshot) -> bool {
    snapshot.screen.is_empty() || snapshot.screen.first() == Some(&0x1b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conductor_core::config::{DefaultsConfig, McpServerConfig};
    use conductor_db::Database;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    fn contains_arg(args: &[String], needle: &str) -> bool {
        args.iter().any(|arg| arg.contains(needle))
    }

    #[tokio::test]
    async fn codex_mcp_extra_args_inject_conductor_only_for_dispatcher_sessions() {
        let root = std::env::temp_dir().join(format!("conductor-state-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("test root should exist");

        let default_server = McpServerConfig {
            command: "npx".to_string(),
            args: vec!["@acme/default".to_string()],
            ..McpServerConfig::default()
        };
        let project_server = McpServerConfig {
            command: "npx".to_string(),
            args: vec!["@acme/project".to_string()],
            ..McpServerConfig::default()
        };
        let project = ProjectConfig {
            path: root.to_string_lossy().to_string(),
            mcp_servers: BTreeMap::from([("project".to_string(), project_server)]),
            ..ProjectConfig::default()
        };
        let config = ConductorConfig {
            workspace: root.clone(),
            defaults: DefaultsConfig {
                mcp_servers: BTreeMap::from([("default".to_string(), default_server)]),
            },
            projects: BTreeMap::from([("demo".to_string(), project.clone())]),
            ..ConductorConfig::default()
        };
        let config_path = root.join("conductor.yaml");
        let db = Database::in_memory()
            .await
            .expect("in-memory db should open");
        let state = AppState::new(config_path, config.clone(), db).await;

        let dispatcher_args = state.codex_mcp_extra_args(
            &config,
            &project,
            "session-1",
            "demo",
            Some("project_dispatcher"),
            &BTreeMap::new(),
        );
        assert!(
            contains_arg(&dispatcher_args, "mcp_servers.default.command"),
            "default MCP servers should be forwarded"
        );
        assert!(
            contains_arg(&dispatcher_args, "mcp_servers.project.command"),
            "project MCP servers should be forwarded"
        );
        assert!(
            contains_arg(&dispatcher_args, "mcp_servers.conductor.command"),
            "dispatcher sessions should receive the internal conductor MCP server"
        );

        let normal_args = state.codex_mcp_extra_args(
            &config,
            &project,
            "session-2",
            "demo",
            None,
            &BTreeMap::new(),
        );
        assert!(
            !contains_arg(&normal_args, "mcp_servers.conductor.command"),
            "non-dispatcher sessions should not receive the internal conductor MCP server"
        );
    }
}
