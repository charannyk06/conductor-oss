use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

use super::config::{access_control_enabled, resolve_access_identity, AccessRole};
use crate::state::AppState;

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
        return None;
    }

    if path.starts_with("/api/access") {
        return Some(AccessRole::Admin);
    }

    if path.starts_with("/api/app-update") {
        return Some(if *method == Method::GET {
            AccessRole::Viewer
        } else {
            AccessRole::Admin
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
            Some(AccessRole::Admin)
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
            None
        );
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
