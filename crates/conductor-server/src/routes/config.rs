use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;

use crate::state::AppState;
use conductor_core::config::{DashboardAccessConfig, DashboardRoleBindings, NotificationPreferences, PreferencesConfig, TrustedHeaderAccessConfig};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/config", get(get_config))
        .route("/api/preferences", get(get_preferences).put(update_preferences))
        .route("/api/access", get(get_access).put(update_access))
        .route("/api/agents", get(list_agents))
        .route("/api/executor/health", get(executor_health))
}

async fn get_config(State(state): State<Arc<AppState>>) -> Json<Value> {
    let config = state.config.read().await.clone();
    Json(state.config_projects_payload(&config))
}

async fn get_preferences(State(state): State<Arc<AppState>>) -> Json<Value> {
    let config = state.config.read().await;
    Json(json!({ "preferences": config.preferences }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesBody {
    onboarding_acknowledged: Option<bool>,
    coding_agent: Option<String>,
    ide: Option<String>,
    remote_ssh_host: Option<String>,
    remote_ssh_user: Option<String>,
    markdown_editor: Option<String>,
    notifications: Option<NotificationsBody>,
    #[allow(dead_code)]
    model_access: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationsBody {
    sound_enabled: Option<bool>,
    sound_file: Option<Option<String>>,
}

async fn update_preferences(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PreferencesBody>,
) -> (StatusCode, Json<Value>) {
    let current = state.config.read().await.preferences.clone();
    let next = PreferencesConfig {
        onboarding_acknowledged: body
            .onboarding_acknowledged
            .unwrap_or(current.onboarding_acknowledged),
        coding_agent: body.coding_agent.unwrap_or(current.coding_agent),
        ide: body.ide.unwrap_or(current.ide),
        remote_ssh_host: body.remote_ssh_host.unwrap_or(current.remote_ssh_host),
        remote_ssh_user: body.remote_ssh_user.unwrap_or(current.remote_ssh_user),
        markdown_editor: body.markdown_editor.unwrap_or(current.markdown_editor),
        model_access: current.model_access,
        notifications: NotificationPreferences {
            sound_enabled: body
                .notifications
                .as_ref()
                .and_then(|value| value.sound_enabled)
                .unwrap_or(current.notifications.sound_enabled),
            sound_file: body
                .notifications
                .and_then(|value| value.sound_file)
                .unwrap_or(current.notifications.sound_file),
        },
    };
    match state.update_preferences(next).await {
        Ok(preferences) => (StatusCode::OK, Json(json!({ "preferences": preferences }))),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))),
    }
}

async fn get_access(State(state): State<Arc<AppState>>) -> Json<Value> {
    let config = state.config.read().await;
    Json(json!({
        "access": config.access,
        "current": {
            "authenticated": false,
            "role": "admin",
            "email": "local",
            "provider": "local",
        }
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessBody {
    require_auth: Option<bool>,
    default_role: Option<String>,
    trusted_headers: Option<TrustedHeadersBody>,
    roles: Option<RoleBindingsBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedHeadersBody {
    enabled: Option<bool>,
    provider: Option<String>,
    email_header: Option<String>,
    jwt_header: Option<String>,
    team_domain: Option<String>,
    audience: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RoleBindingsBody {
    viewers: Option<Vec<String>>,
    operators: Option<Vec<String>>,
    admins: Option<Vec<String>>,
    viewer_domains: Option<Vec<String>>,
    operator_domains: Option<Vec<String>>,
    admin_domains: Option<Vec<String>>,
}

async fn update_access(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AccessBody>,
) -> (StatusCode, Json<Value>) {
    let current = state.config.read().await.access.clone();
    let next = DashboardAccessConfig {
        require_auth: body.require_auth.unwrap_or(current.require_auth),
        default_role: body.default_role.unwrap_or(current.default_role),
        trusted_headers: body
            .trusted_headers
            .map(|value| TrustedHeaderAccessConfig {
                enabled: value.enabled.unwrap_or(current.trusted_headers.enabled),
                provider: value.provider.unwrap_or(current.trusted_headers.provider.clone()),
                email_header: value
                    .email_header
                    .unwrap_or(current.trusted_headers.email_header.clone()),
                jwt_header: value
                    .jwt_header
                    .unwrap_or(current.trusted_headers.jwt_header.clone()),
                team_domain: value.team_domain.unwrap_or(current.trusted_headers.team_domain.clone()),
                audience: value.audience.unwrap_or(current.trusted_headers.audience.clone()),
            })
            .unwrap_or(current.trusted_headers),
        roles: body
            .roles
            .map(|value| DashboardRoleBindings {
                viewers: value.viewers.unwrap_or(current.roles.viewers.clone()),
                operators: value.operators.unwrap_or(current.roles.operators.clone()),
                admins: value.admins.unwrap_or(current.roles.admins.clone()),
                viewer_domains: value
                    .viewer_domains
                    .unwrap_or(current.roles.viewer_domains.clone()),
                operator_domains: value
                    .operator_domains
                    .unwrap_or(current.roles.operator_domains.clone()),
                admin_domains: value.admin_domains.unwrap_or(current.roles.admin_domains.clone()),
            })
            .unwrap_or(current.roles),
    };

    match state.update_access(next).await {
        Ok(access) => (StatusCode::OK, Json(json!({ "access": access }))),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))),
    }
}

async fn list_agents(State(state): State<Arc<AppState>>) -> Json<Value> {
    let executor_entries = {
        let executors = state.executors.read().await;
        executors
            .iter()
            .map(|(kind, executor)| (kind.clone(), executor.binary_path().to_path_buf()))
            .collect::<Vec<_>>()
    };
    let mut agents = Vec::with_capacity(executor_entries.len());
    for (kind, binary_path) in executor_entries {
        let (description, homepage, icon_url) = agent_metadata(&kind);
        agents.push(json!({
            "name": kind.to_string(),
            "description": description,
            "version": Value::Null,
            "homepage": homepage,
            "iconUrl": icon_url,
            "installed": true,
            "configured": true,
            "ready": true,
            "runtimeModelCatalog": build_runtime_model_catalog(&kind, &binary_path).await,
            "binary": binary_path.display().to_string(),
        }));
    }
    Json(json!({ "agents": agents }))
}

async fn executor_health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "mode": "local",
        "transport": "rust-backend",
        "remoteUrl": Value::Null,
        "capabilities": ["feed", "send"],
    }))
}

fn agent_metadata(kind: &conductor_core::types::AgentKind) -> (&'static str, &'static str, &'static str) {
    match kind {
        conductor_core::types::AgentKind::ClaudeCode => (
            "Claude Code CLI",
            "https://www.anthropic.com/claude",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        ),
        conductor_core::types::AgentKind::Codex => (
            "OpenAI Codex CLI",
            "https://github.com/openai/codex",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
        ),
        conductor_core::types::AgentKind::Gemini => (
            "Google Gemini CLI",
            "https://ai.google.dev/gemini-api/docs",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
        ),
        conductor_core::types::AgentKind::Amp => (
            "Amp Code CLI",
            "https://www.ampcode.com",
            "https://ampcode.com/amp-mark-color.svg",
        ),
        conductor_core::types::AgentKind::CursorCli => (
            "Cursor Agent CLI",
            "https://www.cursor.com",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
        ),
        conductor_core::types::AgentKind::OpenCode => (
            "OpenCode CLI",
            "https://opencode.ai",
            "",
        ),
        conductor_core::types::AgentKind::Droid => (
            "Factory Droid CLI",
            "https://github.com/Factory-AI/factory",
            "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
        ),
        conductor_core::types::AgentKind::QwenCode => (
            "Qwen Code CLI",
            "https://qwenlm.github.io/announcements/",
            "",
        ),
        conductor_core::types::AgentKind::Ccr => (
            "Claude Code Router",
            "https://github.com/mckaywrigley/claude-code-router",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        ),
        conductor_core::types::AgentKind::GithubCopilot => (
            "GitHub Copilot CLI",
            "https://github.com/github/copilot-cli",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
        ),
        conductor_core::types::AgentKind::Custom(_) => ("Custom agent", "", ""),
    }
}

async fn build_runtime_model_catalog(
    kind: &conductor_core::types::AgentKind,
    binary_path: &Path,
) -> Value {
    match kind {
        conductor_core::types::AgentKind::ClaudeCode => {
            build_claude_runtime_model_catalog(binary_path)
                .await
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

fn user_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn read_json_file(path: PathBuf) -> Option<Value> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn format_claude_model_label(model: &str) -> String {
    let normalized = model.trim().to_lowercase();
    if normalized == "opus" {
        return "Claude Opus".to_string();
    }
    if normalized == "sonnet" {
        return "Claude Sonnet".to_string();
    }
    if normalized == "haiku" {
        return "Claude Haiku".to_string();
    }

    let parts = normalized.split('-').collect::<Vec<_>>();
    if parts.len() >= 4 && parts[0] == "claude" {
        let family = parts[1];
        if ["sonnet", "opus", "haiku"].contains(&family) {
            return format!(
                "Claude {} {}.{}",
                family[..1].to_uppercase() + &family[1..],
                parts[2],
                parts[3]
            );
        }
    }

    normalized
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn claude_access_for_model(model: &str) -> Vec<&'static str> {
    let normalized = model.trim().to_lowercase();
    if normalized == "opus" || normalized.contains("claude-opus") {
        return vec!["max", "api"];
    }
    if normalized == "haiku" || normalized.contains("claude-haiku") {
        return vec!["api"];
    }
    vec!["pro", "max", "api"]
}

fn claude_model_option(model: &str, description: &str) -> Value {
    json!({
        "id": model,
        "label": format_claude_model_label(model),
        "description": description,
        "access": claude_access_for_model(model),
    })
}

fn collect_claude_stats_models(stats: &Value) -> Vec<String> {
    let mut ordered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let entries = stats
        .get("dailyModelTokens")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for entry in entries.into_iter().rev() {
        let Some(tokens_by_model) = entry.get("tokensByModel").and_then(Value::as_object) else {
            continue;
        };
        for model in tokens_by_model.keys() {
            let normalized = model.trim();
            if !normalized.starts_with("claude-") || !seen.insert(normalized.to_string()) {
                continue;
            }
            ordered.push(normalized.to_string());
        }
    }

    ordered
}

async fn detect_claude_reasoning_options(binary_path: &Path) -> Vec<Value> {
    let output = tokio::time::timeout(
        Duration::from_millis(1_500),
        Command::new(binary_path).arg("--help").output(),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let combined = output
        .map(|result| {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            format!("{stdout}\n{stderr}")
        })
        .unwrap_or_default();

    let Some(line) = combined.lines().find(|line| line.contains("--effort")) else {
        return Vec::new();
    };
    let Some(start) = line.find('(') else {
        return Vec::new();
    };
    let Some(end) = line[start + 1..].find(')') else {
        return Vec::new();
    };

    line[start + 1..start + 1 + end]
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .map(|effort| {
            let label = if effort == "xhigh" {
                "Extra High".to_string()
            } else {
                let mut chars = effort.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => effort.clone(),
                }
            };
            let description = match effort.as_str() {
                "low" => "Fast responses with lighter reasoning.",
                "medium" => "Balanced speed and reasoning depth for everyday tasks.",
                "high" => "Deeper reasoning for more complex tasks.",
                "xhigh" => "Maximum reasoning depth for the hardest tasks.",
                _ => "Reasoning effort supported by the local CLI.",
            };
            json!({
                "id": effort,
                "label": label,
                "description": description,
            })
        })
        .collect()
}

fn resolve_claude_configured_model(
    configured_model: Option<&str>,
    available_models: &[String],
    family: &str,
) -> Option<String> {
    let normalized = configured_model?.trim().to_lowercase();
    if available_models.iter().any(|model| *model == normalized) {
        return Some(normalized);
    }
    if normalized == family {
        return available_models
            .iter()
            .find(|model| model.to_lowercase().contains(&format!("claude-{family}")))
            .cloned();
    }
    None
}

async fn build_claude_runtime_model_catalog(binary_path: &Path) -> Option<Value> {
    let home_dir = user_home_dir()?;
    let settings = read_json_file(home_dir.join(".claude").join("settings.json"));
    let stats = read_json_file(home_dir.join(".claude").join("stats-cache.json"));
    let reasoning_options = detect_claude_reasoning_options(binary_path).await;
    let discovered_models = collect_claude_stats_models(stats.as_ref().unwrap_or(&Value::Null));
    let configured_model = settings
        .as_ref()
        .and_then(|settings| settings.get("model"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase());

    if discovered_models.is_empty() && configured_model.is_none() {
        return None;
    }

    let all_models = if discovered_models.is_empty() {
        vec![configured_model.clone().unwrap_or_else(|| "sonnet".to_string())]
    } else {
        discovered_models.clone()
    };

    let pro_models = all_models
        .iter()
        .filter(|model| claude_access_for_model(model).contains(&"pro"))
        .cloned()
        .collect::<Vec<_>>();
    let max_models = all_models
        .iter()
        .filter(|model| claude_access_for_model(model).contains(&"max"))
        .cloned()
        .collect::<Vec<_>>();
    let api_models = all_models
        .iter()
        .filter(|model| claude_access_for_model(model).contains(&"api"))
        .cloned()
        .collect::<Vec<_>>();

    let pro_default = resolve_claude_configured_model(configured_model.as_deref(), &pro_models, "sonnet")
        .or_else(|| pro_models.first().cloned());
    let max_default = resolve_claude_configured_model(configured_model.as_deref(), &max_models, "opus")
        .or_else(|| max_models.iter().find(|model| model.contains("claude-opus")).cloned())
        .or_else(|| max_models.first().cloned());
    let api_default = resolve_claude_configured_model(configured_model.as_deref(), &api_models, "sonnet")
        .or_else(|| api_models.first().cloned());

    let default_reasoning = settings
        .as_ref()
        .and_then(|settings| settings.get("alwaysThinkingEnabled"))
        .and_then(Value::as_bool)
        .map(|enabled| if enabled { "high" } else { "medium" })
        .unwrap_or("medium");

    Some(json!({
        "agent": "claude-code",
        "customModelPlaceholder": configured_model.clone().unwrap_or_else(|| all_models[0].clone()),
        "defaultModelByAccess": {
            "pro": pro_default,
            "max": max_default,
            "api": api_default,
        },
        "modelsByAccess": {
            "pro": pro_models.iter().map(|model| claude_model_option(model, &format!("Model discovered from the local Claude Code installation ({model})."))).collect::<Vec<_>>(),
            "max": max_models.iter().map(|model| claude_model_option(model, &format!("Model discovered from the local Claude Code installation ({model})."))).collect::<Vec<_>>(),
            "api": api_models.iter().map(|model| claude_model_option(model, &format!("Model discovered from the local Claude Code installation ({model})."))).collect::<Vec<_>>(),
        },
        "defaultReasoningByAccess": {
            "pro": default_reasoning,
            "max": default_reasoning,
            "api": default_reasoning,
        },
        "reasoningOptionsByAccess": if reasoning_options.is_empty() {
            Value::Null
        } else {
            json!({
                "pro": reasoning_options,
                "max": reasoning_options,
                "api": reasoning_options,
            })
        },
    }))
}
