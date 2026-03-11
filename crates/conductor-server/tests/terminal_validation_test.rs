mod common;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use common::{spawn_request, wait_for_condition, TestHarness};
use serde_json::Value;
use tower::util::ServiceExt;

#[tokio::test]
async fn terminal_snapshot_and_resize_routes_cover_live_session_validation_paths() {
    let harness = TestHarness::new("conductor-terminal-validation-test", "direct").await;
    let queued = harness
        .state
        .spawn_session(spawn_request("Validate terminal routes"))
        .await
        .unwrap();
    let session = wait_for_condition("terminal-ready session", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                session
                    .output
                    .contains("prompt:Validate terminal routes")
                    .then_some(session)
            })
        }
    })
    .await;

    let snapshot_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/{}/terminal/snapshot?lines=1200&live=1",
                    session.id
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot_response.status(), StatusCode::OK);
    let snapshot_body = to_bytes(snapshot_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let snapshot_payload: Value = serde_json::from_slice(&snapshot_body).unwrap();
    assert_eq!(snapshot_payload["restored"], true);
    assert!(snapshot_payload["snapshot"]
        .as_str()
        .unwrap_or_default()
        .contains("Validate terminal routes"));

    let resize_response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{}/terminal/resize", session.id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"cols":90,"rows":24}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resize_response.status(), StatusCode::OK);
    let resize_body = to_bytes(resize_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let resize_payload: Value = serde_json::from_slice(&resize_body).unwrap();
    assert_eq!(resize_payload["ok"], true);
    assert_eq!(resize_payload["sessionId"], session.id);
}
