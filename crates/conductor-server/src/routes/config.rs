use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
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

const BUILTIN_REMOTE_SESSION_COOKIE: &str = "conductor_session";
const BUILTIN_REMOTE_SESSION_SECRET_ENV: &str = "CONDUCTOR_REMOTE_SESSION_SECRET";
const TRUSTED_HEADERS_ENABLED_ENV: &str = "CONDUCTOR_TRUST_AUTH_HEADERS";
const TRUSTED_PROVIDER_ENV: &str = "CONDUCTOR_TRUST_AUTH_PROVIDER";
const TRUSTED_EMAIL_HEADER_ENV: &str = "CONDUCTOR_TRUST_AUTH_EMAIL_HEADER";
const TRUSTED_JWT_HEADER_ENV: &str = "CONDUCTOR_TRUST_AUTH_JWT_HEADER";
const TRUSTED_CLOUDFLARE_TEAM_DOMAIN_ENV: &str = "CONDUCTOR_CLOUDFLARE_ACCESS_TEAM_DOMAIN";
const TRUSTED_CLOUDFLARE_AUDIENCE_ENV: &str = "CONDUCTOR_CLOUDFLARE_ACCESS_AUDIENCE";
const TRUSTED_ALLOW_INSECURE_HEADERS_ENV: &str = "CONDUCTOR_ALLOW_INSECURE_TRUSTED_HEADERS";
const PROVIDER_CLOUDFLARE_ACCESS: &str = "cloudflare-access";
const PROVIDER_TRUSTED_HEADER: &str = "trusted-header";

fn parse_csv(value: &str) -> Vec<String> {
    value
        .split([',', ';'])
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
}

fn parse_role(value: &str) -> Option<&'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "viewer" => Some("viewer"),
        "operator" => Some("operator"),
        "admin" => Some("admin"),
        _ => None,
    }
}

fn resolve_default_role(config: &DashboardAccessConfig) -> String {
    parse_role(&env::var("CONDUCTOR_ACCESS_DEFAULT_ROLE").unwrap_or_else(|_| String::new()))
        .unwrap_or(config.default_role.as_str())
        .to_string()
}

fn parse_env_bool(name: &str) -> bool {
    env::var(name).map(|value| value.trim().eq_ignore_ascii_case("true")).unwrap_or(false)
}

fn should_require_auth(config: &DashboardAccessConfig) -> bool {
    config.require_auth
        || parse_env_bool("CONDUCTOR_REQUIRE_AUTH")
        || !legacy_allowlist_emails().is_empty()
        || !legacy_allowlist_domains().is_empty()
        || !legacy_admin_emails().is_empty()
}

fn legacy_allowlist_emails() -> Vec<String> {
    parse_csv(&env::var("CONDUCTOR_ALLOWED_EMAILS").unwrap_or_default())
}

fn legacy_allowlist_domains() -> Vec<String> {
    parse_csv(&env::var("CONDUCTOR_ALLOWED_DOMAINS").unwrap_or_default())
}

fn legacy_admin_emails() -> Vec<String> {
    parse_csv(&env::var("CONDUCTOR_ADMIN_EMAILS").unwrap_or_default())
}

fn resolve_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_header = headers.get("cookie")?.to_str().ok()?;
    for cookie in cookie_header.split(';') {
        let mut split = cookie.trim().splitn(2, '=');
        let key = split.next()?.trim();
        let value = split.next()?.trim();
        if key == name {
            return Some(value.to_string());
        }
    }
    None
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut mismatch = 0u8;
    for (lhs, rhs) in left.iter().zip(right.iter()) {
        mismatch |= lhs ^ rhs;
    }
    mismatch == 0
}

fn verify_builtin_session(secret: &str, value: &str) -> bool {
    let separator = value.find('.');
    if separator == None || separator == Some(0) || separator == Some(value.len() - 1) {
        return false;
    }
    let separator = separator.unwrap_or(0);
    let payload = value[..separator].trim();
    let signature = value[separator + 1..].trim();
    let expires_at = match payload.parse::<i64>() {
        Ok(value) => value,
        Err(_) => return false,
    };
    if expires_at <= chrono::Utc::now().timestamp_millis() {
        return false;
    }

    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(payload.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    return constant_time_equal(expected.as_bytes(), signature.as_bytes());
}

fn matches_domain(email: &str, domains: &[String]) -> bool {
    let normalized = email.to_ascii_lowercase();
    domains
        .iter()
        .any(|domain| !domain.is_empty() && normalized.ends_with(&format!("@{domain}")))
}

fn matches_email_or_domain(email: &str, emails: &[String], domains: &[String]) -> bool {
    let normalized = email.to_ascii_lowercase();
    emails.iter().any(|entry| entry == &normalized) || matches_domain(&normalized, domains)
}

fn role_bindings_configured(bindings: &DashboardRoleBindings) -> bool {
    !bindings.viewers.is_empty()
        || !bindings.operators.is_empty()
        || !bindings.admins.is_empty()
        || !bindings.viewer_domains.is_empty()
        || !bindings.operator_domains.is_empty()
        || !bindings.admin_domains.is_empty()
}

fn resolve_role_for_email(
    email: &str,
    access: &DashboardAccessConfig,
) -> (Option<String>, bool, bool) {
    let normalized = email.trim().to_ascii_lowercase();
    let mut admin_emails = access.roles.admins.iter().cloned().collect::<Vec<_>>();
    admin_emails.extend(legacy_admin_emails());

    let mut operator_emails = access.roles.operators.iter().cloned().collect::<Vec<_>>();
    operator_emails.extend(legacy_allowlist_emails());

    let viewer_emails = access.roles.viewers.clone();

    let admin_domains = access.roles.admin_domains.clone();
    let mut operator_domains = access.roles.operator_domains.clone();
    operator_domains.extend(legacy_allowlist_domains());

    let viewer_domains = access.roles.viewer_domains.clone();

    let explicit_bindings_configured = role_bindings_configured(&access.roles)
        || !admin_emails.is_empty()
        || !operator_emails.is_empty()
        || !operator_domains.is_empty();

    if matches_email_or_domain(&normalized, &admin_emails, &admin_domains) {
        return (Some("admin".to_string()), true, explicit_bindings_configured);
    }
    if matches_email_or_domain(&normalized, &operator_emails, &operator_domains) {
        return (Some("operator".to_string()), true, explicit_bindings_configured);
    }
    if matches_email_or_domain(&normalized, &viewer_emails, &viewer_domains) {
        return (Some("viewer".to_string()), true, explicit_bindings_configured);
    }

    let default_role = parse_role(&resolve_default_role(access)).map(str::to_string);
    if let Some(role) = default_role {
        return (Some(role), false, explicit_bindings_configured);
    }

    if explicit_bindings_configured {
        return (None, false, true);
    }

    (Some("operator".to_string()), false, false)
}

enum TrustedHeaderIdentity {
    Authenticated { provider: &'static str, email: String },
    Unauthenticated { provider: &'static str, reason: String, email: Option<String> },
    NotProvided,
}

fn resolve_trusted_header_identity(
    headers: &HeaderMap,
    access: &DashboardAccessConfig,
) -> Option<TrustedHeaderIdentity> {
    let enabled = access.trusted_headers.enabled || parse_env_bool(TRUSTED_HEADERS_ENABLED_ENV);
    if !enabled {
        return None;
    }

    let configured_provider = env::var(TRUSTED_PROVIDER_ENV)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| access.trusted_headers.provider.trim().to_ascii_lowercase());
    let provider = if configured_provider == "generic" {
        PROVIDER_TRUSTED_HEADER
    } else {
        PROVIDER_CLOUDFLARE_ACCESS
    };

    if provider == PROVIDER_TRUSTED_HEADER {
        let email_header = env::var(TRUSTED_EMAIL_HEADER_ENV)
            .unwrap_or_else(|_| access.trusted_headers.email_header.clone());
        let allow_insecure = parse_env_bool(TRUSTED_ALLOW_INSECURE_HEADERS_ENV);
        let email = headers
            .get(email_header.as_str())
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|email| !email.is_empty())?;

        if !allow_insecure {
            return Some(TrustedHeaderIdentity::Unauthenticated {
                provider,
                reason:
                    "Generic trusted-header mode is disabled. Use verified Cloudflare Access, or explicitly set CONDUCTOR_ALLOW_INSECURE_TRUSTED_HEADERS=true."
                        .to_string(),
                email: Some(email),
            });
        }
        return Some(TrustedHeaderIdentity::Authenticated {
            provider,
            email,
        });
    }

    let jwt_header = env::var(TRUSTED_JWT_HEADER_ENV).unwrap_or_else(|_| access.trusted_headers.jwt_header.clone());
    let has_jwt = headers
        .get(jwt_header.as_str())
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.trim().is_empty());
    if !has_jwt {
        return Some(TrustedHeaderIdentity::NotProvided);
    }

    let email_header = env::var(TRUSTED_EMAIL_HEADER_ENV).unwrap_or_else(|_| access.trusted_headers.email_header.clone());
    let email = headers.get(email_header.as_str()).and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|email| !email.is_empty());

    let team_domain = env::var(TRUSTED_CLOUDFLARE_TEAM_DOMAIN_ENV)
        .ok()
        .or_else(|| access.trusted_headers.team_domain.clone().into())
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
    let audience = env::var(TRUSTED_CLOUDFLARE_AUDIENCE_ENV)
        .ok()
        .or_else(|| access.trusted_headers.audience.clone().into())
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

    if team_domain.is_none() || audience.is_none() {
        return Some(TrustedHeaderIdentity::Unauthenticated {
            provider,
            reason: "Cloudflare Access is enabled but team domain or audience is missing.".to_string(),
            email,
        });
    }

    Some(TrustedHeaderIdentity::Unauthenticated {
        provider,
        reason: "Cloudflare Access verification is not implemented in Rust backend.".to_string(),
        email,
    })
}

fn resolve_current_identity(headers: &HeaderMap, access: &DashboardAccessConfig) -> Value {
    if let Some(secret) = env::var(BUILTIN_REMOTE_SESSION_SECRET_ENV).ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if let Some(cookie) = resolve_cookie_value(headers, BUILTIN_REMOTE_SESSION_COOKIE) {
            if verify_builtin_session(&secret, &cookie) {
                return json!({
                    "authenticated": true,
                    "role": "admin",
                    "email": "builtin",
                    "provider": "builtin",
                    "reason": Value::Null,
                });
            }
        }
    }

    if let Some(trusted) = resolve_trusted_header_identity(headers, access) {
        match trusted {
            TrustedHeaderIdentity::NotProvided => {}
            TrustedHeaderIdentity::Unauthenticated {
                provider,
                reason,
                email,
            } => {
                return json!({
                    "authenticated": false,
                    "role": Value::Null,
                    "email": email,
                    "provider": provider,
                    "reason": reason,
                });
            }
            TrustedHeaderIdentity::Authenticated { provider, email } => {
                let is_allowed = legacy_allowlist_emails().is_empty()
                    && legacy_allowlist_domains().is_empty()
                    && legacy_admin_emails().is_empty()
                    || {
                        let normalized = email.trim().to_ascii_lowercase();
                        let allowed_emails = legacy_allowlist_emails();
                        let allowed_domains = legacy_allowlist_domains();
                        let admin_emails = legacy_admin_emails();
                        let allowed_by_email = allowed_emails.is_empty()
                            || allowed_emails.contains(&normalized)
                            || admin_emails.contains(&normalized);
                        let allowed_by_domain = allowed_domains.is_empty()
                            || allowed_domains.iter().any(|domain| normalized.ends_with(&format!("@{domain}")));
                        allowed_by_email && allowed_by_domain
                    };

                if !is_allowed {
                    return json!({
                        "authenticated": true,
                        "role": Value::Null,
                        "email": email,
                        "provider": provider,
                        "reason": "Email/domain not allowed",
                    });
                }

                let (role, _, explicit_bindings_configured) = resolve_role_for_email(&email, access);
                if let Some(role) = role {
                    return json!({
                        "authenticated": true,
                        "role": role,
                        "email": email,
                        "provider": provider,
                        "reason": Value::Null,
                    });
                }

                if explicit_bindings_configured {
                    return json!({
                        "authenticated": true,
                        "role": Value::Null,
                        "email": email,
                        "provider": provider,
                        "reason": "Authenticated user is not granted dashboard access",
                    });
                }
            }
        }
    }

    if should_require_auth(access) {
        return json!({
            "authenticated": false,
            "role": Value::Null,
            "email": Value::Null,
            "provider": Value::Null,
            "reason": "Authentication required",
        });
    }

    json!({
        "authenticated": false,
        "role": "admin",
        "email": "local",
        "provider": "local",
        "reason": Value::Null,
    })
}

async fn get_access(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    let config = state.config.read().await;
    let access = config.access.clone();
    Json(json!({
        "access": access,
        "current": resolve_current_identity(&headers, &access),
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
    if available_models.contains(&normalized) {
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
