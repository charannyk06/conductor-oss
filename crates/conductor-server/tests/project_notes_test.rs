mod common;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use common::TestHarness;
use serde_json::{json, Value};
use tower::util::ServiceExt;

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("response should be valid json")
}

#[tokio::test]
async fn project_notes_routes_list_read_and_save_markdown_files() {
    let harness = TestHarness::new("conductor-project-notes", "direct").await;
    let notes_root = harness.repo.join("notes");
    std::fs::create_dir_all(notes_root.join("architecture")).expect("create notes directories");
    std::fs::write(
        notes_root.join("architecture").join("design.md"),
        "# Design\n\nFirst draft\n",
    )
    .expect("write design note");
    std::fs::write(
        notes_root.join("architecture").join("ignore.ts"),
        "export const ignored = true;\n",
    )
    .expect("write ignored file");

    {
        let mut config = harness.state.config.write().await;
        config.preferences.markdown_editor = "obsidian".to_string();
        config.preferences.markdown_editor_path = notes_root.to_string_lossy().to_string();
    }

    let list_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri("/api/project-notes?projectId=demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("project notes list response");

    assert_eq!(list_response.status(), StatusCode::OK);
    let list_payload = response_json(list_response).await;
    let files = list_payload["files"].as_array().expect("files array");
    assert!(
        files.iter().any(|entry| {
            entry["displayPath"].as_str() == Some("architecture/design.md")
                && entry["source"].as_str() == Some("vault")
        }),
        "expected markdown note from notes root in payload: {list_payload:#}"
    );
    assert!(
        !files
            .iter()
            .any(|entry| entry["displayPath"].as_str() == Some("architecture/ignore.ts")),
        "non-markdown files should be excluded: {list_payload:#}"
    );

    let note_path = notes_root.join("architecture").join("design.md");
    let read_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/project-notes/file?projectId=demo&path={}",
                    url::form_urlencoded::byte_serialize(note_path.to_string_lossy().as_bytes())
                        .collect::<String>()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("project note read response");

    assert_eq!(read_response.status(), StatusCode::OK);
    let read_payload = response_json(read_response).await;
    assert_eq!(
        read_payload["content"].as_str(),
        Some("# Design\n\nFirst draft\n")
    );
    let expected_modified_at = read_payload["modifiedAt"]
        .as_str()
        .expect("modifiedAt should be present")
        .to_string();

    let save_response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/project-notes/file")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "projectId": "demo",
                        "path": note_path.to_string_lossy().to_string(),
                        "content": "# Design\n\nFinal draft\n",
                        "expectedModifiedAt": expected_modified_at,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .expect("project note save response");

    assert_eq!(save_response.status(), StatusCode::OK);
    let saved_text = std::fs::read_to_string(&note_path).expect("updated note on disk");
    assert_eq!(saved_text, "# Design\n\nFinal draft\n");
}

#[tokio::test]
async fn project_notes_routes_reject_stale_writes_and_outside_paths() {
    let harness = TestHarness::new("conductor-project-notes-conflict", "direct").await;
    let notes_root = harness.repo.join("vault");
    std::fs::create_dir_all(&notes_root).expect("create vault root");
    let note_path = notes_root.join("daily.md");
    std::fs::write(&note_path, "# Daily\n\nVersion one\n").expect("write note");
    let outside_path = harness.root.join("outside.md");
    std::fs::write(&outside_path, "outside\n").expect("write outside file");

    {
        let mut config = harness.state.config.write().await;
        config.preferences.markdown_editor = "obsidian".to_string();
        config.preferences.markdown_editor_path = notes_root.to_string_lossy().to_string();
    }

    let read_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/project-notes/file?projectId=demo&path={}",
                    url::form_urlencoded::byte_serialize(note_path.to_string_lossy().as_bytes())
                        .collect::<String>()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("initial note read response");
    assert_eq!(read_response.status(), StatusCode::OK);
    let read_payload = response_json(read_response).await;
    let stale_modified_at = read_payload["modifiedAt"]
        .as_str()
        .expect("modifiedAt should be present")
        .to_string();

    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&note_path, "# Daily\n\nVersion two\n").expect("update note on disk");

    let stale_save_response = harness
        .app()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/project-notes/file")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "projectId": "demo",
                        "path": note_path.to_string_lossy().to_string(),
                        "content": "# Daily\n\nStale write\n",
                        "expectedModifiedAt": stale_modified_at,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .expect("stale save response");

    assert_eq!(stale_save_response.status(), StatusCode::CONFLICT);

    let outside_read_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/project-notes/file?projectId=demo&path={}",
                    url::form_urlencoded::byte_serialize(outside_path.to_string_lossy().as_bytes())
                        .collect::<String>()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("outside file read response");

    assert_eq!(outside_read_response.status(), StatusCode::FORBIDDEN);
}
