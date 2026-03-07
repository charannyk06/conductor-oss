mod helpers;
mod session_manager;
mod session_store;
pub mod types;
mod workspace;

pub use helpers::{build_normalized_chat_feed, resolve_board_file, session_to_dashboard_value, trim_lines_tail};
pub use types::{
    ConversationEntry, LiveSessionHandle, SessionPrInfo, SessionRecord, SpawnRequest,
};
pub use workspace::{expand_path, resolve_workspace_path};

use anyhow::Result;
use chrono::{DateTime, Utc};
use conductor_core::config::{ConductorConfig, DashboardAccessConfig, PreferencesConfig};
use conductor_core::types::AgentKind;
use conductor_db::Database;
use conductor_executors::executor::Executor;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

/// Shared application state for the HTTP server.
pub struct AppState {
    pub config_path: PathBuf,
    pub workspace_path: PathBuf,
    pub config: RwLock<ConductorConfig>,
    #[allow(dead_code)]
    pub db: Database,
    pub executors: RwLock<HashMap<AgentKind, Arc<dyn Executor>>>,
    pub sessions: RwLock<HashMap<String, SessionRecord>>,
    pub live_sessions: RwLock<HashMap<String, Arc<LiveSessionHandle>>>,
    pub event_snapshots: broadcast::Sender<String>,
    pub output_updates: broadcast::Sender<(String, String)>,
    pub started_at: DateTime<Utc>,
}

impl AppState {
    pub fn new(config_path: PathBuf, config: ConductorConfig, db: Database) -> Arc<Self> {
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
        });
        state.ensure_session_store();
        state.load_sessions_from_disk();
        state
    }

    pub async fn discover_executors(&self) {
        let discovered = conductor_executors::discover_executors().await;
        let mut executors = self.executors.write().await;
        *executors = discovered;
    }

    pub async fn save_config(&self) -> Result<()> {
        let config = self.config.read().await.clone();
        config.save(&self.config_path)
    }

    pub async fn update_preferences(&self, preferences: PreferencesConfig) -> Result<PreferencesConfig> {
        {
            let mut config = self.config.write().await;
            config.preferences = preferences.clone();
        }
        self.save_config().await?;
        Ok(preferences)
    }

    pub async fn update_access(&self, access: DashboardAccessConfig) -> Result<DashboardAccessConfig> {
        {
            let mut config = self.config.write().await;
            config.access = access.clone();
        }
        self.save_config().await?;
        Ok(access)
    }

    pub async fn snapshot_sessions(&self) -> Vec<Value> {
        let sessions = self.sessions.read().await;
        let mut list: Vec<&SessionRecord> = sessions.values().collect();
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
