use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Root configuration for the Rust-first Conductor backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConductorConfig {
    #[serde(skip)]
    pub config_path: Option<PathBuf>,
    #[serde(default)]
    pub workspace: PathBuf,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub dashboard_url: Option<String>,
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectConfig>,
    #[serde(default)]
    pub preferences: PreferencesConfig,
    #[serde(default)]
    pub access: DashboardAccessConfig,
}

impl Default for ConductorConfig {
    fn default() -> Self {
        Self {
            config_path: None,
            workspace: PathBuf::new(),
            server: ServerConfig::default(),
            port: default_port(),
            dashboard_url: None,
            projects: BTreeMap::new(),
            preferences: PreferencesConfig::default(),
            access: DashboardAccessConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default)]
    pub permissions: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    pub path: String,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    #[serde(default)]
    pub default_working_directory: Option<String>,
    #[serde(default)]
    pub board_dir: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub agent_config: AgentConfig,
    #[serde(default)]
    pub setup_script: Vec<String>,
    #[serde(default)]
    pub run_setup_in_parallel: bool,
    #[serde(default)]
    pub dev_server_script: Vec<String>,
    #[serde(default)]
    pub cleanup_script: Vec<String>,
    #[serde(default)]
    pub archive_script: Vec<String>,
    #[serde(default)]
    pub copy_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAccessPreferences {
    #[serde(default = "default_claude_access")]
    pub claude_code: String,
    #[serde(default = "default_codex_access")]
    pub codex: String,
    #[serde(default = "default_gemini_access")]
    pub gemini: String,
    #[serde(default = "default_qwen_access")]
    pub qwen_code: String,
}

impl Default for ModelAccessPreferences {
    fn default() -> Self {
        Self {
            claude_code: default_claude_access(),
            codex: default_codex_access(),
            gemini: default_gemini_access(),
            qwen_code: default_qwen_access(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    #[serde(default = "default_true")]
    pub sound_enabled: bool,
    #[serde(default = "default_sound_file")]
    pub sound_file: Option<String>,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_file: default_sound_file(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesConfig {
    #[serde(default)]
    pub onboarding_acknowledged: bool,
    #[serde(default = "default_agent_name")]
    pub coding_agent: String,
    #[serde(default = "default_ide")]
    pub ide: String,
    #[serde(default)]
    pub remote_ssh_host: String,
    #[serde(default)]
    pub remote_ssh_user: String,
    #[serde(default = "default_markdown_editor")]
    pub markdown_editor: String,
    #[serde(default)]
    pub model_access: ModelAccessPreferences,
    #[serde(default)]
    pub notifications: NotificationPreferences,
}

impl Default for PreferencesConfig {
    fn default() -> Self {
        Self {
            onboarding_acknowledged: false,
            coding_agent: default_agent_name(),
            ide: default_ide(),
            remote_ssh_host: String::new(),
            remote_ssh_user: String::new(),
            markdown_editor: default_markdown_editor(),
            model_access: ModelAccessPreferences::default(),
            notifications: NotificationPreferences::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedHeaderAccessConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_trusted_provider")]
    pub provider: String,
    #[serde(default = "default_email_header")]
    pub email_header: String,
    #[serde(default = "default_jwt_header")]
    pub jwt_header: String,
    #[serde(default)]
    pub team_domain: String,
    #[serde(default)]
    pub audience: String,
}

impl Default for TrustedHeaderAccessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: default_trusted_provider(),
            email_header: default_email_header(),
            jwt_header: default_jwt_header(),
            team_domain: String::new(),
            audience: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRoleBindings {
    #[serde(default)]
    pub viewers: Vec<String>,
    #[serde(default)]
    pub operators: Vec<String>,
    #[serde(default)]
    pub admins: Vec<String>,
    #[serde(default)]
    pub viewer_domains: Vec<String>,
    #[serde(default)]
    pub operator_domains: Vec<String>,
    #[serde(default)]
    pub admin_domains: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAccessConfig {
    #[serde(default)]
    pub require_auth: bool,
    #[serde(default = "default_role")]
    pub default_role: String,
    #[serde(default)]
    pub trusted_headers: TrustedHeaderAccessConfig,
    #[serde(default)]
    pub roles: DashboardRoleBindings,
}

impl Default for DashboardAccessConfig {
    fn default() -> Self {
        Self {
            require_auth: false,
            default_role: default_role(),
            trusted_headers: TrustedHeaderAccessConfig::default(),
            roles: DashboardRoleBindings::default(),
        }
    }
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    4747
}

fn default_true() -> bool {
    true
}

fn default_role() -> String {
    "admin".to_string()
}

fn default_branch() -> String {
    "main".to_string()
}

fn default_agent_name() -> String {
    "claude-code".to_string()
}

fn default_ide() -> String {
    "vscode".to_string()
}

fn default_markdown_editor() -> String {
    "obsidian".to_string()
}

fn default_sound_file() -> Option<String> {
    Some("abstract-sound-4".to_string())
}

fn default_claude_access() -> String {
    "pro".to_string()
}

fn default_codex_access() -> String {
    "chatgpt".to_string()
}

fn default_gemini_access() -> String {
    "oauth".to_string()
}

fn default_qwen_access() -> String {
    "oauth".to_string()
}

fn default_trusted_provider() -> String {
    "cloudflare-access".to_string()
}

fn default_email_header() -> String {
    "Cf-Access-Authenticated-User-Email".to_string()
}

fn default_jwt_header() -> String {
    "Cf-Access-Jwt-Assertion".to_string()
}

impl ConductorConfig {
    pub fn default_for_workspace(workspace: &Path) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            config_path: None,
            server: ServerConfig::default(),
            port: default_port(),
            dashboard_url: None,
            projects: BTreeMap::new(),
            preferences: PreferencesConfig::default(),
            access: DashboardAccessConfig::default(),
        }
    }

    pub fn effective_port(&self) -> u16 {
        if self.port != 0 {
            self.port
        } else {
            self.server.port
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let mut config: Self = serde_yaml::from_str(&content)?;
        if config.workspace.as_os_str().is_empty() {
            config.workspace = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf();
        }
        if config.server.port == 0 {
            config.server.port = config.port.max(default_port());
        }
        if config.port == 0 {
            config.port = config.server.port.max(default_port());
        }
        if config.server.host.trim().is_empty() {
            config.server.host = default_host();
        }
        config.config_path = Some(path.to_path_buf());
        Ok(config)
    }

    pub fn load_default(workspace: &Path) -> Result<Self> {
        let workspace_config = workspace.join("conductor.yaml");
        if workspace_config.exists() {
            return Self::load(&workspace_config);
        }
        anyhow::bail!("No conductor.yaml found. Run `conductor init` to create one.")
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut clone = self.clone();
        clone.config_path = None;
        if clone.workspace.as_os_str().is_empty() {
            clone.workspace = path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf();
        }
        clone.server.port = clone.effective_port();
        clone.port = clone.server.port;
        let content = serde_yaml::to_string(&clone)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config_values() {
        let config = ConductorConfig::default();
        assert_eq!(config.port, 4747);
        assert_eq!(config.server.host, "127.0.0.1");
        assert_eq!(config.preferences.coding_agent, "claude-code");
    }

    #[test]
    fn test_effective_port_uses_port_field() {
        let mut config = ConductorConfig::default();
        config.port = 8080;
        config.server.port = 9090;
        assert_eq!(config.effective_port(), 8080);
    }

    #[test]
    fn test_effective_port_falls_back_to_server_port() {
        let mut config = ConductorConfig::default();
        config.port = 0;
        config.server.port = 9090;
        assert_eq!(config.effective_port(), 9090);
    }

    #[test]
    fn test_default_for_workspace() {
        let workspace = Path::new("/tmp/test-workspace");
        let config = ConductorConfig::default_for_workspace(workspace);
        assert_eq!(config.workspace, workspace);
        assert!(config.projects.is_empty());
    }

    #[test]
    fn test_preferences_defaults() {
        let prefs = PreferencesConfig::default();
        assert_eq!(prefs.coding_agent, "claude-code");
        assert_eq!(prefs.ide, "vscode");
        assert_eq!(prefs.markdown_editor, "obsidian");
        assert!(!prefs.onboarding_acknowledged);
    }
}
