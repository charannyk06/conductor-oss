use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const TTYD_RUNTIME: &str = "ttyd";
pub const LEGACY_DIRECT_RUNTIME: &str = "direct";
pub const LEGACY_TMUX_RUNTIME: &str = "tmux";

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<WebhookConfig>,
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
            webhook: None,
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
    /// Extra CORS origins beyond the default localhost entries.
    #[serde(default)]
    pub cors_origins: Vec<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            cors_origins: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_webhook_port")]
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Default for WebhookConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_webhook_port(),
            secret: None,
            url: None,
        }
    }
}

impl WebhookConfig {
    fn normalize(&mut self) {
        trim_to_option(&mut self.secret);
        trim_to_option(&mut self.url);
        if self.port == 0 {
            self.port = default_webhook_port();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Maximum session duration in seconds. None means no timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevServerCompatConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub https: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubProjectConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_login: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_field_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_field_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub path: String,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scm: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_project: Option<GitHubProjectConfig>,
    #[serde(default)]
    pub agent_config: AgentConfig,
    #[serde(default)]
    pub setup_script: Vec<String>,
    #[serde(default)]
    pub run_setup_in_parallel: bool,
    #[serde(default)]
    pub dev_server_script: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_server_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_server_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_server_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_server_path: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub dev_server_https: bool,
    #[serde(default, skip_serializing)]
    pub dev_server: Option<DevServerCompatConfig>,
    #[serde(default)]
    pub cleanup_script: Vec<String>,
    #[serde(default)]
    pub archive_script: Vec<String>,
    #[serde(default)]
    pub copy_files: Vec<String>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            name: None,
            repo: None,
            path: String::new(),
            default_branch: default_branch(),
            session_prefix: None,
            default_working_directory: None,
            board_dir: None,
            runtime: None,
            agent: None,
            workspace: None,
            scm: None,
            icon_url: None,
            description: None,
            github_project: None,
            agent_config: AgentConfig::default(),
            setup_script: Vec::new(),
            run_setup_in_parallel: false,
            dev_server_script: Vec::new(),
            dev_server_cwd: None,
            dev_server_url: None,
            dev_server_port: None,
            dev_server_host: None,
            dev_server_path: None,
            dev_server_https: false,
            dev_server: None,
            cleanup_script: Vec::new(),
            archive_script: Vec::new(),
            copy_files: Vec::new(),
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn trim_to_option(value: &mut Option<String>) {
    *value = value
        .take()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty());
}

fn normalized_host(value: Option<&str>) -> String {
    let host = value
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("127.0.0.1");
    if host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    }
}

fn normalized_path(value: Option<&str>) -> String {
    let path = value
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("");
    if path.is_empty() {
        String::new()
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

impl ProjectConfig {
    pub fn normalize_runtime(&mut self) {
        trim_to_option(&mut self.runtime);
        self.runtime = normalized_runtime_label(self.runtime.as_deref()).into();
    }

    pub fn normalize_dev_server(&mut self) {
        self.dev_server_script = self
            .dev_server_script
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        trim_to_option(&mut self.dev_server_cwd);
        trim_to_option(&mut self.dev_server_url);
        trim_to_option(&mut self.dev_server_host);
        trim_to_option(&mut self.dev_server_path);

        if let Some(dev_server) = self.dev_server.take() {
            if self.dev_server_script.is_empty() {
                if let Some(command) = dev_server.command {
                    let command = command.trim();
                    if !command.is_empty() {
                        self.dev_server_script.push(command.to_string());
                    }
                }
            }
            if self.dev_server_cwd.is_none() {
                self.dev_server_cwd = dev_server.cwd.and_then(|value| {
                    let trimmed = value.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                });
            }
            if self.dev_server_url.is_none() {
                self.dev_server_url = dev_server.url.and_then(|value| {
                    let trimmed = value.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                });
            }
            if self.dev_server_port.is_none() {
                self.dev_server_port = dev_server.port.filter(|port| *port > 0);
            }
            if self.dev_server_host.is_none() {
                self.dev_server_host = dev_server.host.and_then(|value| {
                    let trimmed = value.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                });
            }
            if self.dev_server_path.is_none() {
                self.dev_server_path = dev_server.path.and_then(|value| {
                    let trimmed = value.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                });
            }
            if !self.dev_server_https {
                self.dev_server_https = dev_server.https.unwrap_or(false);
            }
        }
    }

    pub fn resolved_dev_server_url(&self) -> Option<String> {
        if let Some(url) = self
            .dev_server_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(url.to_string());
        }

        let port = self.dev_server_port?;
        let scheme = if self.dev_server_https {
            "https"
        } else {
            "http"
        };
        Some(format!(
            "{scheme}://{}:{port}{}",
            normalized_host(self.dev_server_host.as_deref()),
            normalized_path(self.dev_server_path.as_deref())
        ))
    }
}

pub fn normalized_runtime_label(value: Option<&str>) -> String {
    let runtime = value
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or(TTYD_RUNTIME);

    if runtime.eq_ignore_ascii_case(LEGACY_DIRECT_RUNTIME)
        || runtime.eq_ignore_ascii_case(LEGACY_TMUX_RUNTIME)
        || runtime.eq_ignore_ascii_case(TTYD_RUNTIME)
    {
        TTYD_RUNTIME.to_string()
    } else {
        runtime.to_string()
    }
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
    #[serde(default = "default_markdown_editor")]
    pub markdown_editor: String,
    #[serde(default)]
    pub markdown_editor_path: String,
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
            markdown_editor: default_markdown_editor(),
            markdown_editor_path: String::new(),
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

fn default_webhook_port() -> u16 {
    4748
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
            webhook: None,
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
        if let Some(webhook) = config.webhook.as_mut() {
            webhook.normalize();
        }
        for project in config.projects.values_mut() {
            project.normalize_runtime();
            project.normalize_dev_server();
        }
        config.config_path = Some(path.to_path_buf());
        config.validate()?;
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

    pub fn validate(&self) -> Result<()> {
        if let Some(webhook) = self.webhook.as_ref().filter(|webhook| webhook.enabled) {
            if webhook
                .secret
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                anyhow::bail!("webhook.secret is required when webhook.enabled is true");
            }
        }

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
        let mut config = ConductorConfig {
            port: 8080,
            ..ConductorConfig::default()
        };
        config.server.port = 9090;
        assert_eq!(config.effective_port(), 8080);
    }

    #[test]
    fn test_effective_port_falls_back_to_server_port() {
        let mut config = ConductorConfig {
            port: 0,
            ..ConductorConfig::default()
        };
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
    fn test_validate_rejects_enabled_webhook_without_secret() {
        let config: ConductorConfig = serde_yaml::from_str(
            r#"
webhook:
  enabled: true
  port: 4748
"#,
        )
        .unwrap();

        let error = config.validate().unwrap_err().to_string();
        assert!(error.contains("webhook.secret is required"));
    }

    #[test]
    fn test_load_normalizes_and_accepts_webhook_secret() {
        let root = std::env::temp_dir().join(format!("conductor-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("conductor.yaml");
        std::fs::write(
            &path,
            r#"
webhook:
  enabled: true
  secret: "  test-secret  "
"#,
        )
        .unwrap();

        let config = ConductorConfig::load(&path).unwrap();
        let webhook = config.webhook.expect("webhook config");
        assert_eq!(webhook.port, 4748);
        assert_eq!(webhook.secret.as_deref(), Some("test-secret"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_preferences_defaults() {
        let prefs = PreferencesConfig::default();
        assert_eq!(prefs.coding_agent, "claude-code");
        assert_eq!(prefs.ide, "vscode");
        assert_eq!(prefs.markdown_editor, "obsidian");
        assert!(!prefs.onboarding_acknowledged);
    }

    #[test]
    fn test_project_config_default_branch_defaults_to_main() {
        let project = ProjectConfig::default();
        assert_eq!(project.default_branch, "main");
    }

    #[test]
    fn test_project_config_normalizes_nested_dev_server_compat() {
        let yaml = r#"
projects:
  demo:
    path: /tmp/demo
    devServer:
      command: pnpm dev
      cwd: apps/web
      port: 4321
      host: 0.0.0.0
      path: preview
      https: true
"#;
        let mut config: ConductorConfig = serde_yaml::from_str(yaml).unwrap();
        config
            .projects
            .get_mut("demo")
            .expect("demo project missing")
            .normalize_dev_server();
        let project = config.projects.get("demo").unwrap();

        assert_eq!(project.dev_server_script, vec!["pnpm dev".to_string()]);
        assert_eq!(project.dev_server_cwd.as_deref(), Some("apps/web"));
        assert_eq!(project.dev_server_port, Some(4321));
        assert_eq!(project.dev_server_host.as_deref(), Some("0.0.0.0"));
        assert_eq!(project.dev_server_path.as_deref(), Some("preview"));
        assert!(project.dev_server_https);
        assert_eq!(
            project.resolved_dev_server_url().as_deref(),
            Some("https://127.0.0.1:4321/preview")
        );
    }
}
