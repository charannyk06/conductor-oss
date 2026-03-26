mod common;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use common::{spawn_request, ttyd_available, wait_for_condition, TestHarness};
use conductor_core::types::SessionStatus;
use serde_json::Value;
use tower::util::ServiceExt;

async fn response_json(response: axum::response::Response) -> Value {
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body should be readable");
    serde_json::from_slice(&body).expect("response should be valid JSON")
}

#[tokio::test]
async fn metrics_endpoint_emits_valid_prometheus_samples() {
    let harness = TestHarness::new("conductor-e2e-metrics-test", "ttyd").await;

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri("/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();

    assert!(body.contains("# HELP conductor_sessions_total"));
    assert!(body.contains("conductor_sessions_total "));
    assert!(body.contains("conductor_executors_available "));
    assert!(!body.contains("{{}}"));
}

#[tokio::test]
async fn failed_spawn_is_persisted_and_reported_in_error_health() {
    let harness = TestHarness::new("conductor-e2e-error-test", "ttyd").await;

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "projectId": "missing",
                        "prompt": "Trigger a tracked error",
                        "agent": "codex",
                        "source": "e2e",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri("/api/errors/health?category=spawn_error&limit=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let payload = response_json(response).await;
    assert_eq!(payload["status"], "enabled");
    assert_eq!(payload["category"], "spawn_error");
    assert_eq!(payload["summary"]["total"], 1);
    assert_eq!(payload["summary"]["warning"], 1);
    assert_eq!(payload["summary"]["critical"], 0);
    assert_eq!(payload["recent"][0]["message"], "Unknown project: missing");
}

#[tokio::test]
async fn spawn_session_route_drives_a_live_test_executor() {
    if !ttyd_available() {
        return;
    }

    let harness = TestHarness::new("conductor-e2e-spawn-test", "ttyd").await;

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&spawn_request("Stream the prompt back"))
                        .expect("spawn request should serialize"),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let payload = response_json(response).await;
    let session_id = payload["session"]["id"]
        .as_str()
        .expect("session id should be present")
        .to_string();

    let session = wait_for_condition("live session to reach working state", || {
        let state = harness.state.clone();
        let session_id = session_id.clone();
        async move {
            state
                .get_session(&session_id)
                .await
                .and_then(|session| (session.status == SessionStatus::Working).then_some(session))
        }
    })
    .await;

    assert_eq!(session.status, SessionStatus::Working);
    assert_eq!(session.agent, "codex");

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "message": "hello"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    wait_for_condition("session output to include echoed input", || {
        let app = harness.app();
        let session_id = session_id.clone();
        async move {
            let response = app
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/sessions/{session_id}/output"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .ok()?;
            let payload: Value = response_json(response).await;
            payload["output"]
                .as_str()
                .filter(|output| output.contains("echo:hello"))
                .map(|_| ())
        }
    })
    .await;

    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/kill"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
