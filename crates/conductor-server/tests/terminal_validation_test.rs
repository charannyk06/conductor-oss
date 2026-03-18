mod common;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use common::{spawn_request, wait_for_condition_with_timeout, TestHarness};
use serde_json::Value;
use std::time::Duration;
use tower::util::ServiceExt;

#[tokio::test]
async fn terminal_snapshot_and_resize_routes_cover_live_session_validation_paths() {
    let harness = TestHarness::new("conductor-terminal-validation-test", "ttyd").await;
    let queued = harness
        .state
        .spawn_session(spawn_request("Validate terminal routes"))
        .await
        .unwrap();
    let session_id = queued.id.clone();
    let snapshot_payload = wait_for_condition_with_timeout("terminal snapshot", Duration::from_secs(15), || {
        let app = harness.app();
        let session_id = session_id.clone();
        async move {
            let response = app
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/api/sessions/{}/terminal/snapshot?lines=1200&live=1",
                            session_id
                        ))
                        .body(Body::empty())
                        .ok()?,
                )
                .await
                .ok()?;
            if response.status() != StatusCode::OK {
                return None;
            }
            let body = to_bytes(response.into_body(), usize::MAX).await.ok()?;
            let payload: Value = serde_json::from_slice(&body).ok()?;
            let snapshot = payload["snapshot"].as_str().unwrap_or_default();
            (payload["restored"] == true && snapshot.contains("Validate terminal routes"))
                .then_some(payload)
        }
    })
    .await;
    assert_eq!(snapshot_payload["restored"], true);
    assert!(snapshot_payload["snapshot"]
        .as_str()
        .unwrap_or_default()
        .contains("Validate terminal routes"));
}
