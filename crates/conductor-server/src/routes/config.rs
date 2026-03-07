use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

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
    let executors = state.executors.read().await;
    let agents = executors
        .iter()
        .map(|(kind, executor)| {
            let (description, homepage, icon_url) = agent_metadata(kind);
            json!({
                "name": kind.to_string(),
                "description": description,
                "version": Value::Null,
                "homepage": homepage,
                "iconUrl": icon_url,
                "installed": true,
                "configured": true,
                "ready": true,
                "runtimeModelCatalog": Value::Null,
                "binary": executor.binary_path().display().to_string(),
            })
        })
        .collect::<Vec<_>>();
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
