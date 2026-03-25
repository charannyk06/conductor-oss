mod common;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use common::{ttyd_available, TestExecutor, TestHarness};
use conductor_core::types::AgentKind;
use serde_json::Value;
use std::fs;
use std::sync::Arc;
use tower::util::ServiceExt;

#[tokio::test]
async fn spawn_session_links_board_task_context_and_attachment_paths() {
    if !ttyd_available() {
        return;
    }

    let harness = TestHarness::new("conductor-spawn-context-test", "ttyd").await;
    harness.state.executors.write().await.insert(
        AgentKind::Codex,
        Arc::new(TestExecutor {
            kind: AgentKind::Codex,
            auto_complete: false,
        }),
    );

    let vault_root = harness.root.join("obsidian-vault");
    fs::create_dir_all(vault_root.join("notes")).unwrap();
    fs::create_dir_all(vault_root.join("images")).unwrap();

    let note_path = vault_root.join("notes/linked.md");
    let image_path = vault_root.join("images/mock.png");
    fs::write(
        &note_path,
        "# Linked note\n\nThis note should be visible to the agent.",
    )
    .unwrap();
    fs::write(&image_path, b"not-a-real-png").unwrap();

    {
        let mut config = harness.state.config.write().await;
        config.preferences.markdown_editor_path = vault_root.to_string_lossy().to_string();
    }

    fs::write(
        &harness.board_path,
        [
            "## Inbox",
            "",
            "## Ready to Dispatch",
            "",
            &format!(
                "- [ ] Launch linked task - confirm attachments | id:task-linked | project:demo | taskRef:DEM-123 | notes:Use the linked note and image when launching. | attachments:{},{}",
                note_path.to_string_lossy(),
                image_path.to_string_lossy()
            ),
            "",
            "## Done",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let request = Request::builder()
        .method("POST")
        .uri("/api/sessions")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "projectId": "demo",
                "issueId": "DEM-123",
                "prompt": "Launch it",
                "agent": "codex",
            })
            .to_string(),
        ))
        .unwrap();

    let response = harness.app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let payload: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let session_id = payload["session"]["id"].as_str().unwrap();
    let session = harness.state.get_session(session_id).await.unwrap();

    assert!(session
        .prompt
        .contains("This note should be visible to the agent."));
    assert!(session.prompt.contains("Image attachment"));
    assert!(session.prompt.contains("Launch it"));
    assert!(!session.prompt.contains("\n\nAttachments:\n"));
    assert_eq!(
        session.metadata.get("taskId").map(String::as_str),
        Some("task-linked")
    );
    assert_eq!(
        session.metadata.get("taskRef").map(String::as_str),
        Some("DEM-123")
    );
    assert!(session.metadata.contains_key("briefPath"));
}
