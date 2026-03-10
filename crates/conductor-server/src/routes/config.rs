use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Command;

use crate::state::AppState;
use conductor_core::config::{
    DashboardAccessConfig, DashboardRoleBindings, ModelAccessPreferences, NotificationPreferences,
    PreferencesConfig, TrustedHeaderAccessConfig,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AccessRole {
    Viewer,
    Operator,
    Admin,
}

impl AccessRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Operator => "operator",
            Self::Admin => "admin",
        }
    }

    pub(crate) fn allows(self, required: Self) -> bool {
        self >= required
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AccessIdentity {
    pub authenticated: bool,
    pub role: Option<AccessRole>,
    pub email: Option<String>,
    pub provider: Option<String>,
    pub reason: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/config", get(get_config))
        .route(
            "/api/preferences",
            get(get_preferences).put(update_preferences),
        )
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
    markdown_editor: Option<String>,
    markdown_editor_path: Option<String>,
    notifications: Option<NotificationsBody>,
    model_access: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationsBody {
    sound_enabled: Option<bool>,
    sound_file: Option<Option<String>>,
}

fn resolve_model_access_value(
    incoming: Option<&String>,
    current: &str,
    allowed: &[&str],
) -> String {
    match incoming {
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            if allowed.iter().any(|candidate| *candidate == normalized) {
                normalized
            } else {
                current.to_string()
            }
        }
        None => current.to_string(),
    }
}

fn merge_model_access_preferences(
    current: &ModelAccessPreferences,
    update: Option<&HashMap<String, String>>,
) -> ModelAccessPreferences {
    let values = match update {
        Some(values) => values,
        None => return current.clone(),
    };

    ModelAccessPreferences {
        claude_code: resolve_model_access_value(
            values
                .get("claudeCode")
                .or_else(|| values.get("claude_code")),
            &current.claude_code,
            &["pro", "max", "api"],
        ),
        codex: resolve_model_access_value(values.get("codex"), &current.codex, &["chatgpt", "api"]),
        gemini: resolve_model_access_value(
            values.get("gemini"),
            &current.gemini,
            &["oauth", "api"],
        ),
        qwen_code: resolve_model_access_value(
            values.get("qwenCode").or_else(|| values.get("qwen_code")),
            &current.qwen_code,
            &["oauth", "api"],
        ),
    }
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
        markdown_editor: body.markdown_editor.unwrap_or(current.markdown_editor),
        markdown_editor_path: body
            .markdown_editor_path
            .unwrap_or(current.markdown_editor_path),
        model_access: merge_model_access_preferences(
            &current.model_access,
            body.model_access.as_ref(),
        ),
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
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        ),
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
const PROVIDER_CLOUDFLARE_ACCESS: &str = "cloudflare-access";
const PROVIDER_TRUSTED_HEADER: &str = "trusted-header";
const DEFAULT_TRUSTED_EMAIL_HEADER: &str = "Cf-Access-Authenticated-User-Email";
const DEFAULT_TRUSTED_JWT_HEADER: &str = "Cf-Access-Jwt-Assertion";
const CLOUDFLARE_JWKS_CACHE_TTL: Duration = Duration::from_secs(300);
const PROXY_AUTHORIZED_HEADER: &str = "x-conductor-proxy-authorized";
const PROXY_AUTHENTICATED_HEADER: &str = "x-conductor-access-authenticated";
const PROXY_ROLE_HEADER: &str = "x-conductor-access-role";
const PROXY_EMAIL_HEADER: &str = "x-conductor-access-email";
const PROXY_PROVIDER_HEADER: &str = "x-conductor-access-provider";

#[derive(Debug, Clone)]
struct TrustedHeaderAuthConfig {
    enabled: bool,
    provider: &'static str,
    email_header: String,
    jwt_header: String,
    team_domain: Option<String>,
    audience: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CloudflareJwksResponse {
    keys: Vec<CloudflareJwk>,
}

#[derive(Debug, Clone, Deserialize)]
struct CloudflareJwk {
    #[serde(default)]
    kid: Option<String>,
    kty: String,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
}

#[derive(Debug, Clone)]
struct CloudflareJwksCacheEntry {
    keys: Vec<CloudflareJwk>,
    fetched_at: Instant,
}

static CLOUDFLARE_JWKS_CACHE: LazyLock<Mutex<HashMap<String, CloudflareJwksCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CLOUDFLARE_JWKS_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("cloudflare jwks client")
});

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

fn parse_access_role(value: &str) -> Option<AccessRole> {
    match parse_role(value) {
        Some("viewer") => Some(AccessRole::Viewer),
        Some("operator") => Some(AccessRole::Operator),
        Some("admin") => Some(AccessRole::Admin),
        _ => None,
    }
}

fn resolve_default_role(config: &DashboardAccessConfig) -> String {
    parse_role(&env::var("CONDUCTOR_ACCESS_DEFAULT_ROLE").unwrap_or_else(|_| String::new()))
        .unwrap_or(config.default_role.as_str())
        .to_string()
}

fn parse_env_bool(name: &str) -> bool {
    env::var(name)
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn normalize_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_team_domain(value: &str) -> Option<String> {
    let trimmed = normalize_value(value)?;
    let candidate = if trimmed.contains("://") {
        trimmed.clone()
    } else {
        format!("https://{trimmed}")
    };
    if let Ok(url) = reqwest::Url::parse(&candidate) {
        if let Some(host) = url.host_str() {
            return Some(host.to_ascii_lowercase());
        }
    }

    Some(
        trimmed
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_ascii_lowercase(),
    )
}

fn configured_header(env_name: &str, configured: &str, default_value: &str) -> String {
    env::var(env_name)
        .ok()
        .and_then(|value| normalize_value(&value))
        .or_else(|| normalize_value(configured))
        .unwrap_or_else(|| default_value.to_string())
}

fn configured_optional_value(env_name: &str, configured: &str) -> Option<String> {
    env::var(env_name)
        .ok()
        .and_then(|value| normalize_value(&value))
        .or_else(|| normalize_value(configured))
}

fn resolve_trusted_header_config(access: &DashboardAccessConfig) -> TrustedHeaderAuthConfig {
    let provider = env::var(TRUSTED_PROVIDER_ENV)
        .ok()
        .and_then(|value| normalize_value(&value))
        .unwrap_or_else(|| access.trusted_headers.provider.trim().to_ascii_lowercase());
    let provider = if provider == "generic" {
        PROVIDER_TRUSTED_HEADER
    } else {
        PROVIDER_CLOUDFLARE_ACCESS
    };

    TrustedHeaderAuthConfig {
        enabled: access.trusted_headers.enabled || parse_env_bool(TRUSTED_HEADERS_ENABLED_ENV),
        provider,
        email_header: configured_header(
            TRUSTED_EMAIL_HEADER_ENV,
            &access.trusted_headers.email_header,
            DEFAULT_TRUSTED_EMAIL_HEADER,
        ),
        jwt_header: configured_header(
            TRUSTED_JWT_HEADER_ENV,
            &access.trusted_headers.jwt_header,
            DEFAULT_TRUSTED_JWT_HEADER,
        ),
        team_domain: configured_optional_value(
            TRUSTED_CLOUDFLARE_TEAM_DOMAIN_ENV,
            &access.trusted_headers.team_domain,
        )
        .and_then(|value| normalize_team_domain(&value)),
        audience: configured_optional_value(
            TRUSTED_CLOUDFLARE_AUDIENCE_ENV,
            &access.trusted_headers.audience,
        ),
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_value)
}

pub(crate) fn proxy_request_authorized(headers: &HeaderMap) -> bool {
    headers
        .get(PROXY_AUTHORIZED_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn resolve_proxy_access_identity(headers: &HeaderMap) -> Option<AccessIdentity> {
    if !proxy_request_authorized(headers) {
        return None;
    }

    // These headers are set by the Next proxy after it has already resolved dashboard access.
    // The Rust backend is expected to remain loopback-only unless explicitly exposed unsafely.
    let authenticated = headers
        .get(PROXY_AUTHENTICATED_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(true);

    Some(AccessIdentity {
        authenticated,
        role: header_value(headers, PROXY_ROLE_HEADER).and_then(|value| parse_access_role(&value)),
        email: header_value(headers, PROXY_EMAIL_HEADER),
        provider: header_value(headers, PROXY_PROVIDER_HEADER),
        reason: None,
    })
}

fn numeric_claim(payload: &Value, key: &str) -> Option<i64> {
    match payload.get(key) {
        Some(Value::Number(value)) => value.as_i64(),
        Some(Value::String(value)) => value.parse::<i64>().ok(),
        _ => None,
    }
}

fn audience_matches(payload: &Value, audience: &str) -> bool {
    match payload.get("aud") {
        Some(Value::String(value)) => value == audience,
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .any(|value| value == audience),
        _ => false,
    }
}

fn extract_email_from_claims(payload: &Value) -> Option<String> {
    let email_claim = payload
        .get("email")
        .and_then(Value::as_str)
        .and_then(normalize_value)
        .map(|value| value.to_ascii_lowercase());
    if email_claim.is_some() {
        return email_claim;
    }

    payload
        .get("sub")
        .and_then(Value::as_str)
        .and_then(normalize_value)
        .filter(|value| value.contains('@'))
        .map(|value| value.to_ascii_lowercase())
}

fn is_supported_cloudflare_algorithm(algorithm: Algorithm) -> bool {
    matches!(
        algorithm,
        Algorithm::RS256
            | Algorithm::RS384
            | Algorithm::RS512
            | Algorithm::PS256
            | Algorithm::PS384
            | Algorithm::PS512
    )
}

fn validate_cloudflare_claims(
    payload: &Value,
    team_domain: &str,
    audience: &str,
) -> Result<(), String> {
    let issuer = payload
        .get("iss")
        .and_then(Value::as_str)
        .ok_or_else(|| "Cloudflare Access token is missing an issuer claim.".to_string())?;
    if issuer != format!("https://{team_domain}") {
        return Err(
            "Cloudflare Access token issuer did not match the configured team domain.".to_string(),
        );
    }

    if !audience_matches(payload, audience) {
        return Err(
            "Cloudflare Access token audience did not match the configured application."
                .to_string(),
        );
    }

    let now = chrono::Utc::now().timestamp();
    let exp = numeric_claim(payload, "exp")
        .ok_or_else(|| "Cloudflare Access token is missing an expiration claim.".to_string())?;
    if exp <= now {
        return Err("Cloudflare Access token has expired.".to_string());
    }

    if let Some(nbf) = numeric_claim(payload, "nbf") {
        if nbf > now {
            return Err("Cloudflare Access token is not valid yet.".to_string());
        }
    }

    Ok(())
}

fn select_cloudflare_jwk<'a>(
    keys: &'a [CloudflareJwk],
    kid: Option<&str>,
) -> Option<&'a CloudflareJwk> {
    let rsa_keys = keys
        .iter()
        .filter(|key| key.kty.eq_ignore_ascii_case("RSA"))
        .collect::<Vec<_>>();

    if let Some(kid) = kid {
        return rsa_keys
            .into_iter()
            .find(|key| key.kid.as_deref() == Some(kid));
    }

    if rsa_keys.len() == 1 {
        return rsa_keys.into_iter().next();
    }

    None
}

async fn fetch_cloudflare_jwks(team_domain: &str) -> Result<Vec<CloudflareJwk>, String> {
    let url = format!("https://{team_domain}/cdn-cgi/access/certs");
    let response = CLOUDFLARE_JWKS_CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("Cloudflare Access cert fetch failed: {err}"))?;
    let response = response
        .error_for_status()
        .map_err(|err| format!("Cloudflare Access cert fetch failed: {err}"))?;
    let payload = response
        .json::<CloudflareJwksResponse>()
        .await
        .map_err(|err| format!("Cloudflare Access cert response was invalid: {err}"))?;
    if payload.keys.is_empty() {
        return Err("Cloudflare Access cert endpoint returned no signing keys.".to_string());
    }
    Ok(payload.keys)
}

async fn get_cloudflare_jwks(
    team_domain: &str,
    force_refresh: bool,
) -> Result<Vec<CloudflareJwk>, String> {
    if !force_refresh {
        if let Some(cached) = CLOUDFLARE_JWKS_CACHE
            .lock()
            .unwrap()
            .get(team_domain)
            .cloned()
        {
            if cached.fetched_at.elapsed() < CLOUDFLARE_JWKS_CACHE_TTL {
                return Ok(cached.keys);
            }
        }
    }

    let keys = fetch_cloudflare_jwks(team_domain).await?;
    CLOUDFLARE_JWKS_CACHE.lock().unwrap().insert(
        team_domain.to_string(),
        CloudflareJwksCacheEntry {
            keys: keys.clone(),
            fetched_at: Instant::now(),
        },
    );
    Ok(keys)
}

async fn verify_cloudflare_access_assertion(
    assertion: &str,
    asserted_email: Option<&str>,
    team_domain: &str,
    audience: &str,
) -> Result<String, String> {
    let header = decode_header(assertion)
        .map_err(|err| format!("Cloudflare Access token header is invalid: {err}"))?;
    if !is_supported_cloudflare_algorithm(header.alg) {
        return Err("Cloudflare Access token uses an unsupported signing algorithm.".to_string());
    }

    let kid = header.kid.as_deref();
    let mut keys = get_cloudflare_jwks(team_domain, false).await?;
    let mut key = select_cloudflare_jwk(&keys, kid).cloned();
    if key.is_none() {
        keys = get_cloudflare_jwks(team_domain, true).await?;
        key = select_cloudflare_jwk(&keys, kid).cloned();
    }
    let key = key.ok_or_else(|| {
        "Cloudflare Access signing key was not found for the presented token.".to_string()
    })?;

    let modulus = key
        .n
        .as_deref()
        .ok_or_else(|| "Cloudflare Access signing key is missing an RSA modulus.".to_string())?;
    let exponent = key
        .e
        .as_deref()
        .ok_or_else(|| "Cloudflare Access signing key is missing an RSA exponent.".to_string())?;
    let decoding_key = DecodingKey::from_rsa_components(modulus, exponent)
        .map_err(|err| format!("Cloudflare Access signing key is invalid: {err}"))?;

    let mut validation = Validation::new(header.alg);
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();

    let token = decode::<Value>(assertion, &decoding_key, &validation)
        .map_err(|err| format!("Cloudflare Access token verification failed: {err}"))?;
    validate_cloudflare_claims(&token.claims, team_domain, audience)?;

    let email = extract_email_from_claims(&token.claims)
        .ok_or_else(|| "Cloudflare Access token is missing an email claim.".to_string())?;
    if let Some(asserted_email) = asserted_email {
        if asserted_email != email {
            return Err(
                "Cloudflare Access email header does not match the verified token.".to_string(),
            );
        }
    }

    Ok(email)
}

pub(crate) fn should_require_auth(config: &DashboardAccessConfig) -> bool {
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
    if separator.is_none() || separator == Some(0) || separator == Some(value.len() - 1) {
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
    constant_time_equal(expected.as_bytes(), signature.as_bytes())
}

fn builtin_remote_access_token() -> Option<String> {
    env::var("CONDUCTOR_REMOTE_ACCESS_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn builtin_remote_session_secret() -> Option<String> {
    env::var(BUILTIN_REMOTE_SESSION_SECRET_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn builtin_remote_auth_enabled() -> bool {
    builtin_remote_access_token().is_some() && builtin_remote_session_secret().is_some()
}

pub(crate) fn builtin_remote_auth_allowed(access: &DashboardAccessConfig) -> bool {
    access.allow_signed_share_links
}

pub(crate) fn access_control_enabled(access: &DashboardAccessConfig) -> bool {
    (builtin_remote_auth_allowed(access) && builtin_remote_auth_enabled())
        || should_require_auth(access)
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
    let mut admin_emails = access.roles.admins.to_vec();
    admin_emails.extend(legacy_admin_emails());

    let mut operator_emails = access.roles.operators.to_vec();
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
        return (
            Some("admin".to_string()),
            true,
            explicit_bindings_configured,
        );
    }
    if matches_email_or_domain(&normalized, &operator_emails, &operator_domains) {
        return (
            Some("operator".to_string()),
            true,
            explicit_bindings_configured,
        );
    }
    if matches_email_or_domain(&normalized, &viewer_emails, &viewer_domains) {
        return (
            Some("viewer".to_string()),
            true,
            explicit_bindings_configured,
        );
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
    Authenticated {
        provider: &'static str,
        email: String,
    },
    Unauthenticated {
        provider: &'static str,
        reason: String,
        email: Option<String>,
    },
    NotProvided,
}

async fn resolve_trusted_header_identity(
    headers: &HeaderMap,
    access: &DashboardAccessConfig,
) -> Option<TrustedHeaderIdentity> {
    let config = resolve_trusted_header_config(access);
    if !config.enabled {
        return None;
    }

    if config.provider == PROVIDER_TRUSTED_HEADER {
        let email = header_value(headers, &config.email_header)
            .map(|value| value.trim().to_ascii_lowercase());
        return Some(TrustedHeaderIdentity::Unauthenticated {
            provider: config.provider,
            reason:
                "Generic trusted-header mode has been removed. Configure verified Cloudflare Access instead."
                    .to_string(),
            email,
        });
    }

    let Some(assertion) = header_value(headers, &config.jwt_header) else {
        return Some(TrustedHeaderIdentity::NotProvided);
    };
    let asserted_email =
        header_value(headers, &config.email_header).map(|value| value.to_ascii_lowercase());

    let Some(team_domain) = config.team_domain.as_deref() else {
        return Some(TrustedHeaderIdentity::Unauthenticated {
            provider: config.provider,
            reason: "Cloudflare Access is enabled but team domain or audience is missing."
                .to_string(),
            email: asserted_email,
        });
    };
    let Some(audience) = config.audience.as_deref() else {
        return Some(TrustedHeaderIdentity::Unauthenticated {
            provider: config.provider,
            reason: "Cloudflare Access is enabled but team domain or audience is missing."
                .to_string(),
            email: asserted_email,
        });
    };

    match verify_cloudflare_access_assertion(
        &assertion,
        asserted_email.as_deref(),
        team_domain,
        audience,
    )
    .await
    {
        Ok(email) => Some(TrustedHeaderIdentity::Authenticated {
            provider: config.provider,
            email,
        }),
        Err(reason) => Some(TrustedHeaderIdentity::Unauthenticated {
            provider: config.provider,
            reason,
            email: asserted_email,
        }),
    }
}

pub(crate) async fn resolve_access_identity(
    headers: &HeaderMap,
    access: &DashboardAccessConfig,
) -> AccessIdentity {
    if let Some(identity) = resolve_proxy_access_identity(headers) {
        return identity;
    }

    if builtin_remote_auth_allowed(access) {
        if let Some(secret) = builtin_remote_session_secret() {
            if let Some(cookie) = resolve_cookie_value(headers, BUILTIN_REMOTE_SESSION_COOKIE) {
                if verify_builtin_session(&secret, &cookie) {
                    return AccessIdentity {
                        authenticated: true,
                        role: Some(AccessRole::Admin),
                        email: Some("builtin".to_string()),
                        provider: Some("builtin".to_string()),
                        reason: None,
                    };
                }
            }
        }
    }

    if let Some(trusted) = resolve_trusted_header_identity(headers, access).await {
        match trusted {
            TrustedHeaderIdentity::NotProvided => {}
            TrustedHeaderIdentity::Unauthenticated {
                provider,
                reason,
                email,
            } => {
                return AccessIdentity {
                    authenticated: false,
                    role: None,
                    email,
                    provider: Some(provider.to_string()),
                    reason: Some(reason),
                };
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
                            || allowed_domains
                                .iter()
                                .any(|domain| normalized.ends_with(&format!("@{domain}")));
                        allowed_by_email && allowed_by_domain
                    };

                if !is_allowed {
                    return AccessIdentity {
                        authenticated: true,
                        role: None,
                        email: Some(email),
                        provider: Some(provider.to_string()),
                        reason: Some("Email/domain not allowed".to_string()),
                    };
                }

                let (role, _, explicit_bindings_configured) =
                    resolve_role_for_email(&email, access);
                if let Some(role) = role {
                    return AccessIdentity {
                        authenticated: true,
                        role: parse_access_role(&role),
                        email: Some(email),
                        provider: Some(provider.to_string()),
                        reason: None,
                    };
                }

                if explicit_bindings_configured {
                    return AccessIdentity {
                        authenticated: true,
                        role: None,
                        email: Some(email),
                        provider: Some(provider.to_string()),
                        reason: Some(
                            "Authenticated user is not granted dashboard access".to_string(),
                        ),
                    };
                }
            }
        }
    }

    if access_control_enabled(access) {
        return AccessIdentity {
            authenticated: false,
            role: None,
            email: None,
            provider: None,
            reason: Some("Authentication required".to_string()),
        };
    }

    AccessIdentity {
        authenticated: false,
        role: Some(AccessRole::Admin),
        email: Some("local".to_string()),
        provider: Some("local".to_string()),
        reason: None,
    }
}

async fn resolve_current_identity(headers: &HeaderMap, access: &DashboardAccessConfig) -> Value {
    let identity = resolve_access_identity(headers, access).await;
    json!({
        "authenticated": identity.authenticated,
        "role": identity.role.map(AccessRole::as_str),
        "email": identity.email,
        "provider": identity.provider,
        "reason": identity.reason,
    })
}

async fn get_access(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    let config = state.config.read().await;
    let access = config.access.clone();
    Json(json!({
        "access": access,
        "current": resolve_current_identity(&headers, &access).await,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessBody {
    require_auth: Option<bool>,
    allow_signed_share_links: Option<bool>,
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
        allow_signed_share_links: body
            .allow_signed_share_links
            .unwrap_or(current.allow_signed_share_links),
        default_role: body.default_role.unwrap_or(current.default_role),
        trusted_headers: body
            .trusted_headers
            .map(|value| TrustedHeaderAccessConfig {
                enabled: value.enabled.unwrap_or(current.trusted_headers.enabled),
                provider: value
                    .provider
                    .unwrap_or(current.trusted_headers.provider.clone()),
                email_header: value
                    .email_header
                    .unwrap_or(current.trusted_headers.email_header.clone()),
                jwt_header: value
                    .jwt_header
                    .unwrap_or(current.trusted_headers.jwt_header.clone()),
                team_domain: value
                    .team_domain
                    .unwrap_or(current.trusted_headers.team_domain.clone()),
                audience: value
                    .audience
                    .unwrap_or(current.trusted_headers.audience.clone()),
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
                admin_domains: value
                    .admin_domains
                    .unwrap_or(current.roles.admin_domains.clone()),
            })
            .unwrap_or(current.roles),
    };

    match state.update_access(next).await {
        Ok(access) => (StatusCode::OK, Json(json!({ "access": access }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        ),
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

fn agent_metadata(
    kind: &conductor_core::types::AgentKind,
) -> (&'static str, &'static str, &'static str) {
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
            "https://www.npmjs.com/package/@musistudio/claude-code-router",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        ),
        conductor_core::types::AgentKind::GithubCopilot => (
            "GitHub Copilot CLI",
            "https://docs.github.com/copilot/how-tos/copilot-cli",
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
        return vec!["pro", "max", "api"];
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
        vec![configured_model
            .clone()
            .unwrap_or_else(|| "sonnet".to_string())]
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

    let pro_default =
        resolve_claude_configured_model(configured_model.as_deref(), &pro_models, "sonnet")
            .or_else(|| pro_models.first().cloned());
    let max_default =
        resolve_claude_configured_model(configured_model.as_deref(), &max_models, "opus")
            .or_else(|| {
                max_models
                    .iter()
                    .find(|model| model.contains("claude-opus"))
                    .cloned()
            })
            .or_else(|| max_models.first().cloned());
    let api_default =
        resolve_claude_configured_model(configured_model.as_deref(), &api_models, "sonnet")
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

#[cfg(test)]
mod tests {
    use super::{
        access_control_enabled, claude_access_for_model, resolve_access_identity, AccessRole,
        CloudflareJwk, CloudflareJwksCacheEntry, CLOUDFLARE_JWKS_CACHE,
    };
    use axum::http::HeaderMap;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use conductor_core::config::{DashboardAccessConfig, TrustedHeaderAccessConfig};
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    use rand::rngs::OsRng;
    use rsa::pkcs8::{EncodePrivateKey, LineEnding};
    use rsa::traits::PublicKeyParts;
    use rsa::RsaPrivateKey;
    use serde::Serialize;
    use std::sync::LazyLock;
    use std::time::Instant;

    const TEST_TEAM_DOMAIN: &str = "acme.cloudflareaccess.com";
    const TEST_AUDIENCE: &str = "cf-access-audience";

    struct TestCloudflareKeyMaterial {
        private_pem: String,
        modulus: String,
        exponent: String,
    }

    static TEST_CLOUDFLARE_KEY: LazyLock<TestCloudflareKeyMaterial> = LazyLock::new(|| {
        let mut rng = OsRng;
        let private_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let public_key = private_key.to_public_key();
        TestCloudflareKeyMaterial {
            private_pem: private_key
                .to_pkcs8_pem(LineEnding::LF)
                .unwrap()
                .to_string(),
            modulus: URL_SAFE_NO_PAD.encode(public_key.n().to_bytes_be()),
            exponent: URL_SAFE_NO_PAD.encode(public_key.e().to_bytes_be()),
        }
    });

    #[derive(Debug, Serialize)]
    struct TestCloudflareClaims<'a> {
        email: &'a str,
        iss: String,
        aud: &'a str,
        sub: &'a str,
        exp: usize,
        iat: usize,
    }

    fn cache_cloudflare_test_key(team_domain: &str) {
        let key = &*TEST_CLOUDFLARE_KEY;
        CLOUDFLARE_JWKS_CACHE.lock().unwrap().insert(
            team_domain.to_string(),
            CloudflareJwksCacheEntry {
                keys: vec![CloudflareJwk {
                    kid: Some("rust-edge-auth-test".to_string()),
                    kty: "RSA".to_string(),
                    n: Some(key.modulus.clone()),
                    e: Some(key.exponent.clone()),
                }],
                fetched_at: Instant::now(),
            },
        );
    }

    fn clear_cloudflare_test_cache() {
        CLOUDFLARE_JWKS_CACHE.lock().unwrap().clear();
    }

    fn build_cloudflare_assertion(email: &str) -> String {
        let key = &*TEST_CLOUDFLARE_KEY;
        let now = chrono::Utc::now().timestamp() as usize;
        let claims = TestCloudflareClaims {
            email,
            iss: format!("https://{TEST_TEAM_DOMAIN}"),
            aud: TEST_AUDIENCE,
            sub: email,
            exp: now + 300,
            iat: now,
        };
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("rust-edge-auth-test".to_string());
        encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_pem(key.private_pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    fn cloudflare_access_config() -> DashboardAccessConfig {
        DashboardAccessConfig {
            require_auth: true,
            default_role: "viewer".to_string(),
            trusted_headers: TrustedHeaderAccessConfig {
                enabled: true,
                provider: "cloudflare-access".to_string(),
                email_header: "Cf-Access-Authenticated-User-Email".to_string(),
                jwt_header: "Cf-Access-Jwt-Assertion".to_string(),
                team_domain: TEST_TEAM_DOMAIN.to_string(),
                audience: TEST_AUDIENCE.to_string(),
            },
            ..DashboardAccessConfig::default()
        }
    }

    #[test]
    fn claude_access_for_model_keeps_haiku_visible_for_subscription_access() {
        assert_eq!(
            claude_access_for_model("claude-haiku-4-5"),
            vec!["pro", "max", "api"]
        );
        assert_eq!(claude_access_for_model("haiku"), vec!["pro", "max", "api"]);
    }

    #[tokio::test]
    async fn resolve_access_identity_accepts_verified_cloudflare_access_jwt() {
        let _guard = crate::routes::TEST_ENV_LOCK.lock().await;
        clear_cloudflare_test_cache();
        cache_cloudflare_test_key(TEST_TEAM_DOMAIN);

        let access = cloudflare_access_config();
        let assertion = build_cloudflare_assertion("dev@example.com");
        let mut headers = HeaderMap::new();
        headers.insert("Cf-Access-Jwt-Assertion", assertion.parse().unwrap());
        headers.insert(
            "Cf-Access-Authenticated-User-Email",
            "dev@example.com".parse().unwrap(),
        );

        let identity = resolve_access_identity(&headers, &access).await;
        assert!(identity.authenticated);
        assert_eq!(identity.role, Some(AccessRole::Viewer));
        assert_eq!(identity.email.as_deref(), Some("dev@example.com"));
        assert_eq!(identity.provider.as_deref(), Some("cloudflare-access"));

        clear_cloudflare_test_cache();
    }

    #[tokio::test]
    async fn resolve_access_identity_rejects_cloudflare_email_header_mismatch() {
        let _guard = crate::routes::TEST_ENV_LOCK.lock().await;
        clear_cloudflare_test_cache();
        cache_cloudflare_test_key(TEST_TEAM_DOMAIN);

        let access = cloudflare_access_config();
        let assertion = build_cloudflare_assertion("dev@example.com");
        let mut headers = HeaderMap::new();
        headers.insert("Cf-Access-Jwt-Assertion", assertion.parse().unwrap());
        headers.insert(
            "Cf-Access-Authenticated-User-Email",
            "other@example.com".parse().unwrap(),
        );

        let identity = resolve_access_identity(&headers, &access).await;
        assert!(!identity.authenticated);
        assert_eq!(identity.role, None);
        assert_eq!(
            identity.reason.as_deref(),
            Some("Cloudflare Access email header does not match the verified token.")
        );

        clear_cloudflare_test_cache();
    }

    #[tokio::test]
    async fn resolve_access_identity_rejects_misconfigured_cloudflare_access() {
        let _guard = crate::routes::TEST_ENV_LOCK.lock().await;
        clear_cloudflare_test_cache();

        let mut access = cloudflare_access_config();
        access.trusted_headers.team_domain = String::new();

        let assertion = build_cloudflare_assertion("dev@example.com");
        let mut headers = HeaderMap::new();
        headers.insert("Cf-Access-Jwt-Assertion", assertion.parse().unwrap());

        let identity = resolve_access_identity(&headers, &access).await;
        assert!(!identity.authenticated);
        assert_eq!(identity.role, None);
        assert_eq!(
            identity.reason.as_deref(),
            Some("Cloudflare Access is enabled but team domain or audience is missing.")
        );
    }

    #[test]
    fn access_control_ignores_builtin_remote_auth_until_share_links_are_enabled() {
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
        unsafe {
            std::env::set_var("CONDUCTOR_REMOTE_ACCESS_TOKEN", "test-token");
            std::env::set_var("CONDUCTOR_REMOTE_SESSION_SECRET", "test-secret");
        }

        assert!(!access_control_enabled(&DashboardAccessConfig::default()));
        assert!(access_control_enabled(&DashboardAccessConfig {
            allow_signed_share_links: true,
            ..DashboardAccessConfig::default()
        }));

        unsafe {
            std::env::remove_var("CONDUCTOR_REMOTE_ACCESS_TOKEN");
            std::env::remove_var("CONDUCTOR_REMOTE_SESSION_SECRET");
        }
    }

    #[tokio::test]
    async fn resolve_access_identity_rejects_legacy_generic_trusted_headers() {
        let _guard = crate::routes::TEST_ENV_LOCK.lock().await;
        let access = DashboardAccessConfig {
            require_auth: true,
            trusted_headers: TrustedHeaderAccessConfig {
                enabled: true,
                provider: "generic".to_string(),
                email_header: "x-test-email".to_string(),
                jwt_header: String::new(),
                team_domain: String::new(),
                audience: String::new(),
            },
            ..DashboardAccessConfig::default()
        };

        let mut headers = HeaderMap::new();
        headers.insert("x-test-email", "viewer@example.com".parse().unwrap());

        let identity = resolve_access_identity(&headers, &access).await;
        assert!(!identity.authenticated);
        assert_eq!(identity.role, None);
        assert_eq!(
            identity.reason.as_deref(),
            Some("Generic trusted-header mode has been removed. Configure verified Cloudflare Access instead.")
        );
    }

    #[tokio::test]
    async fn resolve_access_identity_accepts_forwarded_proxy_identity() {
        let access = DashboardAccessConfig {
            require_auth: true,
            ..DashboardAccessConfig::default()
        };

        let mut headers = HeaderMap::new();
        headers.insert(super::PROXY_AUTHORIZED_HEADER, "true".parse().unwrap());
        headers.insert(super::PROXY_AUTHENTICATED_HEADER, "false".parse().unwrap());
        headers.insert(super::PROXY_ROLE_HEADER, "admin".parse().unwrap());
        headers.insert(super::PROXY_EMAIL_HEADER, "local".parse().unwrap());
        headers.insert(super::PROXY_PROVIDER_HEADER, "local".parse().unwrap());

        let identity = resolve_access_identity(&headers, &access).await;
        assert!(!identity.authenticated);
        assert_eq!(identity.role, Some(AccessRole::Admin));
        assert_eq!(identity.email.as_deref(), Some("local"));
        assert_eq!(identity.provider.as_deref(), Some("local"));
    }
}
