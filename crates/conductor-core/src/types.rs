use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_kind_display() {
        assert_eq!(AgentKind::ClaudeCode.to_string(), "claude-code");
        assert_eq!(AgentKind::QwenCode.to_string(), "qwen-code");
        assert_eq!(AgentKind::GithubCopilot.to_string(), "github-copilot");
        assert_eq!(AgentKind::Custom("my-agent".to_string()).to_string(), "my-agent");
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
        assert_eq!(AgentKind::parse("unknown"), AgentKind::Custom("unknown".to_string()));
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
