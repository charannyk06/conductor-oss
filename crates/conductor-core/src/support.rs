use anyhow::Result;
use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use serde_yaml::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{
    normalized_runtime_label, AgentConfig, ConductorConfig, DashboardAccessConfig,
    GitHubProjectConfig, ModelAccessPreferences, NotificationPreferences, PreferencesConfig,
    ProjectConfig, TrustedHeaderAccessConfig,
};

pub const GENERATED_MARKER_KEY: &str = "_generatedFromWorkspace";

const FALLBACK_WATCHER_AGENTS: &[&str] = &[
    "codex",
    "claude-code",
    "gemini",
    "amp",
    "cursor-cli",
    "opencode",
    "droid",
    "qwen-code",
    "ccr",
    "github-copilot",
];

#[derive(Debug, Clone, Default)]
pub struct ConfigSyncResult {
    pub regenerated: usize,
    pub skipped_unmanaged: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MirrorRoot {
    port: u16,
    dashboard_url: String,
    access: MirrorAccess,
    preferences: MirrorPreferences,
    projects: BTreeMap<String, MirrorProject>,
    #[serde(rename = "_generatedFromWorkspace")]
    generated_from_workspace: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MirrorAccess {
    require_auth: bool,
    default_role: String,
    trusted_headers: MirrorTrustedHeaders,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MirrorTrustedHeaders {
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
struct MirrorPreferences {
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
struct MirrorProject {
    name: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
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
    default_working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    github_project: Option<GitHubProjectConfig>,
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

fn is_false(value: &bool) -> bool {
    !*value
}

pub fn startup_config_sync(
    config: &ConductorConfig,
    workspace_path: &Path,
    force: bool,
) -> Result<ConfigSyncResult> {
    let mut result = ConfigSyncResult::default();

    for (project_id, project) in &config.projects {
        let project_root = resolve_project_path(workspace_path, &project.path);
        if !project_root.is_dir() {
            continue;
        }

        match sync_project_local_config_with_force(config, workspace_path, project_id, force)? {
            ProjectLocalConfigSync::Regenerated => result.regenerated += 1,
            ProjectLocalConfigSync::SkippedUnmanaged => result.skipped_unmanaged += 1,
            ProjectLocalConfigSync::Unchanged | ProjectLocalConfigSync::SkippedMissingDir => {}
        }
    }

    Ok(result)
}

pub fn sync_project_local_config(
    config: &ConductorConfig,
    workspace_path: &Path,
    project_id: &str,
) -> Result<bool> {
    Ok(matches!(
        sync_project_local_config_with_force(config, workspace_path, project_id, false)?,
        ProjectLocalConfigSync::Regenerated
    ))
}

pub fn sync_workspace_support_files(
    config: &ConductorConfig,
    workspace_path: &Path,
) -> Result<usize> {
    let support_directories = resolve_support_directories(config, workspace_path);
    let mut synced = 0usize;

    for directory in support_directories {
        if sync_support_files_for_directory(config, &directory)? {
            synced += 1;
        }
    }

    Ok(synced)
}

pub fn sync_support_files_for_directory(
    config: &ConductorConfig,
    directory: &Path,
) -> Result<bool> {
    if !directory.is_dir() {
        return Ok(false);
    }

    let tags_content = build_conductor_tags_content(config);
    let snippets_json = serde_json::to_string_pretty(&build_conductor_code_snippets(config))?;
    fs::write(directory.join("CONDUCTOR-TAGS.md"), &tags_content)?;
    let vscode_dir = directory.join(".vscode");
    fs::create_dir_all(&vscode_dir)?;
    fs::write(vscode_dir.join("conductor.code-snippets"), &snippets_json)?;
    Ok(true)
}

pub fn resolve_project_path(workspace_path: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}

fn build_expected_project_yaml(
    config: &ConductorConfig,
    project_id: &str,
    project: &ProjectConfig,
) -> String {
    let port = config.effective_port();
    let preferences = build_preferences(&config.preferences);
    let access = build_access(&config.access);

    let mut projects = BTreeMap::new();
    projects.insert(project_id.to_string(), build_project(project_id, project));

    let root = MirrorRoot {
        port,
        dashboard_url: config
            .dashboard_url
            .clone()
            .unwrap_or_else(|| format!("http://localhost:{port}")),
        access,
        preferences,
        projects,
        generated_from_workspace: Utc::now().to_rfc3339(),
    };

    serde_yaml::to_string(&root).unwrap_or_default()
}

fn build_access(access: &DashboardAccessConfig) -> MirrorAccess {
    MirrorAccess {
        require_auth: access.require_auth,
        default_role: if access.default_role.trim().is_empty() {
            "operator".to_string()
        } else {
            access.default_role.clone()
        },
        trusted_headers: build_trusted_headers(&access.trusted_headers),
    }
}

fn build_trusted_headers(headers: &TrustedHeaderAccessConfig) -> MirrorTrustedHeaders {
    MirrorTrustedHeaders {
        enabled: headers.enabled,
        provider: if headers.provider.trim().is_empty() {
            "cloudflare-access".to_string()
        } else {
            headers.provider.clone()
        },
        email_header: if headers.email_header.trim().is_empty() {
            "Cf-Access-Authenticated-User-Email".to_string()
        } else {
            headers.email_header.clone()
        },
        jwt_header: if headers.jwt_header.trim().is_empty() {
            "Cf-Access-Jwt-Assertion".to_string()
        } else {
            headers.jwt_header.clone()
        },
        team_domain: headers.team_domain.clone(),
        audience: headers.audience.clone(),
    }
}

fn build_preferences(preferences: &PreferencesConfig) -> MirrorPreferences {
    MirrorPreferences {
        onboarding_acknowledged: preferences.onboarding_acknowledged,
        coding_agent: if preferences.coding_agent.trim().is_empty() {
            "claude-code".to_string()
        } else {
            preferences.coding_agent.clone()
        },
        ide: if preferences.ide.trim().is_empty() {
            "vscode".to_string()
        } else {
            preferences.ide.clone()
        },
        markdown_editor: if preferences.markdown_editor.trim().is_empty() {
            "obsidian".to_string()
        } else {
            preferences.markdown_editor.clone()
        },
        markdown_editor_path: preferences.markdown_editor_path.trim().to_string(),
        model_access: preferences.model_access.clone(),
        notifications: preferences.notifications.clone(),
    }
}

fn build_project(project_id: &str, project: &ProjectConfig) -> MirrorProject {
    let path = project.path.clone();
    let name = project
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            Path::new(&path)
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(project_id)
                .to_string()
        });

    MirrorProject {
        name,
        path,
        repo: project.repo.clone(),
        agent: project
            .agent
            .clone()
            .unwrap_or_else(|| "claude-code".to_string()),
        default_branch: if project.default_branch.trim().is_empty() {
            "main".to_string()
        } else {
            project.default_branch.clone()
        },
        session_prefix: project
            .session_prefix
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| generate_session_prefix(&project.path)),
        workspace: project
            .workspace
            .clone()
            .unwrap_or_else(|| "worktree".to_string()),
        runtime: project
            .runtime
            .clone()
            .map(|runtime| normalized_runtime_label(Some(runtime.as_str())))
            .unwrap_or_else(|| normalized_runtime_label(None)),
        agent_config: project.agent_config.clone(),
        scm: extract_scm_plugin(project),
        board_dir: project.board_dir.clone(),
        default_working_directory: project.default_working_directory.clone(),
        description: project.description.clone(),
        github_project: project.github_project.clone(),
        dev_server_script: project.dev_server_script.clone(),
        dev_server_cwd: project.dev_server_cwd.clone(),
        dev_server_url: project.dev_server_url.clone(),
        dev_server_port: project.dev_server_port,
        dev_server_host: project.dev_server_host.clone(),
        dev_server_path: project.dev_server_path.clone(),
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

fn generate_session_prefix(project_path: &str) -> String {
    let project_id = Path::new(project_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(project_path)
        .trim();

    if project_id.len() <= 4 {
        return project_id.to_ascii_lowercase();
    }

    let uppercase: String = project_id
        .chars()
        .filter(|ch| ch.is_ascii_uppercase())
        .collect();
    if uppercase.len() > 1 {
        return uppercase.to_ascii_lowercase();
    }

    if project_id.contains('-') || project_id.contains('_') {
        let separator = if project_id.contains('-') { '-' } else { '_' };
        let initials = project_id
            .split(separator)
            .filter_map(|word| word.chars().next())
            .collect::<String>();
        if !initials.is_empty() {
            return initials.to_ascii_lowercase();
        }
    }

    project_id
        .chars()
        .take(3)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn resolve_support_directories(config: &ConductorConfig, workspace_path: &Path) -> Vec<PathBuf> {
    let mut roots = BTreeSet::new();
    roots.insert(workspace_path.to_path_buf());
    for project in config.projects.values() {
        roots.insert(resolve_project_path(workspace_path, &project.path));
    }
    roots.into_iter().collect()
}

fn configured_agent_names(config: &ConductorConfig) -> Vec<String> {
    let mut names = BTreeSet::new();
    for agent in FALLBACK_WATCHER_AGENTS {
        names.insert((*agent).to_string());
    }
    if !config.preferences.coding_agent.trim().is_empty() {
        names.insert(config.preferences.coding_agent.clone());
    }
    for project in config.projects.values() {
        if let Some(agent) = project
            .agent
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            names.insert(agent.clone());
        }
    }
    names.into_iter().collect()
}

fn build_conductor_tags_content(config: &ConductorConfig) -> String {
    let project_ids = config.projects.keys().cloned().collect::<Vec<_>>();
    let agents = configured_agent_names(config);
    let first_project = project_ids
        .first()
        .cloned()
        .unwrap_or_else(|| "my-project".to_string());
    let second_project = project_ids
        .get(1)
        .cloned()
        .unwrap_or_else(|| first_project.clone());
    let first_agent = agents
        .first()
        .cloned()
        .unwrap_or_else(|| "codex".to_string());
    let second_agent = agents
        .get(1)
        .cloned()
        .unwrap_or_else(|| "claude-code".to_string());

    let project_tag_seeds = if project_ids.is_empty() {
        "#project/my-project".to_string()
    } else {
        project_ids
            .iter()
            .map(|id| format!("#project/{id}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let agent_tag_seeds = agents
        .iter()
        .map(|agent| format!("#agent/{agent}"))
        .collect::<Vec<_>>()
        .join(" ");

    let project_table_rows = if project_ids.is_empty() {
        "| `#project/my-project` | Replace this after adding your first project |".to_string()
    } else {
        project_ids
            .iter()
            .map(|id| {
                let description = config
                    .projects
                    .get(id)
                    .and_then(|project| project.description.as_deref())
                    .unwrap_or(id);
                format!("| `#project/{id}` | {description} |")
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let agent_table_rows = agents
        .iter()
        .map(|agent| format!("| `#agent/{agent}` | {agent} agent plugin |"))
        .collect::<Vec<_>>()
        .join("\n");

    let frontmatter_tags = [
        vec!["  - conductor/reference".to_string()],
        project_ids
            .iter()
            .map(|id| format!("  - project/{id}"))
            .collect::<Vec<_>>(),
        agents
            .iter()
            .map(|agent| format!("  - agent/{agent}"))
            .collect::<Vec<_>>(),
        vec![
            "  - type/feature".to_string(),
            "  - type/fix".to_string(),
            "  - type/review".to_string(),
            "  - type/chore".to_string(),
            "  - type/docs".to_string(),
            "  - priority/high".to_string(),
            "  - priority/medium".to_string(),
            "  - priority/low".to_string(),
        ],
    ]
    .concat()
    .join("\n");

    [
        "---".to_string(),
        "tags:".to_string(),
        frontmatter_tags,
        "---".to_string(),
        String::new(),
        "# Conductor Tag Reference".to_string(),
        String::new(),
        "Quick-reference for tagging tasks in any `CONDUCTOR.md` board.".to_string(),
        "Type `#` in Obsidian for autocomplete. Type `ctask` in VS Code for a full task snippet.".to_string(),
        String::new(),
        "> Auto-generated by conductor on startup. Add a project to `conductor.yaml` -> it appears here automatically."
            .to_string(),
        String::new(),
        "---".to_string(),
        String::new(),
        "## Project Tags".to_string(),
        String::new(),
        "| Tag | Description |".to_string(),
        "|-----|-------------|".to_string(),
        project_table_rows,
        String::new(),
        "---".to_string(),
        String::new(),
        "## Agent Tags".to_string(),
        String::new(),
        "| Tag | Uses |".to_string(),
        "|-----|------|".to_string(),
        agent_table_rows,
        String::new(),
        "---".to_string(),
        String::new(),
        "## Type Tags".to_string(),
        String::new(),
        "| Tag | Meaning |".to_string(),
        "|-----|---------|".to_string(),
        "| `#type/feature` | New feature or enhancement |".to_string(),
        "| `#type/fix` | Bug fix |".to_string(),
        "| `#type/review` | Code review or audit |".to_string(),
        "| `#type/chore` | Maintenance / deps / config |".to_string(),
        "| `#type/docs` | Documentation |".to_string(),
        String::new(),
        "---".to_string(),
        String::new(),
        "## Priority Tags".to_string(),
        String::new(),
        "| Tag | Meaning |".to_string(),
        "|-----|---------|".to_string(),
        "| `#priority/high` | Ship today |".to_string(),
        "| `#priority/medium` | This sprint |".to_string(),
        "| `#priority/low` | Nice to have |".to_string(),
        String::new(),
        "---".to_string(),
        String::new(),
        "## Example Task Formats".to_string(),
        String::new(),
        "```".to_string(),
        format!(
            "Fix login button tooltip #project/{first_project} #agent/{first_agent} #type/fix #priority/high"
        ),
        String::new(),
        format!(
            "Add analytics dashboard #project/{second_project} #agent/{second_agent} #type/feature"
        ),
        "```".to_string(),
        String::new(),
        "---".to_string(),
        String::new(),
        project_tag_seeds,
        agent_tag_seeds,
        "#type/feature #type/fix #type/review #type/chore #type/docs".to_string(),
        "#priority/high #priority/medium #priority/low".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn build_conductor_code_snippets(config: &ConductorConfig) -> serde_json::Value {
    let project_choices = if config.projects.is_empty() {
        "my-project".to_string()
    } else {
        config
            .projects
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(",")
    };
    let agents = configured_agent_names(config);
    let agent_choices = if agents.is_empty() {
        "codex,claude-code,gemini".to_string()
    } else {
        agents.join(",")
    };

    json!({
        "Conductor Project Tag": {
            "prefix": "#project",
            "body": [format!("#project/${{1|{project_choices}|}}")],
            "description": "Route task to a Conductor project",
        },
        "Conductor Agent Tag": {
            "prefix": "#agent",
            "body": [format!("#agent/${{1|{agent_choices}|}}")],
            "description": "Assign task to a specific agent",
        },
        "Conductor Type Tag": {
            "prefix": "#type",
            "body": ["#type/${1|feature,fix,review,chore,docs|}"],
            "description": "Set task type",
        },
        "Conductor Priority Tag": {
            "prefix": "#priority",
            "body": ["#priority/${1|high,medium,low|}"],
            "description": "Set task priority",
        },
        "Conductor Full Task": {
            "prefix": "ctask",
            "body": [format!(
                "- [ ] ${{1:Task description}} #project/${{2|{project_choices}|}} #agent/${{3|{agent_choices}|}} #type/${{4|feature,fix,review,chore|}} #priority/${{5|high,medium,low|}}"
            )],
            "description": "Full Conductor task with all tags",
        }
    })
}

enum ManagedState {
    Missing,
    Managed(String),
    Unmanaged,
}

enum ProjectLocalConfigSync {
    Regenerated,
    Unchanged,
    SkippedUnmanaged,
    SkippedMissingDir,
}

fn sync_project_local_config_with_force(
    config: &ConductorConfig,
    workspace_path: &Path,
    project_id: &str,
    force: bool,
) -> Result<ProjectLocalConfigSync> {
    let Some(project) = config.projects.get(project_id) else {
        anyhow::bail!("Unknown project id: {project_id}");
    };

    let project_root = resolve_project_path(workspace_path, &project.path);
    if !project_root.is_dir() {
        return Ok(ProjectLocalConfigSync::SkippedMissingDir);
    }

    let local_config_path = project_root.join("conductor.yaml");
    let expected = build_expected_project_yaml(config, project_id, project);

    match read_managed_state(&local_config_path)? {
        ManagedState::Missing => {
            fs::write(&local_config_path, expected)?;
            Ok(ProjectLocalConfigSync::Regenerated)
        }
        ManagedState::Managed(existing) => {
            if normalize_generated_yaml(&existing) != normalize_generated_yaml(&expected) {
                fs::write(&local_config_path, expected)?;
                Ok(ProjectLocalConfigSync::Regenerated)
            } else {
                Ok(ProjectLocalConfigSync::Unchanged)
            }
        }
        ManagedState::Unmanaged => {
            if force {
                fs::write(&local_config_path, expected)?;
                Ok(ProjectLocalConfigSync::Regenerated)
            } else {
                Ok(ProjectLocalConfigSync::SkippedUnmanaged)
            }
        }
    }
}

fn read_managed_state(path: &Path) -> Result<ManagedState> {
    if !path.exists() {
        return Ok(ManagedState::Missing);
    }

    let content = fs::read_to_string(path)?;
    let Ok(parsed) = serde_yaml::from_str::<Value>(&content) else {
        return Ok(ManagedState::Unmanaged);
    };
    if has_generated_marker(&parsed) {
        Ok(ManagedState::Managed(content))
    } else {
        Ok(ManagedState::Unmanaged)
    }
}

fn normalize_generated_yaml(content: &str) -> Value {
    let mut value = serde_yaml::from_str::<Value>(content).unwrap_or(Value::Null);
    strip_generated_marker(&mut value);
    value
}

fn has_generated_marker(value: &Value) -> bool {
    value
        .as_mapping()
        .map(|mapping| mapping.contains_key(Value::String(GENERATED_MARKER_KEY.to_string())))
        .unwrap_or(false)
}

fn strip_generated_marker(value: &mut Value) {
    if let Value::Mapping(mapping) = value {
        mapping.remove(Value::String(GENERATED_MARKER_KEY.to_string()));
        for nested in mapping.values_mut() {
            strip_generated_marker(nested);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn sample_config(workspace_path: &Path, project_path: &Path) -> ConductorConfig {
        let mut config = ConductorConfig::default_for_workspace(workspace_path);
        config.preferences.coding_agent = "claude-code".to_string();
        config.projects.insert(
            "demo".to_string(),
            ProjectConfig {
                name: Some("Demo".to_string()),
                repo: Some("example/demo".to_string()),
                path: project_path.to_string_lossy().to_string(),
                default_branch: "main".to_string(),
                session_prefix: Some("demo".to_string()),
                default_working_directory: None,
                board_dir: None,
                runtime: Some("worktree".to_string()),
                agent: Some("codex".to_string()),
                workspace: Some("worktree".to_string()),
                scm: Some(Value::String("github".to_string())),
                icon_url: None,
                description: Some("Demo project".to_string()),
                github_project: None,
                agent_config: AgentConfig {
                    permissions: Some("skip".to_string()),
                    model: None,
                    reasoning_effort: None,
                    session_timeout_secs: None,
                },
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
            },
        );
        config
    }

    #[test]
    fn sync_workspace_support_files_writes_tags_and_snippets() {
        let workspace = temp_dir("conductor-support-workspace");
        let project = temp_dir("conductor-support-project");
        let config = sample_config(&workspace, &project);

        let synced = sync_workspace_support_files(&config, &workspace).unwrap();
        assert_eq!(synced, 2);

        let workspace_tags = fs::read_to_string(workspace.join("CONDUCTOR-TAGS.md")).unwrap();
        let project_snippets =
            fs::read_to_string(project.join(".vscode").join("conductor.code-snippets")).unwrap();

        assert!(workspace_tags.contains("#project/demo"));
        assert!(project_snippets.contains("claude-code"));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn startup_config_sync_writes_generated_project_mirrors() {
        let workspace = temp_dir("conductor-config-workspace");
        let project = temp_dir("conductor-config-project");
        let config = sample_config(&workspace, &project);

        let result = startup_config_sync(&config, &workspace, false).unwrap();
        assert_eq!(result.regenerated, 1);

        let mirror = fs::read_to_string(project.join("conductor.yaml")).unwrap();
        assert!(mirror.contains(GENERATED_MARKER_KEY));
        assert!(mirror.contains("dashboardUrl"));
        assert!(mirror.contains("demo"));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn startup_config_sync_skips_unmanaged_files_without_force() {
        let workspace = temp_dir("conductor-config-skip-workspace");
        let project = temp_dir("conductor-config-skip-project");
        let config = sample_config(&workspace, &project);
        let local_config = project.join("conductor.yaml");
        fs::write(&local_config, "projects:\n  demo:\n    path: ./demo\n").unwrap();

        let result = startup_config_sync(&config, &workspace, false).unwrap();
        assert_eq!(result.regenerated, 0);
        assert_eq!(result.skipped_unmanaged, 1);

        let mirror = fs::read_to_string(local_config).unwrap();
        assert!(!mirror.contains(GENERATED_MARKER_KEY));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn generate_session_prefix_matches_expected_patterns() {
        assert_eq!(generate_session_prefix("/tmp/PyTorch"), "pt");
        assert_eq!(generate_session_prefix("/tmp/conductor-oss"), "co");
        assert_eq!(generate_session_prefix("/tmp/integrator"), "int");
        assert_eq!(generate_session_prefix("/tmp/app"), "app");
    }

    #[test]
    fn build_project_preserves_explicit_session_prefix_and_scm() {
        let project = ProjectConfig {
            name: Some("Demo".to_string()),
            repo: Some("example/demo".to_string()),
            path: "/tmp/demo".to_string(),
            default_branch: "main".to_string(),
            session_prefix: Some("dmx".to_string()),
            default_working_directory: None,
            board_dir: None,
            runtime: Some("ttyd".to_string()),
            agent: Some("claude-code".to_string()),
            workspace: Some("worktree".to_string()),
            scm: Some(Value::Mapping(serde_yaml::Mapping::from_iter([(
                Value::String("plugin".to_string()),
                Value::String("github".to_string()),
            )]))),
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
        };

        let mirror = build_project("demo", &project);
        assert_eq!(mirror.session_prefix, "dmx");
        assert_eq!(mirror.scm.as_deref(), Some("github"));
    }

    #[test]
    fn strip_generated_marker_only_removes_timestamp_field() {
        let mut value = Value::Mapping(serde_yaml::Mapping::from_iter([
            (
                Value::String(GENERATED_MARKER_KEY.to_string()),
                Value::String("now".to_string()),
            ),
            (
                Value::String("port".to_string()),
                Value::Number(4747.into()),
            ),
        ]));

        strip_generated_marker(&mut value);

        let mapping = value.as_mapping().unwrap();
        assert!(!mapping.contains_key(Value::String(GENERATED_MARKER_KEY.to_string())));
        assert!(mapping.contains_key(Value::String("port".to_string())));
    }
}
