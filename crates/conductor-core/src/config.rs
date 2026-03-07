use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::types::AgentKind;

/// Root configuration for Conductor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConductorConfig {
    /// Workspace root directory.
    pub workspace: PathBuf,

    /// Dashboard server settings.
    #[serde(default)]
    pub server: ServerConfig,

    /// Registered projects.
    #[serde(default)]
    pub projects: Vec<ProjectConfig>,

    /// Default executor (agent) to use.
    pub default_executor: Option<AgentKind>,

    /// Executor-specific configuration.
    #[serde(default)]
    pub executors: HashMap<String, ExecutorConfig>,

    /// Webhook configuration for notifications.
    #[serde(default)]
    pub webhooks: Vec<WebhookConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Host to bind to.
    #[serde(default = "default_host")]
    pub host: String,

    /// Port for the dashboard/API.
    #[serde(default = "default_port")]
    pub port: u16,

    /// Enable authentication.
    #[serde(default)]
    pub auth: Option<AuthConfig>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            auth: None,
        }
    }
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    4747
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub username: String,
    pub password_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    /// Unique project ID (derived from name).
    pub id: String,

    /// Human-readable project name.
    pub name: String,

    /// Path to the project repository.
    pub path: PathBuf,

    /// Path to the Kanban board file (markdown).
    pub board: Option<PathBuf>,

    /// Override executor for this project.
    pub executor: Option<AgentKind>,

    /// Maximum concurrent sessions for this project.
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize,

    /// Setup script to run before agent tasks.
    pub setup_script: Option<String>,

    /// Cleanup script to run after agent tasks.
    pub cleanup_script: Option<String>,
}

fn default_max_sessions() -> usize {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorConfig {
    /// Path to the CLI binary.
    pub binary: Option<PathBuf>,

    /// Default model for this executor.
    pub model: Option<String>,

    /// Skip permission prompts.
    #[serde(default)]
    pub skip_permissions: bool,

    /// Additional CLI arguments.
    #[serde(default)]
    pub extra_args: Vec<String>,

    /// Environment variables to set.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookConfig {
    /// Webhook URL.
    pub url: String,

    /// Events to subscribe to.
    #[serde(default)]
    pub events: Vec<String>,

    /// HMAC secret for signing.
    pub secret: Option<String>,
}

impl ConductorConfig {
    /// Load configuration from a YAML file.
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Self = serde_yaml::from_str(&content)?;
        Ok(config)
    }

    /// Load from default location (~/.conductor/config.yaml or workspace/conductor.yaml).
    pub fn load_default(workspace: &Path) -> Result<Self> {
        let workspace_config = workspace.join("conductor.yaml");
        if workspace_config.exists() {
            return Self::load(&workspace_config);
        }

        let home_config = dirs_path().join("config.yaml");
        if home_config.exists() {
            return Self::load(&home_config);
        }

        anyhow::bail!("No conductor.yaml found. Run `conductor init` to create one.")
    }

    /// Save configuration to a YAML file.
    pub fn save(&self, path: &Path) -> Result<()> {
        let content = serde_yaml::to_string(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}

fn dirs_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".conductor")
}
