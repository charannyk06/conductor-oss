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
async fn project_notes_graph_and_backlinks_use_fallback_project_roots_when_notes_root_is_unset() {
    let harness = TestHarness::new("conductor-project-notes-fallback", "direct").await;
    let notes_dir = harness.repo.join("architecture");
    std::fs::create_dir_all(&notes_dir).expect("create fallback notes directory");
    let design_path = notes_dir.join("design.md");
    let overview_path = notes_dir.join("overview.md");
    std::fs::write(
        &design_path,
        "# Design\n\nThe detailed plan lives in [[overview]].\n",
    )
    .expect("write design note");
    std::fs::write(
        &overview_path,
        "# Overview\n\nReferences [[design]] for the detailed implementation.\n",
    )
    .expect("write overview note");
    let design_path = design_path
        .canonicalize()
        .expect("canonicalize design note path");
    let overview_path = overview_path
        .canonicalize()
        .expect("canonicalize overview note path");

    {
        let mut config = harness.state.config.write().await;
        config.preferences.markdown_editor = "obsidian".to_string();
        config.preferences.markdown_editor_path.clear();
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
        .expect("fallback project notes list response");
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_payload = response_json(list_response).await;
    assert_eq!(list_payload["notesRoot"].as_str(), None);
    let files = list_payload["files"].as_array().expect("files array");
    assert!(
        files
            .iter()
            .any(|entry| entry["displayPath"].as_str() == Some("architecture/design.md")),
        "expected fallback project note in list payload: {list_payload:#}"
    );

    let graph_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri("/api/project-notes/graph?projectId=demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("fallback notes graph response");
    assert_eq!(graph_response.status(), StatusCode::OK);
    let graph_payload = response_json(graph_response).await;
    let graph_nodes = graph_payload["nodes"]
        .as_array()
        .expect("graph nodes array");
    let graph_edges = graph_payload["edges"]
        .as_array()
        .expect("graph edges array");
    assert!(
        graph_nodes
            .iter()
            .any(|node| node["id"].as_str() == Some(design_path.to_string_lossy().as_ref())),
        "expected fallback graph node for design note: {graph_payload:#}"
    );
    assert!(
        graph_nodes
            .iter()
            .any(|node| node["id"].as_str() == Some(overview_path.to_string_lossy().as_ref())),
        "expected fallback graph node for overview note: {graph_payload:#}"
    );
    assert!(
        graph_edges.iter().any(|edge| {
            edge["source"].as_str() == Some(design_path.to_string_lossy().as_ref())
                && edge["target"].as_str() == Some(overview_path.to_string_lossy().as_ref())
        }),
        "expected fallback graph edge for wikilinked notes: {graph_payload:#}"
    );

    let backlinks_response = harness
        .app()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/project-notes/backlinks?projectId=demo&path={}",
                    url::form_urlencoded::byte_serialize(
                        overview_path.to_string_lossy().as_bytes()
                    )
                    .collect::<String>()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("fallback backlinks response");
    assert_eq!(backlinks_response.status(), StatusCode::OK);
    let backlinks_payload = response_json(backlinks_response).await;
    let backlinks = backlinks_payload["backlinks"]
        .as_array()
        .expect("backlinks array");
    assert!(
        backlinks
            .iter()
            .any(|entry| entry["path"].as_str() == Some(design_path.to_string_lossy().as_ref())),
        "expected backlink from fallback project note: {backlinks_payload:#}"
    );
    let forward_links = backlinks_payload["forwardLinks"]
        .as_array()
        .expect("forward links array");
    assert!(
        forward_links
            .iter()
            .any(|entry| entry.as_str() == Some("design")),
        "expected forward link extracted from fallback project note: {backlinks_payload:#}"
    );
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

    std::fs::write(&note_path, "# Daily\n\nVersion two\n").expect("update note on disk");
    let wait_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut observed_modified_at = stale_modified_at.clone();
    while tokio::time::Instant::now() < wait_deadline {
        let poll_response = harness
            .app()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/project-notes/file?projectId=demo&path={}",
                        url::form_urlencoded::byte_serialize(
                            note_path.to_string_lossy().as_bytes()
                        )
                        .collect::<String>()
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("poll note read response");
        let poll_payload = response_json(poll_response).await;
        observed_modified_at = poll_payload["modifiedAt"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if observed_modified_at != stale_modified_at {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_ne!(
        observed_modified_at, stale_modified_at,
        "note modifiedAt should change before attempting stale save"
    );

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
