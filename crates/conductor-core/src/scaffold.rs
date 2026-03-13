use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::{
    AgentConfig, DevServerCompatConfig, GitHubProjectConfig, ModelAccessPreferences,
    NotificationPreferences, PreferencesConfig, ProjectConfig,
};
pub use crate::support::GENERATED_MARKER_KEY;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldNotificationPreferences {
    pub sound_enabled: Option<bool>,
    pub sound_file: Option<String>,
    pub disable_sound_file: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ScaffoldPreferencesConfig {
    pub onboarding_acknowledged: Option<bool>,
    pub coding_agent: Option<String>,
    pub ide: Option<String>,
    pub markdown_editor: Option<String>,
    pub markdown_editor_path: Option<String>,
    pub model_access: Option<ModelAccessPreferences>,
    pub notifications: Option<ScaffoldNotificationPreferences>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldProjectConfig {
    pub project_id: String,
    pub display_name: Option<String>,
    pub repo: String,
    pub path: PathBuf,
    pub agent: String,
    pub default_branch: String,
    pub default_working_directory: Option<String>,
    pub session_prefix: Option<String>,
    pub workspace: Option<String>,
    pub runtime: Option<String>,
    pub scm: Option<String>,
    pub board_dir: Option<String>,
    pub github_project: Option<GitHubProjectConfig>,
    pub dev_server: Option<DevServerCompatConfig>,
    pub agent_model: Option<String>,
    pub agent_reasoning_effort: Option<String>,
    pub agent_permissions: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ConductorYamlScaffoldConfig {
    pub port: Option<u16>,
    pub dashboard_url: Option<String>,
    pub access: Option<ScaffoldAccessConfig>,
    pub preferences: Option<ScaffoldPreferencesConfig>,
    pub projects: Vec<ScaffoldProjectConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldTrustedHeadersConfig {
    pub enabled: Option<bool>,
    pub provider: Option<String>,
    pub email_header: Option<String>,
    pub jwt_header: Option<String>,
    pub team_domain: Option<String>,
    pub audience: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldAccessConfig {
    pub require_auth: Option<bool>,
    pub allow_signed_share_links: Option<bool>,
    pub default_role: Option<String>,
    pub trusted_headers: Option<ScaffoldTrustedHeadersConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldWorkspaceOptions {
    pub force: bool,
    pub project_id: Option<String>,
    pub display_name: Option<String>,
    pub repo: Option<String>,
    pub path: Option<PathBuf>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub ide: Option<String>,
    pub markdown_editor: Option<String>,
    pub default_branch: Option<String>,
    pub default_working_directory: Option<String>,
    pub dashboard_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedScaffoldProject {
    pub project_id: String,
    pub display_name: String,
    pub repo: String,
    pub path: PathBuf,
    pub agent: String,
    pub agent_model: Option<String>,
    pub agent_reasoning_effort: Option<String>,
    pub ide: String,
    pub markdown_editor: String,
    pub default_branch: String,
    pub default_working_directory: Option<String>,
    pub dashboard_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScaffoldWorkspaceResult {
    pub created: usize,
    pub project: ResolvedScaffoldProject,
    pub board_path: PathBuf,
    pub config_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldRoot {
    port: u16,
    dashboard_url: String,
    access: ScaffoldAccessRecord,
    preferences: ScaffoldPreferencesRecord,
    projects: BTreeMap<String, ScaffoldProjectRecord>,
    #[serde(rename = "_generatedFromWorkspace")]
    generated_from_workspace: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldAccessRecord {
    require_auth: bool,
    allow_signed_share_links: bool,
    default_role: String,
    trusted_headers: ScaffoldTrustedHeadersRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldTrustedHeadersRecord {
    enabled: bool,
    provider: String,
    email_header: String,
    jwt_header: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    team_domain: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    audience: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldPreferencesRecord {
    onboarding_acknowledged: bool,
    coding_agent: String,
    ide: String,
    markdown_editor: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    markdown_editor_path: String,
    model_access: ModelAccessPreferences,
    notifications: NotificationPreferences,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldProjectRecord {
    name: String,
    path: String,
    repo: String,
    agent: String,
    default_branch: String,
    session_prefix: String,
    workspace: String,
    runtime: String,
    agent_config: AgentConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    scm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    board_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    github_project: Option<GitHubProjectConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_working_directory: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    dev_server_script: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_server_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_server_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_server_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_server_path: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    dev_server_https: bool,
}

pub fn build_conductor_board(project_id: &str, display_name: &str) -> String {
    format!(
        "# {display_name}\n\n> Conductor AI agent orchestrator. Tags: `#project/{project_id}` `#agent/claude-code` `#agent/codex` `#agent/gemini`\n\n## Inbox\n\n> Drop rough ideas here.\n\n## Ready to Dispatch\n\n> Move tagged tasks here to dispatch an agent.\n\n## Dispatching\n\n## In Progress\n\n## Review\n\n## Done\n\n## Blocked\n"
    )
}

pub fn build_project_config(project: &ScaffoldProjectConfig) -> ProjectConfig {
    let mut config = ProjectConfig {
        name: Some(normalize_project_display_name(project)),
        repo: Some(project.repo.trim().to_string()),
        path: project.path.to_string_lossy().to_string(),
        default_branch: normalize_string(Some(project.default_branch.as_str()), "main".to_string()),
        session_prefix: Some(
            project
                .session_prefix
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| generate_session_prefix(&project.path)),
        ),
        default_working_directory: trim_option(project.default_working_directory.clone()),
        board_dir: trim_option(project.board_dir.clone()),
        runtime: Some({
            let runtime = normalize_string(project.runtime.as_deref(), "direct".to_string());
            if runtime == "tmux" {
                "direct".to_string()
            } else {
                runtime
            }
        }),
        agent: Some(normalize_string(
            Some(project.agent.as_str()),
            "claude-code".to_string(),
        )),
        workspace: Some(normalize_string(
            project.workspace.as_deref(),
            "worktree".to_string(),
        )),
        scm: trim_option(project.scm.clone())
            .map(Value::String)
            .or_else(|| {
                project
                    .repo
                    .contains('/')
                    .then(|| Value::String("github".to_string()))
            }),
        github_project: project.github_project.clone(),
        agent_config: AgentConfig {
            permissions: Some(
                project
                    .agent_permissions
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("skip")
                    .to_string(),
            ),
            model: trim_option(project.agent_model.clone()),
            reasoning_effort: trim_option(project.agent_reasoning_effort.clone()),
            session_timeout_secs: None,
        },
        ..ProjectConfig::default()
    };

    if let Some(dev_server) = &project.dev_server {
        if let Some(command) = trim_option(dev_server.command.clone()) {
            config.dev_server_script = vec![command];
        }
        config.dev_server_cwd = trim_option(dev_server.cwd.clone());
        config.dev_server_url = trim_option(dev_server.url.clone());
        config.dev_server_port = dev_server.port;
        config.dev_server_host = trim_option(dev_server.host.clone());
        config.dev_server_path = trim_option(dev_server.path.clone());
        config.dev_server_https = dev_server.https.unwrap_or(false);
    }

    config
}

pub fn build_conductor_yaml(config: &ConductorYamlScaffoldConfig) -> Result<String> {
    let port = config.port.unwrap_or(4747);
    let root = ScaffoldRoot {
        port,
        dashboard_url: config
            .dashboard_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("http://localhost:{port}")),
        access: build_access_record(config.access.as_ref()),
        preferences: build_preferences_record(config.preferences.as_ref()),
        projects: config
            .projects
            .iter()
            .map(|project| {
                (
                    project.project_id.clone(),
                    build_project_record(&build_project_config(project), &project.project_id),
                )
            })
            .collect(),
        generated_from_workspace: Utc::now().to_rfc3339(),
    };

    Ok(serde_yaml::to_string(&root)?)
}

pub fn resolve_scaffold_project(
    cwd: &Path,
    options: &ScaffoldWorkspaceOptions,
) -> Result<ResolvedScaffoldProject> {
    let requested_path = options.path.clone().unwrap_or_else(|| PathBuf::from("."));
    let resolved = if requested_path.is_absolute() {
        requested_path
    } else {
        cwd.join(requested_path)
    };
    let repo_path = detect_git_root(&resolved)?.unwrap_or(resolved);
    if !repo_path.is_dir() {
        anyhow::bail!("Repository path does not exist: {}", repo_path.display());
    }

    let canonical_repo_path = fs::canonicalize(&repo_path).unwrap_or(repo_path.clone());
    let detected_name = canonical_repo_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("my-app")
        .to_string();
    let detected_repo = parse_repo_slug(run_git(
        &canonical_repo_path,
        ["remote", "get-url", "origin"],
    )?);
    let detected_branch = detect_default_branch(&canonical_repo_path)?;
    let repo_slug = trim_option(options.repo.clone())
        .or(detected_repo)
        .unwrap_or_else(|| format!("your-org/{detected_name}"));
    let display_name =
        trim_option(options.display_name.clone()).unwrap_or_else(|| detected_name.clone());
    let project_id = trim_option(options.project_id.clone()).unwrap_or_else(|| {
        slugify_project_id(
            repo_slug
                .split('/')
                .next_back()
                .unwrap_or(detected_name.as_str()),
        )
    });

    Ok(ResolvedScaffoldProject {
        project_id,
        display_name,
        repo: repo_slug,
        path: canonical_repo_path,
        agent: trim_option(options.agent.clone()).unwrap_or_else(|| "claude-code".to_string()),
        agent_model: trim_option(options.model.clone()),
        agent_reasoning_effort: trim_option(options.reasoning_effort.clone())
            .map(|value| value.to_lowercase()),
        ide: trim_option(options.ide.clone()).unwrap_or_else(|| "vscode".to_string()),
        markdown_editor: trim_option(options.markdown_editor.clone())
            .unwrap_or_else(|| "obsidian".to_string()),
        default_branch: trim_option(options.default_branch.clone())
            .or(detected_branch)
            .unwrap_or_else(|| "main".to_string()),
        default_working_directory: trim_option(options.default_working_directory.clone()),
        dashboard_url: trim_option(options.dashboard_url.clone()),
    })
}

pub fn scaffold_workspace(
    cwd: &Path,
    options: &ScaffoldWorkspaceOptions,
) -> Result<ScaffoldWorkspaceResult> {
    let project = resolve_scaffold_project(cwd, options)?;
    let board_path = project.path.join("CONDUCTOR.md");
    let config_path = project.path.join("conductor.yaml");
    let mut created = 0usize;

    if !board_path.exists() || options.force {
        fs::write(
            &board_path,
            build_conductor_board(&project.project_id, &project.display_name),
        )
        .with_context(|| format!("failed to write {}", board_path.display()))?;
        created += 1;
    }

    if !config_path.exists() || options.force {
        let yaml = build_conductor_yaml(&ConductorYamlScaffoldConfig {
            dashboard_url: project.dashboard_url.clone(),
            preferences: Some(ScaffoldPreferencesConfig {
                onboarding_acknowledged: Some(false),
                coding_agent: Some(project.agent.clone()),
                ide: Some(project.ide.clone()),
                markdown_editor: Some(project.markdown_editor.clone()),
                ..ScaffoldPreferencesConfig::default()
            }),
            projects: vec![ScaffoldProjectConfig {
                project_id: project.project_id.clone(),
                display_name: Some(project.display_name.clone()),
                repo: project.repo.clone(),
                path: project.path.clone(),
                agent: project.agent.clone(),
                default_branch: project.default_branch.clone(),
                default_working_directory: project.default_working_directory.clone(),
                agent_model: project.agent_model.clone(),
                agent_reasoning_effort: project.agent_reasoning_effort.clone(),
                ..ScaffoldProjectConfig::default()
            }],
            ..ConductorYamlScaffoldConfig::default()
        })?;
        fs::write(&config_path, yaml)
            .with_context(|| format!("failed to write {}", config_path.display()))?;
        created += 1;
    }

    Ok(ScaffoldWorkspaceResult {
        created,
        project,
        board_path,
        config_path,
    })
}

fn build_access_record(config: Option<&ScaffoldAccessConfig>) -> ScaffoldAccessRecord {
    let trusted_headers = config.and_then(|value| value.trusted_headers.as_ref());
    ScaffoldAccessRecord {
        require_auth: config.and_then(|value| value.require_auth).unwrap_or(false),
        allow_signed_share_links: config
            .and_then(|value| value.allow_signed_share_links)
            .unwrap_or(false),
        default_role: config
            .and_then(|value| value.default_role.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("operator")
            .to_string(),
        trusted_headers: ScaffoldTrustedHeadersRecord {
            enabled: trusted_headers
                .and_then(|value| value.enabled)
                .unwrap_or(false),
            provider: trusted_headers
                .and_then(|value| value.provider.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("cloudflare-access")
                .to_string(),
            email_header: trusted_headers
                .and_then(|value| value.email_header.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Cf-Access-Authenticated-User-Email")
                .to_string(),
            jwt_header: trusted_headers
                .and_then(|value| value.jwt_header.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Cf-Access-Jwt-Assertion")
                .to_string(),
            team_domain: trusted_headers
                .and_then(|value| value.team_domain.as_deref())
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
            audience: trusted_headers
                .and_then(|value| value.audience.as_deref())
                .map(str::trim)
                .unwrap_or_default()
                .to_string(),
        },
    }
}

fn build_preferences_record(
    config: Option<&ScaffoldPreferencesConfig>,
) -> ScaffoldPreferencesRecord {
    let default_preferences = PreferencesConfig::default();
    let notifications = config.and_then(|value| value.notifications.as_ref());
    ScaffoldPreferencesRecord {
        onboarding_acknowledged: config
            .and_then(|value| value.onboarding_acknowledged)
            .unwrap_or(false),
        coding_agent: config
            .and_then(|value| value.coding_agent.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_preferences.coding_agent.as_str())
            .to_string(),
        ide: config
            .and_then(|value| value.ide.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_preferences.ide.as_str())
            .to_string(),
        markdown_editor: config
            .and_then(|value| value.markdown_editor.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_preferences.markdown_editor.as_str())
            .to_string(),
        markdown_editor_path: config
            .and_then(|value| value.markdown_editor_path.as_deref())
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        model_access: config
            .and_then(|value| value.model_access.clone())
            .unwrap_or_default(),
        notifications: NotificationPreferences {
            sound_enabled: notifications
                .and_then(|value| value.sound_enabled)
                .unwrap_or(true),
            sound_file: if notifications
                .map(|value| value.disable_sound_file)
                .unwrap_or(false)
            {
                None
            } else {
                trim_option(notifications.and_then(|value| value.sound_file.clone()))
                    .or_else(|| NotificationPreferences::default().sound_file)
            },
        },
    }
}

fn build_project_record(project: &ProjectConfig, project_id: &str) -> ScaffoldProjectRecord {
    let display_name = project
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            Path::new(&project.path)
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(project_id)
                .to_string()
        });

    ScaffoldProjectRecord {
        name: display_name,
        path: project.path.clone(),
        repo: project.repo.clone().unwrap_or_default(),
        agent: project
            .agent
            .clone()
            .unwrap_or_else(|| "claude-code".to_string()),
        default_branch: normalize_string(Some(project.default_branch.as_str()), "main".to_string()),
        session_prefix: project
            .session_prefix
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| generate_session_prefix(Path::new(&project.path))),
        workspace: project
            .workspace
            .clone()
            .unwrap_or_else(|| "worktree".to_string()),
        runtime: project
            .runtime
            .clone()
            .map(|runtime| {
                if runtime.trim() == "tmux" {
                    "direct".to_string()
                } else {
                    runtime
                }
            })
            .unwrap_or_else(|| "direct".to_string()),
        agent_config: project.agent_config.clone(),
        scm: extract_scm_plugin(project),
        board_dir: trim_option(project.board_dir.clone()),
        github_project: project.github_project.clone(),
        default_working_directory: trim_option(project.default_working_directory.clone()),
        dev_server_script: project.dev_server_script.clone(),
        dev_server_cwd: trim_option(project.dev_server_cwd.clone()),
        dev_server_url: trim_option(project.dev_server_url.clone()),
        dev_server_port: project.dev_server_port,
        dev_server_host: trim_option(project.dev_server_host.clone()),
        dev_server_path: trim_option(project.dev_server_path.clone()),
        dev_server_https: project.dev_server_https,
    }
}

fn extract_scm_plugin(project: &ProjectConfig) -> Option<String> {
    match project.scm.as_ref() {
        Some(Value::String(plugin)) if !plugin.trim().is_empty() => Some(plugin.clone()),
        Some(Value::Mapping(mapping)) => mapping
            .get(Value::String("plugin".to_string()))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        _ => project
            .repo
            .as_ref()
            .filter(|value| value.contains('/'))
            .map(|_| "github".to_string()),
    }
}

fn slugify_project_id(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.trim().chars() {
        let normalized = ch.to_ascii_lowercase();
        if normalized.is_ascii_alphanumeric() {
            slug.push(normalized);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    slug.trim_matches('-').to_string().if_empty("my-app")
}

fn parse_repo_slug(remote_url: Option<String>) -> Option<String> {
    let remote_url = remote_url?.trim().to_string();
    if remote_url.is_empty() {
        return None;
    }

    if let Some(rest) = remote_url.strip_prefix("git@") {
        let slug = rest.split_once(':')?.1.replace(".git", "");
        return (!slug.is_empty()).then_some(slug);
    }

    let candidate = remote_url.strip_suffix(".git").unwrap_or(&remote_url);
    if let Some((_, remainder)) = candidate.split_once("://") {
        let slug = remainder
            .split_once('/')
            .map(|(_, path)| path.trim_start_matches('/').to_string())
            .unwrap_or_default();
        return (!slug.is_empty()).then_some(slug);
    }

    let slug = candidate.trim_start_matches('/').to_string();
    (!slug.is_empty()).then_some(slug)
}

fn detect_git_root(path: &Path) -> Result<Option<PathBuf>> {
    Ok(run_git(path, ["rev-parse", "--show-toplevel"])?.map(PathBuf::from))
}

fn detect_default_branch(path: &Path) -> Result<Option<String>> {
    if let Some(remote_head) = run_git(
        path,
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )? {
        return Ok(Some(remote_head.trim_start_matches("origin/").to_string()));
    }

    run_git(path, ["branch", "--show-current"])
}

fn run_git<const N: usize>(cwd: &Path, args: [&str; N]) -> Result<Option<String>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("failed to run git in {}", cwd.display()))?;
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!stdout.is_empty()).then_some(stdout))
}

fn normalize_project_display_name(project: &ScaffoldProjectConfig) -> String {
    trim_option(project.display_name.clone()).unwrap_or_else(|| {
        project
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(project.project_id.as_str())
            .to_string()
    })
}

fn generate_session_prefix(project_path: &Path) -> String {
    let project_id = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if project_id.len() <= 4 {
        return project_id.to_lowercase();
    }

    let uppercase: String = project_id
        .chars()
        .filter(|ch| ch.is_ascii_uppercase())
        .collect();
    if uppercase.len() > 1 {
        return uppercase.to_lowercase();
    }

    if project_id.contains('-') || project_id.contains('_') {
        let separator = if project_id.contains('-') { '-' } else { '_' };
        return project_id
            .split(separator)
            .filter_map(|segment| segment.chars().next())
            .collect::<String>()
            .to_lowercase();
    }

    project_id
        .chars()
        .take(3)
        .collect::<String>()
        .to_lowercase()
}

fn normalize_string(value: Option<&str>, default: String) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(default)
}

fn trim_option(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn is_false(value: &bool) -> bool {
    !*value
}

trait EmptyStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Mapping;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "conductor-scaffold-tests-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "git {:?} failed in {}",
            args,
            path.display()
        );
    }

    fn init_repo(path: &Path, branch: &str, remote: &str) {
        fs::create_dir_all(path).unwrap();
        git(path, &["init", "-b", branch]);
        git(path, &["remote", "add", "origin", remote]);
    }

    fn mapping_value<'a>(mapping: &'a Mapping, key: &str) -> &'a serde_yaml::Value {
        mapping
            .get(serde_yaml::Value::String(key.to_string()))
            .unwrap()
    }

    #[test]
    fn build_conductor_yaml_prepopulates_dashboard_url_from_port() {
        let yaml = build_conductor_yaml(&ConductorYamlScaffoldConfig {
            port: Some(4812),
            ..ConductorYamlScaffoldConfig::default()
        })
        .unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(
            parsed["dashboardUrl"].as_str(),
            Some("http://localhost:4812")
        );
    }

    #[test]
    fn build_conductor_yaml_persists_model_access_and_project_model_defaults() {
        let yaml = build_conductor_yaml(&ConductorYamlScaffoldConfig {
            preferences: Some(ScaffoldPreferencesConfig {
                coding_agent: Some("codex".to_string()),
                model_access: Some(ModelAccessPreferences {
                    codex: "api".to_string(),
                    ..ModelAccessPreferences::default()
                }),
                ..ScaffoldPreferencesConfig::default()
            }),
            projects: vec![ScaffoldProjectConfig {
                project_id: "repo".to_string(),
                repo: "org/repo".to_string(),
                path: PathBuf::from("/tmp/repo"),
                agent: "codex".to_string(),
                default_branch: "main".to_string(),
                agent_model: Some("gpt-5.2-codex".to_string()),
                agent_reasoning_effort: Some("xhigh".to_string()),
                ..ScaffoldProjectConfig::default()
            }],
            ..ConductorYamlScaffoldConfig::default()
        })
        .unwrap();

        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(
            parsed["preferences"]["modelAccess"]["codex"].as_str(),
            Some("api")
        );
        assert_eq!(
            parsed["projects"]["repo"]["agentConfig"]["model"].as_str(),
            Some("gpt-5.2-codex")
        );
        assert_eq!(
            parsed["projects"]["repo"]["agentConfig"]["reasoningEffort"].as_str(),
            Some("xhigh")
        );
    }

    #[test]
    fn build_conductor_yaml_uses_organization_friendly_access_defaults() {
        let yaml = build_conductor_yaml(&ConductorYamlScaffoldConfig::default()).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();

        assert_eq!(parsed["access"]["requireAuth"].as_bool(), Some(false));
        assert_eq!(
            parsed["access"]["allowSignedShareLinks"].as_bool(),
            Some(false)
        );
        assert_eq!(parsed["access"]["defaultRole"].as_str(), Some("operator"));
        assert_eq!(
            parsed["access"]["trustedHeaders"]["enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(
            parsed["access"]["trustedHeaders"]["provider"].as_str(),
            Some("cloudflare-access")
        );
        assert_eq!(
            parsed["access"]["trustedHeaders"]["emailHeader"].as_str(),
            Some("Cf-Access-Authenticated-User-Email")
        );
        assert_eq!(
            parsed["access"]["trustedHeaders"]["jwtHeader"].as_str(),
            Some("Cf-Access-Jwt-Assertion")
        );
    }

    #[test]
    fn resolve_scaffold_project_auto_detects_git_repo_root() {
        let temp_dir = TestDir::new();
        let repo_root = temp_dir.path().join("repo");
        init_repo(&repo_root, "main", "git@github.com:acme/example.git");
        fs::create_dir_all(repo_root.join("nested").join("child")).unwrap();

        let project = resolve_scaffold_project(
            repo_root.join("nested").join("child").as_path(),
            &ScaffoldWorkspaceOptions::default(),
        )
        .unwrap();

        assert_eq!(project.path, fs::canonicalize(&repo_root).unwrap());
        assert_eq!(project.repo, "acme/example");
        assert_eq!(project.default_branch, "main");
        assert_eq!(project.project_id, "example");
    }

    #[test]
    fn scaffold_workspace_creates_files_and_respects_force() {
        let temp_dir = TestDir::new();
        let repo_root = temp_dir.path().join("repo");
        init_repo(&repo_root, "main", "https://github.com/acme/example.git");

        let first = scaffold_workspace(&repo_root, &ScaffoldWorkspaceOptions::default()).unwrap();
        assert_eq!(first.created, 2);
        assert!(first.board_path.exists());
        assert!(first.config_path.exists());

        fs::write(&first.board_path, "custom board").unwrap();
        fs::write(&first.config_path, "custom config").unwrap();

        let second = scaffold_workspace(&repo_root, &ScaffoldWorkspaceOptions::default()).unwrap();
        assert_eq!(second.created, 0);
        assert_eq!(
            fs::read_to_string(&first.board_path).unwrap(),
            "custom board"
        );
        assert_eq!(
            fs::read_to_string(&first.config_path).unwrap(),
            "custom config"
        );

        let third = scaffold_workspace(
            &repo_root,
            &ScaffoldWorkspaceOptions {
                force: true,
                ..ScaffoldWorkspaceOptions::default()
            },
        )
        .unwrap();
        assert_eq!(third.created, 2);
        assert!(fs::read_to_string(&first.board_path)
            .unwrap()
            .contains("Ready to Dispatch"));
        assert!(fs::read_to_string(&first.config_path)
            .unwrap()
            .contains("dashboardUrl"));
    }

    #[test]
    fn build_project_config_applies_defaults() {
        let project = build_project_config(&ScaffoldProjectConfig {
            project_id: "repo".to_string(),
            repo: "org/repo".to_string(),
            path: PathBuf::from("/tmp/MyRepo"),
            agent: "codex".to_string(),
            default_branch: "main".to_string(),
            ..ScaffoldProjectConfig::default()
        });

        assert_eq!(project.name.as_deref(), Some("MyRepo"));
        assert_eq!(project.session_prefix.as_deref(), Some("mr"));
        assert_eq!(project.workspace.as_deref(), Some("worktree"));
        assert_eq!(project.runtime.as_deref(), Some("direct"));
        assert_eq!(project.agent_config.permissions.as_deref(), Some("skip"));
        assert_eq!(project.scm, Some(Value::String("github".to_string())));
    }

    #[test]
    fn build_conductor_yaml_contains_generation_marker() {
        let yaml = build_conductor_yaml(&ConductorYamlScaffoldConfig::default()).unwrap();
        let parsed: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        let mapping = parsed.as_mapping().unwrap();
        assert!(mapping_value(mapping, GENERATED_MARKER_KEY)
            .as_str()
            .is_some());
    }
}
