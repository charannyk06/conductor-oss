use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use uuid::Uuid;

/// Unique identifier for any entity in the system.
pub type EntityId = Uuid;

/// Standard timestamp type.
pub type Timestamp = DateTime<Utc>;

/// Priority levels for tasks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Critical,
    High,
    #[default]
    Normal,
    Low,
}

/// Agent type identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    Gemini,
    Amp,
    CursorCli,
    OpenCode,
    Droid,
    QwenCode,
    Ccr,
    GithubCopilot,
    Custom(String),
}

impl AgentKind {
    /// Parse a string into an AgentKind, falling back to Custom for unrecognized values.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "claude" | "claude-code" => Self::ClaudeCode,
            "codex" => Self::Codex,
            "gemini" => Self::Gemini,
            "amp" => Self::Amp,
            "cursor" | "cursor-cli" => Self::CursorCli,
            "opencode" => Self::OpenCode,
            "droid" => Self::Droid,
            "qwen" | "qwen-code" => Self::QwenCode,
            "ccr" => Self::Ccr,
            "copilot" | "github-copilot" => Self::GithubCopilot,
            other => Self::Custom(other.to_string()),
        }
    }
}

impl std::fmt::Display for AgentKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClaudeCode => write!(f, "claude-code"),
            Self::Codex => write!(f, "codex"),
            Self::Gemini => write!(f, "gemini"),
            Self::Amp => write!(f, "amp"),
            Self::CursorCli => write!(f, "cursor-cli"),
            Self::OpenCode => write!(f, "opencode"),
            Self::Droid => write!(f, "droid"),
            Self::QwenCode => write!(f, "qwen-code"),
            Self::Ccr => write!(f, "ccr"),
            Self::GithubCopilot => write!(f, "github-copilot"),
            Self::Custom(s) => write!(f, "{s}"),
        }
    }
}

/// Health grade for sessions and system components.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HealthGrade {
    #[serde(rename = "A")]
    Healthy,
    #[serde(rename = "B")]
    Degraded,
    #[serde(rename = "C")]
    Warning,
    #[serde(rename = "F")]
    Critical,
}

/// Process exit information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: Timestamp,
}

pub const DEFAULT_SESSION_HISTORY_LIMIT: usize = 2000;
pub const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 512 * 1024;

/// Well-known session statuses. Serializes to/from lowercase strings for JSON compatibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Queued,
    Spawning,
    Working,
    Idle,
    NeedsInput,
    Stuck,
    Errored,
    Killed,
    Completed,
    Done,
    Restored,
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
            Self::Queued => "queued",
            Self::Spawning => "spawning",
            Self::Working => "working",
            Self::Idle => "idle",
            Self::NeedsInput => "needs_input",
            Self::Stuck => "stuck",
            Self::Errored => "errored",
            Self::Killed => "killed",
            Self::Completed => "completed",
            Self::Done => "done",
            Self::Restored => "restored",
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
            Self::Done
                | Self::Completed
                | Self::Errored
                | Self::Killed
                | Self::Archived
                | Self::Merged
                | Self::Terminated
                | Self::Cleanup
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
            "queued" => Self::Queued,
            "spawning" => Self::Spawning,
            "working" | "running" => Self::Working,
            "idle" => Self::Idle,
            "needs_input" => Self::NeedsInput,
            "stuck" => Self::Stuck,
            "errored" => Self::Errored,
            "killed" => Self::Killed,
            "completed" => Self::Completed,
            "done" => Self::Done,
            "restored" => Self::Restored,
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
    #[serde(default)]
    pub bridge_id: Option<String>,
    pub status: SessionStatus,
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

    pub fn builder(
        id: String,
        project_id: String,
        agent: String,
        prompt: String,
    ) -> SessionRecordBuilder {
        SessionRecordBuilder {
            id,
            project_id,
            agent,
            prompt,
            bridge_id: None,
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
    bridge_id: Option<String>,
    branch: Option<String>,
    issue_id: Option<String>,
    workspace_path: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    pid: Option<u32>,
}

impl SessionRecordBuilder {
    pub fn bridge_id(mut self, value: Option<String>) -> Self {
        self.bridge_id = value;
        self
    }
    pub fn branch(mut self, value: Option<String>) -> Self {
        self.branch = value;
        self
    }
    pub fn issue_id(mut self, value: Option<String>) -> Self {
        self.issue_id = value;
        self
    }
    pub fn workspace_path(mut self, value: Option<String>) -> Self {
        self.workspace_path = value;
        self
    }
    pub fn model(mut self, value: Option<String>) -> Self {
        self.model = value;
        self
    }
    pub fn reasoning_effort(mut self, value: Option<String>) -> Self {
        self.reasoning_effort = value;
        self
    }
    pub fn pid(mut self, value: Option<u32>) -> Self {
        self.pid = value;
        self
    }

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
            bridge_id: self.bridge_id,
            status: SessionStatus::Working,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub project_id: String,
    #[serde(default)]
    pub bridge_id: Option<String>,
    pub prompt: String,
    pub issue_id: Option<String>,
    pub agent: Option<String>,
    pub use_worktree: Option<bool>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub task_id: Option<String>,
    pub task_ref: Option<String>,
    pub attempt_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub retry_of_session_id: Option<String>,
    pub profile: Option<String>,
    pub session_kind: Option<String>,
    pub brief_path: Option<String>,
    pub attachments: Vec<String>,
    pub source: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_kind_display() {
        assert_eq!(AgentKind::ClaudeCode.to_string(), "claude-code");
        assert_eq!(AgentKind::QwenCode.to_string(), "qwen-code");
        assert_eq!(AgentKind::GithubCopilot.to_string(), "github-copilot");
        assert_eq!(
            AgentKind::Custom("my-agent".to_string()).to_string(),
            "my-agent"
        );
    }

    #[test]
    fn test_agent_kind_serialization() {
        let kind = AgentKind::ClaudeCode;
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, "\"claude-code\"");
        let parsed: AgentKind = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, AgentKind::ClaudeCode);
    }

    #[test]
    fn test_agent_kind_parse() {
        assert_eq!(AgentKind::parse("claude-code"), AgentKind::ClaudeCode);
        assert_eq!(AgentKind::parse("claude"), AgentKind::ClaudeCode);
        assert_eq!(AgentKind::parse("codex"), AgentKind::Codex);
        assert_eq!(AgentKind::parse("qwen-code"), AgentKind::QwenCode);
        assert_eq!(AgentKind::parse("qwen"), AgentKind::QwenCode);
        assert_eq!(AgentKind::parse("copilot"), AgentKind::GithubCopilot);
        assert_eq!(
            AgentKind::parse("unknown"),
            AgentKind::Custom("unknown".to_string())
        );
    }

    #[test]
    fn test_priority_default() {
        assert_eq!(Priority::default(), Priority::Normal);
    }

    #[test]
    fn test_health_grade_serialization() {
        let grade = HealthGrade::Healthy;
        let json = serde_json::to_string(&grade).unwrap();
        assert_eq!(json, "\"A\"");
        let parsed: HealthGrade = serde_json::from_str("\"B\"").unwrap();
        assert_eq!(parsed, HealthGrade::Degraded);
    }
}
