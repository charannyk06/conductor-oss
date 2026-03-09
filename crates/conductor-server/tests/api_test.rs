mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{spawn_request, wait_for_condition, TestExecutor, TestHarness};
use conductor_core::types::AgentKind;
use std::sync::Arc;
use tower::util::ServiceExt;

#[tokio::test]
async fn smoke_all_route_modules() {
    let harness = TestHarness::new("conductor-api-test", "direct").await;
    harness.state.executors.write().await.insert(
        AgentKind::Codex,
        Arc::new(TestExecutor {
            kind: AgentKind::Codex,
            auto_complete: false,
        }),
    );
    let queued = harness
        .state
        .spawn_session(spawn_request("Smoke the session routes"))
        .await
        .unwrap();
    let session = wait_for_condition("session workspace", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state
                .get_session(&session_id)
                .await
                .and_then(|session| session.metadata.contains_key("worktree").then_some(session))
        }
    })
    .await;

    let requests = vec![
        (
            Request::builder()
                .uri("/api/app-update")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/config")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/events")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/sessions")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri(format!("/api/sessions/{}/files", session.id))
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/repositories")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/workspaces")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri(format!(
                    "/api/workspaces/branches?path={}",
                    harness.repo.to_string_lossy()
                ))
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri(format!(
                    "/api/filesystem/directory?path={}",
                    harness.root.to_string_lossy()
                ))
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/context-files?projectId=demo")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/boards?projectId=demo")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .method("POST")
                .uri("/api/github/webhook")
                .body(Body::from("{}"))
                .unwrap(),
            StatusCode::BAD_REQUEST,
        ),
        (
            Request::builder()
                .uri("/api/notifications")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/projects")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .uri("/api/tasks?project_id=demo")
                .body(Body::empty())
                .unwrap(),
            StatusCode::OK,
        ),
        (
            Request::builder()
                .method("POST")
                .uri("/api/auth/session")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"token":"disabled"}"#))
                .unwrap(),
            StatusCode::NOT_FOUND,
        ),
    ];

    for (request, expected) in requests {
        let response = harness.app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected);
    }

    let multipart = "--boundary\r\nContent-Disposition: form-data; name=\"projectId\"\r\n\r\ndemo\r\n--boundary--\r\n";
    let response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/attachments")
                .header("content-type", "multipart/form-data; boundary=boundary")
                .body(Body::from(multipart))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
