use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::config::{
    access_control_enabled, proxy_request_authorized, resolve_access_identity, AccessRole,
};
use crate::state::AppState;

const GLOBAL_RATE_LIMIT_REQUESTS: u64 = 2000;
const GLOBAL_RATE_LIMIT_WINDOW_SECS: u64 = 60;

struct GlobalRateLimitEntry {
    count: u64,
    window_start: Instant,
}

struct GlobalRateLimiter {
    entries: RwLock<HashMap<String, GlobalRateLimitEntry>>,
}

impl GlobalRateLimiter {
    async fn check_rate_limit(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut entries = self.entries.write().await;

        let entry = entries
            .entry(key.to_string())
            .or_insert_with(|| GlobalRateLimitEntry {
                count: 0,
                window_start: now,
            });

        if now.duration_since(entry.window_start)
            >= Duration::from_secs(GLOBAL_RATE_LIMIT_WINDOW_SECS)
        {
            entry.count = 1;
            entry.window_start = now;
            return true;
        }

        if entry.count >= GLOBAL_RATE_LIMIT_REQUESTS {
            return false;
        }

        entry.count += 1;
        true
    }
}

static GLOBAL_RATE_LIMITER: std::sync::LazyLock<GlobalRateLimiter, fn() -> GlobalRateLimiter> =
    std::sync::LazyLock::new(|| GlobalRateLimiter {
        entries: RwLock::new(HashMap::new()),
    });

fn extract_client_ip(request: &Request<Body>) -> String {
    if let Some(forwarded) = request.headers().get("x-forwarded-for") {
        if let Ok(forwarded_str) = forwarded.to_str() {
            return forwarded_str
                .split(',')
                .next()
                .unwrap_or("unknown")
                .trim()
                .to_string();
        }
    }
    if let Some(real_ip) = request.headers().get("x-real-ip") {
        if let Ok(ip_str) = real_ip.to_str() {
            return ip_str.trim().to_string();
        }
    }
    "global".to_string()
}

fn extract_rate_limit_key(request: &Request<Body>) -> String {
    let headers = request.headers();

    if proxy_request_authorized(headers) {
        let provider = headers
            .get("x-conductor-access-provider")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "proxy".to_string());
        let email = headers
            .get("x-conductor-access-email")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "anonymous".to_string());

        return format!("proxy:{provider}:{email}");
    }

    extract_client_ip(request)
}

pub async fn rate_limit_global(
    State(_state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let client_ip = extract_rate_limit_key(&request);

    if !GLOBAL_RATE_LIMITER.check_rate_limit(&client_ip).await {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("Retry-After", "60")],
            axum::Json(serde_json::json!({ "error": "Rate limit exceeded. Try again later." })),
        )
            .into_response();
    }

    next.run(request).await.into_response()
}

pub async fn require_auth_when_remote(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let required = required_access_role(request.method(), request.uri().path());
    if required.is_none() {
        return Ok(next.run(request).await);
    }

    let access = state.config.read().await.access.clone();
    if !access_control_enabled(&access) {
        return Ok(next.run(request).await);
    }

    let headers = request.headers().clone();
    let identity = resolve_access_identity(&headers, &access).await;
    if !identity.authenticated {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let required = required.unwrap_or(AccessRole::Viewer);
    match identity.role {
        Some(role) if role.allows(required) => Ok(next.run(request).await),
        Some(_) => Err(StatusCode::FORBIDDEN),
        None => Err(StatusCode::FORBIDDEN),
    }
}

fn required_access_role(method: &Method, path: &str) -> Option<AccessRole> {
    if *method == Method::OPTIONS || *method == Method::HEAD {
        return None;
    }

    if path == "/api/health" || path == "/api/github/webhook" {
        return None;
    }

    if path.starts_with("/api/sessions/") && path.ends_with("/terminal/token") {
        return Some(AccessRole::Operator);
    }

    if path.starts_with("/api/sessions/")
        && (path.ends_with("/terminal/ttyd") || path.ends_with("/terminal/ttyd/ws"))
    {
        return None;
    }

    if path.starts_with("/api/sessions/") && path.ends_with("/terminal/ttyd/token") {
        return Some(AccessRole::Operator);
    }

    if path.starts_with("/api/access") {
        return Some(AccessRole::Admin);
    }

    if path.starts_with("/api/app-update") {
        return Some(if *method == Method::GET {
            AccessRole::Viewer
        } else {
            AccessRole::Operator
        });
    }

    if path.starts_with("/api/preferences")
        || path.starts_with("/api/repositories")
        || (path.starts_with("/api/workspaces") && *method != Method::GET)
    {
        return Some(if *method == Method::GET {
            AccessRole::Viewer
        } else {
            AccessRole::Admin
        });
    }

    if *method == Method::GET {
        return Some(AccessRole::Viewer);
    }

    Some(AccessRole::Operator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::middleware;
    use axum::routing::{get, post};
    use axum::{response::IntoResponse, Router};
    use conductor_core::config::{
        ConductorConfig, DashboardAccessConfig, TrustedHeaderAccessConfig,
    };
    use conductor_db::Database;
    use tower::util::ServiceExt;

    async fn build_state(access: DashboardAccessConfig) -> Arc<AppState> {
        let config = ConductorConfig {
            workspace: std::env::temp_dir()
                .join(format!("middleware-test-{}", uuid::Uuid::new_v4())),
            access,
            ..ConductorConfig::default()
        };
        let db = Database::in_memory().await.unwrap();
        AppState::new(
            std::env::temp_dir().join("middleware-test.yaml"),
            config,
            db,
        )
        .await
    }

    #[test]
    fn route_policy_protects_live_events_and_session_output() {
        assert_eq!(required_access_role(&Method::GET, "/api/health"), None);
        assert_eq!(
            required_access_role(&Method::POST, "/api/github/webhook"),
            None
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/events"),
            Some(AccessRole::Viewer)
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/app-update"),
            Some(AccessRole::Viewer)
        );
        assert_eq!(
            required_access_role(&Method::POST, "/api/app-update"),
            Some(AccessRole::Operator)
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/health/sessions"),
            Some(AccessRole::Viewer)
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/sessions/abc/output"),
            Some(AccessRole::Viewer)
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/sessions/abc/output/stream"),
            Some(AccessRole::Viewer)
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/sessions/abc/terminal/token"),
            Some(AccessRole::Operator)
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/sessions/abc/terminal/ttyd"),
            None
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/sessions/abc/terminal/ttyd/ws"),
            None
        );
        assert_eq!(
            required_access_role(&Method::GET, "/api/sessions/abc/terminal/ttyd/token"),
            Some(AccessRole::Operator)
        );
    }

    #[test]
    fn rate_limit_key_prefers_proxy_identity_when_available() {
        let request = Request::builder()
            .uri("/api/events")
            .header("x-conductor-proxy-authorized", "true")
            .header("x-conductor-access-provider", "clerk")
            .header("x-conductor-access-email", "viewer@example.com")
            .header("x-forwarded-for", "203.0.113.10")
            .body(Body::empty())
            .unwrap();

        assert_eq!(
            extract_rate_limit_key(&request),
            "proxy:clerk:viewer@example.com"
        );
    }

    #[test]
    fn rate_limit_key_falls_back_to_client_ip_for_untrusted_requests() {
        let request = Request::builder()
            .uri("/api/events")
            .header("x-forwarded-for", "203.0.113.10, 198.51.100.7")
            .header("x-real-ip", "198.51.100.8")
            .body(Body::empty())
            .unwrap();

        assert_eq!(extract_rate_limit_key(&request), "203.0.113.10");
    }

    #[tokio::test]
    async fn middleware_rejects_unauthenticated_view_requests_when_auth_is_required() {
        let state = build_state(DashboardAccessConfig {
            require_auth: true,
            ..DashboardAccessConfig::default()
        })
        .await;

        let app = Router::new()
            .route(
                "/api/events",
                get(|| async { StatusCode::OK.into_response() }),
            )
            .layer(middleware::from_fn_with_state(
                state.clone(),
                require_auth_when_remote,
            ))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn middleware_allows_authenticated_proxy_requests_even_when_runtime_auth_is_required() {
        let state = build_state(DashboardAccessConfig {
            require_auth: true,
            ..DashboardAccessConfig::default()
        })
        .await;

        let app = Router::new()
            .route(
                "/api/preferences",
                get(|| async { StatusCode::OK.into_response() }),
            )
            .layer(middleware::from_fn_with_state(
                state.clone(),
                require_auth_when_remote,
            ))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/preferences")
                    .header("x-conductor-proxy-authorized", "true")
                    .header("x-conductor-access-authenticated", "true")
                    .header("x-conductor-access-role", "viewer")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn middleware_rejects_proxy_requests_without_proxy_authentication() {
        let state = build_state(DashboardAccessConfig {
            require_auth: true,
            ..DashboardAccessConfig::default()
        })
        .await;

        let app = Router::new()
            .route(
                "/api/preferences",
                get(|| async { StatusCode::OK.into_response() }),
            )
            .layer(middleware::from_fn_with_state(
                state.clone(),
                require_auth_when_remote,
            ))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/preferences")
                    .header("x-conductor-proxy-authorized", "true")
                    .header("x-conductor-access-authenticated", "false")
                    .header("x-conductor-access-role", "viewer")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn middleware_rejects_legacy_generic_trusted_headers() {
        let state = build_state(DashboardAccessConfig {
            require_auth: true,
            default_role: "viewer".to_string(),
            trusted_headers: TrustedHeaderAccessConfig {
                enabled: true,
                provider: "generic".to_string(),
                email_header: "x-test-email".to_string(),
                jwt_header: String::new(),
                team_domain: String::new(),
                audience: String::new(),
            },
            ..DashboardAccessConfig::default()
        })
        .await;

        let app = Router::new()
            .route(
                "/api/spawn",
                post(|| async { StatusCode::OK.into_response() }),
            )
            .layer(middleware::from_fn_with_state(
                state.clone(),
                require_auth_when_remote,
            ))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/spawn")
                    .header("x-test-email", "viewer@example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
