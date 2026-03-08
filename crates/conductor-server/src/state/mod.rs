mod helpers;
mod session_manager;
mod session_store;
pub mod types;
mod workspace;

pub use helpers::{
    build_normalized_chat_feed, resolve_board_file, session_to_dashboard_value, trim_lines_tail,
};
pub use types::{
    ConversationEntry, LiveSessionHandle, SessionPrInfo, SessionRecord, SessionStatus, SpawnRequest,
};
pub use workspace::{expand_path, resolve_workspace_path};

use anyhow::Result;
use chrono::{DateTime, Utc};
use conductor_core::config::{ConductorConfig, DashboardAccessConfig, PreferencesConfig};
use conductor_core::support::{startup_config_sync, sync_workspace_support_files};
use conductor_core::types::AgentKind;
use conductor_db::Database;
use conductor_executors::executor::Executor;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

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
    pub started_at: DateTime<Utc>,
    /// Serializes board-triggered spawns to prevent TOCTOU races in limit checks.
    pub spawn_guard: Mutex<()>,
}

impl AppState {
    pub async fn new(config_path: PathBuf, config: ConductorConfig, db: Database) -> Arc<Self> {
        let workspace_path = resolve_workspace_path(&config_path, &config.workspace);
        let (event_snapshots, _) = broadcast::channel(256);
        let (output_updates, _) = broadcast::channel(512);
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
            started_at: Utc::now(),
            spawn_guard: Mutex::new(()),
        });
        state.ensure_session_store();
        state.load_sessions_from_disk().await;
        state.start_session_evictor();
        state
    }

    pub async fn discover_executors(&self) {
        let discovered = conductor_executors::discover_executors().await;
        let mut executors = self.executors.write().await;
        *executors = discovered;
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
        let mut list: Vec<&SessionRecord> = sessions
            .values()
            .filter(|session| session.status != "archived")
            .collect();
        list.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        list.into_iter().map(session_to_dashboard_value).collect()
    }

    pub async fn snapshot_event_json(&self) -> String {
        serde_json::to_string(&json!({
            "type": "snapshot",
            "sessions": self.snapshot_sessions().await,
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

    /// Spawn a background task that evicts terminal sessions older than 1 hour from memory.
    fn start_session_evictor(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                interval.tick().await;
                let now = Utc::now();
                let mut sessions = state.sessions.write().await;
                let before = sessions.len();
                sessions.retain(|_id, session| {
                    let status = SessionStatus::from(session.status.as_str());
                    if !status.is_terminal() {
                        return true;
                    }
                    match DateTime::parse_from_rfc3339(&session.last_activity_at) {
                        Ok(last_activity) => {
                            let age = now.signed_duration_since(last_activity.with_timezone(&Utc));
                            age.num_hours() < 1
                        }
                        Err(_) => true, // keep sessions with unparseable timestamps
                    }
                });
                let evicted = before - sessions.len();
                if evicted > 0 {
                    tracing::info!(evicted, "Evicted terminal sessions from memory");
                }
            }
        });
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
