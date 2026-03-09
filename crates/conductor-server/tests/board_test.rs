mod common;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{build_app, spawn_request, wait_for_condition, TestExecutor, TestHarness};
use conductor_core::board::Board;
use conductor_core::event::Event;
use conductor_core::types::AgentKind;
use conductor_core::types::SessionStatus;
use conductor_core::EventBus;
use serde_json::Value;
use std::fs;
use std::sync::Arc;
use tower::util::ServiceExt;

#[tokio::test]
async fn board_routes_preserve_task_metadata_across_roundtrip_updates() {
    let harness = TestHarness::new("conductor-board-route-test", "direct").await;
    fs::write(
        &harness.board_path,
        [
            "## Ready to Dispatch",
            "",
            "- [ ] Preserve metadata | id:task-1 | project:demo | type:bug | priority:high | taskRef:DEM-123 | attemptRef:ATT-7 | issueId:42 | githubItemId:gh-99 | attachments:docs/spec.md,images/mock.png | notes:Initial notes",
            "",
            "## Done",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let app = build_app(harness.state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/boards?projectId=demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/boards")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "projectId": "demo",
                        "taskId": "task-1",
                        "role": "done",
                        "title": "Preserve metadata updated"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let app = build_app(harness.state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/boards?projectId=demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    let task = payload["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|column| column["role"] == "done")
        .and_then(|column| column["tasks"].as_array())
        .and_then(|tasks| tasks.first())
        .cloned()
        .unwrap();

    assert_eq!(task["id"], "task-1");
    assert_eq!(task["text"], "Preserve metadata updated");
    assert_eq!(task["type"], "bug");
    assert_eq!(task["priority"], "high");
    assert_eq!(task["taskRef"], "DEM-123");
    assert_eq!(task["attemptRef"], "ATT-7");
    assert_eq!(task["issueId"], "42");
    assert_eq!(task["githubItemId"], "gh-99");
    assert_eq!(task["notes"], "Initial notes");
    assert_eq!(task["attachments"].as_array().unwrap().len(), 2);

    let board_contents = fs::read_to_string(&harness.board_path).unwrap();
    assert!(board_contents.contains("taskRef:DEM-123"));
    assert!(board_contents.contains("attachments:docs/spec.md,images/mock.png"));
}

#[tokio::test]
async fn board_change_events_drive_session_spawns_with_board_metadata() {
    let harness = TestHarness::new("conductor-board-runtime-test", "direct").await;
    harness.state.executors.write().await.insert(
        AgentKind::Codex,
        Arc::new(TestExecutor {
            kind: AgentKind::Codex,
            auto_complete: false,
        }),
    );
    fs::write(
        &harness.board_path,
        [
            "## Ready to Dispatch",
            "",
            "- [ ] Startup dispatch card @agent/codex model:gpt-5 reasoningEffort:high",
            "",
            "## Dispatching",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let event_bus = EventBus::new(16);
    let mut receiver = event_bus.subscribe();

    fs::write(
        &harness.board_path,
        [
            "## Ready to Dispatch",
            "",
            "- [ ] Startup dispatch card @agent/codex model:gpt-5 reasoningEffort:high",
            "- [ ] Trigger watcher refresh @agent/codex model:gpt-5-mini reasoningEffort:medium",
            "",
            "## Dispatching",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let board_path_string = harness.board_path.display().to_string();
    event_bus.publish(Event::BoardChanged {
        project_id: "demo".to_string(),
        path: board_path_string.clone(),
    });
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .expect("timed out waiting for board change event")
        .expect("event bus should stay open");
    assert!(matches!(
        event.as_ref(),
        Event::BoardChanged { project_id, path }
            if project_id == "demo" && path == &board_path_string
    ));

    let board = Board::from_file(&harness.board_path).unwrap();
    let card = board
        .dispatchable_cards()
        .into_iter()
        .find(|card| card.title == "Trigger watcher refresh")
        .unwrap();
    let mut request = spawn_request(&card.title);
    request.model = card.metadata.get("model").cloned();
    request.reasoning_effort = card.metadata.get("reasoningEffort").cloned();
    request.source = "board_dispatch".to_string();

    let queued = harness.state.spawn_session(request).await.unwrap();
    let session = wait_for_condition("board-dispatched session", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == SessionStatus::Working
                    && session.metadata.contains_key("worktree"))
                .then_some(session)
            })
        }
    })
    .await;
    assert_eq!(session.project_id, "demo");
    assert_eq!(
        session.metadata.get("model").map(String::as_str),
        Some("gpt-5-mini")
    );
    assert_eq!(
        session.metadata.get("reasoningEffort").map(String::as_str),
        Some("medium")
    );
}
