mod common;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{
    build_app, build_state, seed_git_repo, spawn_request, ttyd_available, wait_for_condition,
    TestExecutor, TestHarness,
};
use conductor_core::board::Board;
use conductor_core::config::ProjectConfig;
use conductor_core::event::Event;
use conductor_core::types::AgentKind;
use conductor_core::types::SessionStatus;
use conductor_core::EventBus;
use serde_json::json;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tower::util::ServiceExt;
use uuid::Uuid;

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("conductor-board-route-{label}-{}", Uuid::new_v4()))
}

#[tokio::test]
async fn dispatcher_task_routes_create_update_and_handoff_deterministically() {
    let harness = TestHarness::new("dispatcher-task-lifecycle-route-test", "ttyd").await;
    fs::write(
        &harness.board_path,
        ["## To do", "", "## Ready", "", "## In review", ""].join("\n"),
    )
    .unwrap();
    let app = build_app(harness.state.clone());
    let dispatcher_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/projects/demo/dispatcher")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "forceNew": false,
                        "implementationAgent": "codex"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(dispatcher_response.status(), StatusCode::CREATED);
    let dispatcher_body = axum::body::to_bytes(dispatcher_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let dispatcher_payload: Value = serde_json::from_slice(&dispatcher_body).unwrap();
    let thread_id = dispatcher_payload["thread"]["id"]
        .as_str()
        .expect("dispatcher thread id should be present")
        .to_string();

    let create_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/projects/demo/dispatcher/tasks?threadId={}",
                    thread_id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "title": "Phase 2 heartbeat integration",
                        "contextNotes": "Heartbeat follow-up should stay visible on the board.",
                        "objective": "Create the next dispatcher follow-up task explicitly.",
                        "executionMode": "worktree",
                        "surfaces": ["crates/conductor-server/src/state/acp_dispatcher.rs"],
                        "acceptance": ["A ready-to-launch follow-up task exists on the board."],
                        "skills": ["rust", "dispatcher orchestration"],
                        "deliverables": ["launch-ready follow-up task"],
                        "role": "intake"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let create_status = create_response.status();
    let create_body = axum::body::to_bytes(create_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(create_status, StatusCode::CREATED);
    let create_payload: Value = serde_json::from_slice(&create_body).unwrap();
    assert_eq!(create_payload["operation"], "create");
    let created_task_ref = create_payload["task"]["taskRef"]
        .as_str()
        .expect("task ref should be present")
        .to_string();

    let update_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/projects/demo/dispatcher/tasks/{}?threadId={}",
                    created_task_ref, thread_id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "title": "Phase 2 heartbeat follow-up",
                        "contextNotes": "Keep the heartbeat contract explicit and board-visible.",
                        "role": "review",
                        "taskType": "review",
                        "executionMode": "main_workspace",
                        "surfaces": [
                            "crates/conductor-server/src/state/acp_dispatcher.rs",
                            "crates/conductor-server/src/mcp.rs"
                        ],
                        "reviewRefs": ["docs/dispatcher-audit.md"],
                        "acceptance": ["The review task preserves the heartbeat-style follow-up contract."],
                        "skills": ["rust", "dispatcher review"],
                        "deliverables": ["review notes", "handoff recommendation"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(update_response.status(), StatusCode::OK);
    let update_body = axum::body::to_bytes(update_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let update_payload: Value = serde_json::from_slice(&update_body).unwrap();
    assert_eq!(update_payload["operation"], "update");
    assert_eq!(update_payload["task"]["taskRef"], created_task_ref);
    assert_eq!(update_payload["task"]["role"], "review");

    let handoff_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/projects/demo/dispatcher/tasks/{}/handoff?threadId={}",
                    created_task_ref, thread_id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "contextNotes": "Ready to hand off to an implementation worker.",
                        "taskType": "feature",
                        "executionMode": "worktree",
                        "surfaces": ["crates/conductor-server/src/state/acp_dispatcher.rs"],
                        "acceptance": ["Worker can launch directly from the card without reopening dispatcher chat."],
                        "skills": ["rust", "dispatcher orchestration"],
                        "deliverables": ["implemented heartbeat lifecycle task"]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(handoff_response.status(), StatusCode::OK);
    let handoff_body = axum::body::to_bytes(handoff_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let handoff_payload: Value = serde_json::from_slice(&handoff_body).unwrap();
    assert_eq!(handoff_payload["operation"], "handoff");
    assert_eq!(handoff_payload["task"]["taskRef"], created_task_ref);
    assert_eq!(handoff_payload["task"]["role"], "ready");

    let feed_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/projects/demo/dispatcher/feed?threadId={}",
                    thread_id
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(feed_response.status(), StatusCode::OK);
    let feed_body = axum::body::to_bytes(feed_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let feed_payload: Value = serde_json::from_slice(&feed_body).unwrap();
    let lifecycle_events = feed_payload["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["metadata"]["eventType"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        lifecycle_events,
        vec![
            "dispatcher_task_created",
            "dispatcher_task_updated",
            "dispatcher_task_handed_off"
        ]
    );

    let board_contents = fs::read_to_string(&harness.board_path).unwrap();
    assert!(board_contents.contains("taskRef:"));
    assert!(board_contents.contains("Phase 2 heartbeat follow-up"));
    let ready_block = board_contents
        .split("## Ready")
        .nth(1)
        .expect("ready block should exist");
    assert!(ready_block.contains(&created_task_ref));
}

#[tokio::test]
async fn board_routes_preserve_task_metadata_across_roundtrip_updates() {
    let harness = TestHarness::new("conductor-board-route-test", "ttyd").await;
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
async fn board_routes_reorder_cards_with_target_index() {
    let harness = TestHarness::new("conductor-board-reorder-test", "ttyd").await;
    fs::write(
        &harness.board_path,
        [
            "## Ready to Dispatch",
            "",
            "- [ ] First ready task | id:task-1 | project:demo",
            "- [ ] Second ready task | id:task-2 | project:demo",
            "",
            "## In Progress",
            "",
            "- [ ] Existing in progress | id:task-3 | project:demo",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let app = build_app(harness.state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/boards")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "projectId": "demo",
                        "taskId": "task-2",
                        "role": "inProgress",
                        "targetIndex": 0
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let board_contents = fs::read_to_string(&harness.board_path).unwrap();
    let in_progress_block = board_contents
        .split("## In Progress")
        .nth(1)
        .expect("in progress block should exist");
    let moved_index = in_progress_block
        .find("task-2")
        .expect("moved task should be present");
    let existing_index = in_progress_block
        .find("task-3")
        .expect("existing task should be present");
    assert!(moved_index < existing_index);
}

#[tokio::test]
async fn board_routes_reorder_cards_within_same_column_with_target_index() {
    let harness = TestHarness::new("conductor-board-same-column-reorder-test", "ttyd").await;
    fs::write(
        &harness.board_path,
        [
            "# Conductor Board",
            "",
            "## To do",
            "",
            "- [ ] First intake task | id:task-1 | project:demo",
            "- [ ] Second intake task | id:task-2 | project:demo",
            "",
            "## Ready",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let app = build_app(harness.state.clone());
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
                        "role": "intake",
                        "targetIndex": 1
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let board_contents = fs::read_to_string(&harness.board_path).unwrap();
    let intake_block = board_contents
        .split("## To do")
        .nth(1)
        .expect("intake block should exist");
    let first_index = intake_block
        .find("task-1")
        .expect("moved task should be present");
    let second_index = intake_block
        .find("task-2")
        .expect("existing task should be present");
    assert!(second_index < first_index);
}

#[tokio::test]
async fn board_routes_prefer_project_repo_board_outside_workspace() {
    let workspace = temp_path("workspace");
    let repo = temp_path("repo");
    fs::create_dir_all(&workspace).unwrap();
    seed_git_repo(&repo);
    fs::write(
        workspace.join("CONDUCTOR.md"),
        [
            "# Workspace Board",
            "",
            "## To do",
            "",
            "- [ ] Workspace-only task | id:workspace-task | project:demo",
            "",
        ]
        .join("\n"),
    )
    .unwrap();
    fs::write(
        repo.join("CONDUCTOR.md"),
        [
            "# Repo Board",
            "",
            "## Ready to Dispatch",
            "",
            "- [ ] Repo task | id:repo-task | project:demo | taskRef:DEM-999",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let project = ProjectConfig {
        path: repo.to_string_lossy().to_string(),
        board_dir: repo
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string),
        agent: Some("codex".to_string()),
        runtime: Some("ttyd".to_string()),
        default_branch: "main".to_string(),
        ..ProjectConfig::default()
    };
    let state = build_state(&workspace, project, "demo").await;
    let app = build_app(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/boards?projectId=demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    let task_ids = payload["columns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|column| column["tasks"].as_array().into_iter().flatten())
        .filter_map(|task| task["id"].as_str())
        .collect::<Vec<_>>();

    assert!(task_ids.contains(&"repo-task"));
    assert!(!task_ids.contains(&"workspace-task"));

    let _ = fs::remove_dir_all(&workspace);
    let _ = fs::remove_dir_all(&repo);
}

#[tokio::test]
async fn board_change_events_drive_session_spawns_with_board_metadata() {
    if !ttyd_available() {
        return;
    }
    let harness = TestHarness::new("conductor-board-runtime-test", "ttyd").await;
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
