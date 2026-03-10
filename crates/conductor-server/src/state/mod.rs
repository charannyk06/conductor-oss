mod app_update;
mod board_collaboration;
mod helpers;
mod runtime_status;
mod session_manager;
mod session_store;
mod spawn_queue;
mod tmux_runtime;
pub mod types;
mod workspace;

pub use app_update::{AppInstallMode, AppUpdateConfig, AppUpdateJobStatus, AppUpdateStatus};
pub use board_collaboration::{BoardActivityRecord, BoardCommentRecord, WebhookDeliveryRecord};
pub use helpers::{
    build_normalized_chat_feed, resolve_board_file, session_to_dashboard_value, trim_lines_tail,
};
pub use runtime_status::{build_session_runtime_status, SessionRuntimeStatus};
pub(crate) use tmux_runtime::{
    capture_tmux_pane, tmux_runtime_metadata, tmux_session_exists, TMUX_LOG_PATH_METADATA_KEY,
};
pub use types::{
    ConversationEntry, LiveSessionHandle, SessionPrInfo, SessionRecord, SessionStatus,
    SpawnRequest, TerminalStreamEvent,
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
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
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

/// Shared application state for the HTTP server.
pub struct AppState {
    pub config_path: PathBuf,
    pub workspace_path: PathBuf,
    pub config: RwLock<ConductorConfig>,
    pub db: Database,
    pub executors: RwLock<HashMap<AgentKind, Arc<dyn Executor>>>,
    pub sessions: RwLock<HashMap<String, SessionRecord>>,
    pub live_sessions: RwLock<HashMap<String, Arc<LiveSessionHandle>>>,
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
            live_sessions: RwLock::new(HashMap::new()),
            event_snapshots,
            output_updates,
            app_update: Mutex::new(app_update_state),
            app_update_config,
            started_at: Utc::now(),
            board_collaboration: RwLock::new(BoardCollaborationStore::default()),
            spawn_guard: Mutex::new(()),
            dev_servers: Mutex::new(HashMap::new()),
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

    pub async fn snapshot_sessions(&self) -> Vec<Value> {
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

        list.into_iter()
            .map(|mut session| {
                if let Some(position) = queue_positions.get(&session.id) {
                    session
                        .metadata
                        .insert("queuePosition".to_string(), position.to_string());
                    session
                        .metadata
                        .insert("queueDepth".to_string(), queue_depth.to_string());
                }
                session_to_dashboard_value(&session)
            })
            .collect()
    }

    pub async fn snapshot_event_json(&self) -> String {
        serde_json::to_string(&json!({
            "type": "snapshot",
            "sessions": self.snapshot_sessions().await,
            "appUpdate": self.app_update_snapshot().await,
        }))
        .unwrap_or_else(|_| "{\"type\":\"snapshot\",\"sessions\":[]}".to_string())
    }

    pub async fn publish_snapshot(&self) {
        let payload = self.snapshot_event_json().await;
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

    pub(crate) fn new_terminal_stream(&self) -> broadcast::Sender<TerminalStreamEvent> {
        let (sender, _) = broadcast::channel(2048);
        sender
    }

    pub(crate) async fn ensure_terminal_host(&self, session_id: &str) -> Arc<LiveSessionHandle> {
        if let Some(handle) = self.live_sessions.read().await.get(session_id).cloned() {
            return handle;
        }

        let mut live_sessions = self.live_sessions.write().await;
        if let Some(handle) = live_sessions.get(session_id).cloned() {
            return handle;
        }

        let handle = Arc::new(LiveSessionHandle {
            input_tx: RwLock::new(None),
            terminal_tx: self.new_terminal_stream(),
            terminal_store: Arc::new(std::sync::Mutex::new(types::TerminalStateStore::new())),
            kill_tx: Mutex::new(None),
        });
        live_sessions.insert(session_id.to_string(), handle.clone());
        handle
    }

    pub(crate) async fn attach_terminal_runtime(
        &self,
        session_id: &str,
        input_tx: mpsc::Sender<ExecutorInput>,
        kill_tx: oneshot::Sender<()>,
    ) -> Arc<LiveSessionHandle> {
        let handle = self.ensure_terminal_host(session_id).await;
        *handle.input_tx.write().await = Some(input_tx);
        *handle.kill_tx.lock().await = Some(kill_tx);
        handle
    }

    pub(crate) async fn detach_terminal_runtime(&self, session_id: &str) {
        let Some(handle) = self.live_sessions.read().await.get(session_id).cloned() else {
            return;
        };
        *handle.input_tx.write().await = None;
        let _ = handle.kill_tx.lock().await.take();
    }

    pub(crate) async fn subscribe_terminal_stream(
        &self,
        session_id: &str,
    ) -> Option<broadcast::Receiver<TerminalStreamEvent>> {
        self.live_sessions
            .read()
            .await
            .get(session_id)
            .map(|handle| handle.terminal_tx.subscribe())
    }

    pub(crate) async fn terminal_runtime_attached(&self, session_id: &str) -> bool {
        let Some(handle) = self.live_sessions.read().await.get(session_id).cloned() else {
            return false;
        };
        let attached = handle.input_tx.read().await.is_some();
        attached
    }

    pub(crate) async fn emit_terminal_stream_event(
        &self,
        session_id: &str,
        event: TerminalStreamEvent,
    ) {
        if let Some(handle) = self.live_sessions.read().await.get(session_id).cloned() {
            let _ = handle.terminal_tx.send(event);
        }
    }

    pub(crate) async fn emit_terminal_text(&self, session_id: &str, text: impl AsRef<str>) {
        let bytes = text.as_ref().as_bytes().to_vec();
        if bytes.is_empty() {
            return;
        }

        let handle = self.ensure_terminal_host(session_id).await;
        if let Ok(mut store) = handle.terminal_store.lock() {
            store.process(&bytes);
        }
        let _ = handle.terminal_tx.send(TerminalStreamEvent::Output(bytes));
    }

    pub(crate) async fn process_terminal_bytes(&self, session_id: &str, bytes: &[u8]) {
        if let Some(handle) = self.live_sessions.read().await.get(session_id).cloned() {
            if let Ok(mut store) = handle.terminal_store.lock() {
                store.process(bytes);
            }
        }
    }

    pub(crate) async fn resize_terminal_store(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(handle) = self.live_sessions.read().await.get(session_id).cloned() {
            if let Ok(mut store) = handle.terminal_store.lock() {
                store.resize(cols, rows);
            }
        }
    }

    pub(crate) async fn current_terminal_snapshot(&self, session_id: &str) -> Option<Vec<u8>> {
        self.live_sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .and_then(|handle| {
                handle
                    .terminal_store
                    .lock()
                    .ok()
                    .map(|store| store.snapshot())
            })
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
