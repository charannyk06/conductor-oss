use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique identifier for any entity in the system.
pub type EntityId = Uuid;

/// Standard timestamp type.
pub type Timestamp = DateTime<Utc>;

/// Priority levels for tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Critical,
    High,
    Normal,
    Low,
}

impl Default for Priority {
    fn default() -> Self {
        Self::Normal
    }
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
