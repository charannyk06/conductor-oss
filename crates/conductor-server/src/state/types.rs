use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use conductor_executors::executor::ExecutorInput;
use tokio::sync::{mpsc, Mutex};

pub const DEFAULT_SESSION_HISTORY_LIMIT: usize = 2000;
pub const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 512 * 1024;

/// Well-known session statuses. Serializes to/from lowercase strings for JSON compatibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Working,
    Done,
    Errored,
    Killed,
    NeedsInput,
    Stuck,
    Archived,
    Merged,
    Terminated,
    Cleanup,
    /// Catch-all for unknown/legacy status strings.
    #[serde(untagged)]
    Other(String),
}

impl SessionStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Working => "working",
            Self::Done => "done",
            Self::Errored => "errored",
            Self::Killed => "killed",
            Self::NeedsInput => "needs_input",
            Self::Stuck => "stuck",
            Self::Archived => "archived",
            Self::Merged => "merged",
            Self::Terminated => "terminated",
            Self::Cleanup => "cleanup",
            Self::Other(value) => value.as_str(),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Done | Self::Errored | Self::Killed | Self::Archived | Self::Merged | Self::Terminated | Self::Cleanup
        )
    }
}

impl fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<&str> for SessionStatus {
    fn from(value: &str) -> Self {
        match value {
            "working" => Self::Working,
            "done" => Self::Done,
            "errored" => Self::Errored,
            "killed" => Self::Killed,
            "needs_input" => Self::NeedsInput,
            "stuck" => Self::Stuck,
            "archived" => Self::Archived,
            "merged" => Self::Merged,
            "terminated" => Self::Terminated,
            "cleanup" => Self::Cleanup,
            other => Self::Other(other.to_string()),
        }
    }
}

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
    #[allow(clippy::too_many_arguments)]
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
        Self::builder(id, project_id, agent, prompt)
            .branch(branch)
            .issue_id(issue_id)
            .workspace_path(workspace_path)
            .model(model)
            .reasoning_effort(reasoning_effort)
            .pid(pid)
            .build()
    }

    pub fn builder(id: String, project_id: String, agent: String, prompt: String) -> SessionRecordBuilder {
        SessionRecordBuilder {
            id,
            project_id,
            agent,
            prompt,
            branch: None,
            issue_id: None,
            workspace_path: None,
            model: None,
            reasoning_effort: None,
            pid: None,
        }
    }
}

pub struct SessionRecordBuilder {
    id: String,
    project_id: String,
    agent: String,
    prompt: String,
    branch: Option<String>,
    issue_id: Option<String>,
    workspace_path: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    pid: Option<u32>,
}

impl SessionRecordBuilder {
    pub fn branch(mut self, value: Option<String>) -> Self { self.branch = value; self }
    pub fn issue_id(mut self, value: Option<String>) -> Self { self.issue_id = value; self }
    pub fn workspace_path(mut self, value: Option<String>) -> Self { self.workspace_path = value; self }
    pub fn model(mut self, value: Option<String>) -> Self { self.model = value; self }
    pub fn reasoning_effort(mut self, value: Option<String>) -> Self { self.reasoning_effort = value; self }
    pub fn pid(mut self, value: Option<u32>) -> Self { self.pid = value; self }

    pub fn build(self) -> SessionRecord {
        let now = chrono::Utc::now().to_rfc3339();
        let mut metadata = HashMap::new();
        metadata.insert("agent".to_string(), self.agent.clone());
        if let Some(model_value) = &self.model {
            metadata.insert("model".to_string(), model_value.clone());
        }
        if let Some(reasoning) = &self.reasoning_effort {
            metadata.insert("reasoningEffort".to_string(), reasoning.clone());
        }
        if let Some(workspace) = &self.workspace_path {
            metadata.insert("worktree".to_string(), workspace.clone());
        }

        SessionRecord {
            id: self.id,
            project_id: self.project_id,
            status: "working".to_string(),
            activity: Some("active".to_string()),
            branch: self.branch,
            issue_id: self.issue_id,
            workspace_path: self.workspace_path,
            created_at: now.clone(),
            last_activity_at: now,
            summary: None,
            agent: self.agent,
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            prompt: self.prompt,
            pid: self.pid,
            metadata,
            pr: None,
            conversation: Vec::new(),
            output: String::new(),
        }
    }
}

pub struct LiveSessionHandle {
    pub input_tx: mpsc::Sender<ExecutorInput>,
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
