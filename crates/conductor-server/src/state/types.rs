use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::{mpsc, Mutex};

pub const DEFAULT_SESSION_HISTORY_LIMIT: usize = 2000;
pub const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEntry {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub text: String,
    pub created_at: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrInfo {
    pub number: i64,
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub is_draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub activity: Option<String>,
    pub branch: Option<String>,
    pub issue_id: Option<String>,
    pub workspace_path: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    pub summary: Option<String>,
    pub agent: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub prompt: String,
    pub pid: Option<u32>,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
    #[serde(default)]
    pub pr: Option<SessionPrInfo>,
    #[serde(default)]
    pub conversation: Vec<ConversationEntry>,
    #[serde(default)]
    pub output: String,
}

impl SessionRecord {
    pub fn new(
        id: String,
        project_id: String,
        branch: Option<String>,
        issue_id: Option<String>,
        workspace_path: Option<String>,
        agent: String,
        model: Option<String>,
        reasoning_effort: Option<String>,
        prompt: String,
        pid: Option<u32>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        let mut metadata = HashMap::new();
        metadata.insert("agent".to_string(), agent.clone());
        if let Some(model_value) = &model {
            metadata.insert("model".to_string(), model_value.clone());
        }
        if let Some(reasoning) = &reasoning_effort {
            metadata.insert("reasoningEffort".to_string(), reasoning.clone());
        }
        if let Some(workspace) = &workspace_path {
            metadata.insert("worktree".to_string(), workspace.clone());
        }

        Self {
            id,
            project_id,
            status: "working".to_string(),
            activity: Some("active".to_string()),
            branch,
            issue_id,
            workspace_path,
            created_at: now.clone(),
            last_activity_at: now,
            summary: None,
            agent,
            model,
            reasoning_effort,
            prompt,
            pid,
            metadata,
            pr: None,
            conversation: Vec::new(),
            output: String::new(),
        }
    }
}

pub struct LiveSessionHandle {
    pub input_tx: mpsc::Sender<String>,
    pub kill_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

pub struct SpawnRequest {
    pub project_id: String,
    pub prompt: String,
    pub issue_id: Option<String>,
    pub agent: Option<String>,
    pub use_worktree: Option<bool>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub attachments: Vec<String>,
    pub source: String,
}
