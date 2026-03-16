mod common;

use axum::body::to_bytes;
use axum::http::{Request, StatusCode};
use common::{spawn_request, wait_for_condition, TestHarness};
use conductor_server::state::SessionRecord;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::sync::Mutex;
use tower::util::ServiceExt;

/// Serializes tests that modify process-wide environment variables so that
/// concurrent `#[tokio::test]` invocations do not race on `set_var`/`remove_var`.
static ENV_MUTEX: Mutex<()> = Mutex::new(());

fn server_timing_header_value(headers: &axum::http::HeaderMap) -> String {
    headers
        .get_all("server-timing")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(",")
}

async fn bootstrap_session(harness: &TestHarness, prompt: &str) -> SessionRecord {
    let queued = harness
        .state
        .spawn_session(spawn_request(prompt))
        .await
        .unwrap();

    wait_for_condition("session shows startup output", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        let prompt = prompt.to_string();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                session
                    .output
                    .contains(&format!("prompt:{prompt}"))
                    .then_some(session)
            })
        }
    })
    .await
}

async fn enable_terminal_access_control(harness: &TestHarness) {
    let mut config = harness.state.config.write().await;
    config.access.require_auth = true;
    config.access.default_role = "admin".to_string();
}

fn terminal_proxy_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("x-forwarded-host", "127.0.0.1:3000"),
        ("x-conductor-proxy-authorized", "true"),
        ("x-conductor-access-authenticated", "true"),
        ("x-conductor-access-role", "admin"),
        ("x-conductor-access-email", "admin@localhost"),
        ("x-conductor-access-provider", "local-test"),
    ]
}

fn build_remote_session_cookie(secret: &str) -> String {
    type HmacSha256 = Hmac<Sha256>;

    let expires_at = chrono::Utc::now().timestamp_millis() + 7 * 24 * 60 * 60 * 1000;
    let payload = expires_at.to_string();
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("remote session secret is a valid HMAC key");
    mac.update(payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());

    format!("conductor_session={payload}.{signature}")
}

async fn fetch_terminal_token(
    harness: &TestHarness,
    session_id: &str,
    stream_scope: bool,
) -> String {
    let path = if stream_scope {
        format!("/api/sessions/{session_id}/terminal/stream-token")
    } else {
        format!("/api/sessions/{session_id}/terminal/token")
    };

    let mut request_builder = Request::builder().uri(path);
    for (key, value) in terminal_proxy_headers() {
        request_builder = request_builder.header(key, value);
    }
    let response = harness
        .app()
        .oneshot(request_builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["required"].as_bool(), Some(true));
    assert_eq!(payload["expiresInSeconds"].as_i64(), Some(60));

    payload["token"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn terminal_connection_route_returns_connection_contract() {
    let harness = TestHarness::new("conductor-terminal-connection-contract", "direct").await;
    let session = bootstrap_session(&harness, "connection contract").await;

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions/{}/terminal/connection", session.id))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    assert_eq!(
        headers
            .get("x-conductor-terminal-transport")
            .and_then(|value| value.to_str().ok()),
        Some("eventstream")
    );
    assert_eq!(
        headers
            .get("x-conductor-terminal-connection-path")
            .and_then(|value| value.to_str().ok()),
        Some("dashboard_proxy")
    );
    assert_eq!(
        headers
            .get("x-conductor-terminal-interactive")
            .and_then(|value| value.to_str().ok()),
        Some("true")
    );
    let server_timing = server_timing_header_value(headers);
    assert!(server_timing.contains("terminal_connection"));

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["transport"].as_str(), Some("eventstream"));
    assert_eq!(payload["interactive"].as_bool(), Some(true));
    assert!(payload["stream"].is_object());
    assert!(payload["control"].is_object());
}

#[tokio::test]
async fn terminal_connection_route_returns_token_contract_when_access_control_is_enabled() {
    let harness = TestHarness::new("conductor-terminal-connection-token-contract", "direct").await;
    enable_terminal_access_control(&harness).await;
    let session = bootstrap_session(&harness, "connection token contract").await;

    let mut request_builder =
        Request::builder().uri(format!("/api/sessions/{}/terminal/connection", session.id));
    for (key, value) in terminal_proxy_headers() {
        request_builder = request_builder.header(key, value);
    }
    let response = harness
        .app()
        .oneshot(request_builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    assert_eq!(
        headers
            .get("x-conductor-terminal-transport")
            .and_then(|value| value.to_str().ok()),
        Some("websocket")
    );
    assert_eq!(
        headers
            .get("x-conductor-terminal-connection-path")
            .and_then(|value| value.to_str().ok()),
        Some("direct")
    );

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["requiresToken"].as_bool(), Some(true));
    assert_eq!(payload["interactive"].as_bool(), Some(true));
    assert_eq!(payload["control"]["requiresToken"].as_bool(), Some(true));
    assert_eq!(payload["stream"]["transport"].as_str(), Some("websocket"));
    assert_eq!(payload["control"]["transport"].as_str(), Some("websocket"));
    assert!(
        payload["stream"]["wsUrl"]
            .as_str()
            .unwrap_or("")
            .contains("?token="),
        "stream wsUrl should include an access token"
    );
    assert!(
        payload["control"]["wsUrl"]
            .as_str()
            .unwrap_or("")
            .contains("?token="),
        "control wsUrl should include an access token"
    );
    assert_eq!(payload["tokenExpiresInSeconds"].as_i64(), Some(60));
    assert!(payload["wsUrl"].as_str().unwrap_or("").contains("?token="));
}

#[tokio::test]
async fn terminal_bootstrap_route_returns_payload_and_headers() {
    let harness = TestHarness::new("conductor-terminal-bootstrap-contract", "direct").await;
    let session = bootstrap_session(&harness, "bootstrap contract").await;

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/{}/terminal/bootstrap?lines=40",
                    session.id
                ))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    assert_eq!(
        headers
            .get("x-conductor-terminal-transport")
            .and_then(|value| value.to_str().ok()),
        Some("eventstream")
    );
    assert_eq!(
        headers
            .get("x-conductor-terminal-connection-path")
            .and_then(|value| value.to_str().ok()),
        Some("dashboard_proxy")
    );
    let server_timing = server_timing_header_value(headers);
    assert!(server_timing.contains("terminal_connection"));
    assert!(server_timing.contains("terminal_snapshot"));

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert!(payload["connection"].is_object());
    assert!(payload["snapshot"].is_object());
    assert!(payload["runtime"].is_object());
    assert_eq!(
        payload["connection"]["transport"].as_str(),
        Some("eventstream")
    );
    assert!(payload["snapshot"]["restored"].as_bool().unwrap_or(false));
}

#[tokio::test]
async fn terminal_bootstrap_route_returns_token_contract_when_access_control_is_enabled() {
    let harness = TestHarness::new("conductor-terminal-bootstrap-token-contract", "direct").await;
    enable_terminal_access_control(&harness).await;
    let session = bootstrap_session(&harness, "bootstrap token contract").await;

    let mut request_builder = Request::builder().uri(format!(
        "/api/sessions/{}/terminal/bootstrap?lines=40",
        session.id
    ));
    for (key, value) in terminal_proxy_headers() {
        request_builder = request_builder.header(key, value);
    }
    let response = harness
        .app()
        .oneshot(request_builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    assert_eq!(
        headers
            .get("x-conductor-terminal-transport")
            .and_then(|value| value.to_str().ok()),
        Some("websocket")
    );
    assert_eq!(
        headers
            .get("x-conductor-terminal-connection-path")
            .and_then(|value| value.to_str().ok()),
        Some("direct")
    );

    let server_timing = server_timing_header_value(headers);
    assert!(server_timing.contains("terminal_connection"));
    assert!(server_timing.contains("terminal_snapshot"));

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    let connection = &payload["connection"];
    assert!(connection.is_object());
    assert_eq!(connection["requiresToken"].as_bool(), Some(true));
    assert_eq!(connection["interactive"].as_bool(), Some(true));
    assert_eq!(
        connection["stream"]["transport"].as_str(),
        Some("websocket")
    );
    assert_eq!(
        connection["control"]["transport"].as_str(),
        Some("websocket")
    );
    assert_eq!(connection["requiresToken"].as_bool(), Some(true));
    assert!(
        connection["stream"]["wsUrl"]
            .as_str()
            .unwrap_or("")
            .contains("?token="),
        "stream wsUrl should include an access token"
    );
    assert!(
        connection["control"]["wsUrl"]
            .as_str()
            .unwrap_or("")
            .contains("?token="),
        "control wsUrl should include an access token"
    );
    assert_eq!(connection["tokenExpiresInSeconds"].as_i64(), Some(60));
    assert!(payload["snapshot"].is_object());
    assert!(payload["runtime"].is_object());
}

#[tokio::test]
async fn terminal_stream_endpoint_requires_token_when_access_control_is_enabled() {
    let harness = TestHarness::new("conductor-terminal-stream-token-contract", "direct").await;
    enable_terminal_access_control(&harness).await;
    {
        let mut config = harness.state.config.write().await;
        config.access.allow_signed_share_links = true;
    }
    let remote_access_token = "test-token";
    let remote_session_secret = "test-secret";

    // Acquire the env mutex to serialize access to process-wide env vars
    // across concurrent test threads.
    let _env_guard = ENV_MUTEX.lock().unwrap();
    unsafe {
        std::env::set_var("CONDUCTOR_REMOTE_ACCESS_TOKEN", remote_access_token);
        std::env::set_var("CONDUCTOR_REMOTE_SESSION_SECRET", remote_session_secret);
    }
    let remote_session_cookie = build_remote_session_cookie(remote_session_secret);

    let session = bootstrap_session(&harness, "stream token contract").await;

    let mut request_builder =
        Request::builder().uri(format!("/api/sessions/{}/terminal/stream", session.id));
    request_builder = request_builder.header("cookie", remote_session_cookie.as_str());
    let response_without_token = harness
        .app()
        .oneshot(request_builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response_without_token.status(), StatusCode::UNAUTHORIZED);

    let mut request_builder = Request::builder().uri(format!(
        "/api/sessions/{}/terminal/stream?token=bad-token",
        session.id
    ));
    request_builder = request_builder.header("cookie", remote_session_cookie.as_str());
    let invalid_token_response = harness
        .app()
        .oneshot(request_builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(invalid_token_response.status(), StatusCode::UNAUTHORIZED);

    let stream_token = fetch_terminal_token(&harness, &session.id, true).await;
    let mut request_builder = Request::builder().uri(format!(
        "/api/sessions/{}/terminal/stream?token={}",
        session.id, stream_token
    ));
    request_builder = request_builder.header("cookie", remote_session_cookie.as_str());
    let response_with_valid_token = harness
        .app()
        .oneshot(request_builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response_with_valid_token.status(), StatusCode::OK);
    assert!(response_with_valid_token
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .starts_with("text/event-stream"));

    unsafe {
        std::env::remove_var("CONDUCTOR_REMOTE_ACCESS_TOKEN");
        std::env::remove_var("CONDUCTOR_REMOTE_SESSION_SECRET");
    }
}

#[tokio::test]
async fn terminal_token_endpoints_return_tokens_when_access_control_is_enabled() {
    let harness = TestHarness::new("conductor-terminal-token-contract", "direct").await;
    enable_terminal_access_control(&harness).await;
    let session = bootstrap_session(&harness, "token endpoint contract").await;

    let control_token = fetch_terminal_token(&harness, &session.id, false).await;
    let stream_token = fetch_terminal_token(&harness, &session.id, true).await;

    assert_ne!(control_token, stream_token);
    assert!(!control_token.is_empty());
    assert!(!stream_token.is_empty());
}

#[tokio::test]
async fn terminal_contract_routes_return_404_for_missing_sessions() {
    let harness = TestHarness::new("conductor-terminal-route-404", "direct").await;

    let connection_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri("/api/sessions/missing-session/terminal/connection")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(connection_response.status(), StatusCode::NOT_FOUND);

    let bootstrap_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri("/api/sessions/missing-session/terminal/bootstrap")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bootstrap_response.status(), StatusCode::NOT_FOUND);
}
