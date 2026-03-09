mod common;

use common::{
    spawn_request, wait_for_condition, TestExecutor, TestHarness, TmuxResumeExecutor,
};
use conductor_core::types::AgentKind;
use std::sync::Arc;

#[tokio::test]
async fn archive_restore_and_kill_cover_session_lifecycle_transitions() {
    let harness = TestHarness::new("conductor-session-test", "direct").await;
    harness.state.executors.write().await.insert(
        AgentKind::Codex,
        Arc::new(TestExecutor {
            kind: AgentKind::Codex,
            auto_complete: false,
        }),
    );

    let queued = harness
        .state
        .spawn_session(spawn_request("Keep this session alive"))
        .await
        .unwrap();
    let session = wait_for_condition("live session", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == "working" && session.metadata.contains_key("worktree"))
                    .then_some(session)
            })
        }
    })
    .await;

    harness
        .state
        .send_to_session(
            &session.id,
            "Continue with detail".to_string(),
            Vec::new(),
            Some("gpt-5.4".to_string()),
            Some("high".to_string()),
            "follow_up",
        )
        .await
        .unwrap();

    let updated = wait_for_condition("echoed follow-up", || {
        let state = harness.state.clone();
        let session_id = session.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                session
                    .output
                    .contains("echo:Continue with detail")
                    .then_some(session)
            })
        }
    })
    .await;
    assert!(updated
        .conversation
        .iter()
        .any(|entry| entry.kind == "system_message" && entry.source == "session_preferences"));

    harness.state.kill_session(&session.id).await.unwrap();
    let killed = wait_for_condition("killed session", || {
        let state = harness.state.clone();
        let session_id = session.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == "killed").then_some(session)
            })
        }
    })
    .await;
    assert_eq!(killed.activity.as_deref(), Some("exited"));

    let queued = harness
        .state
        .spawn_session(spawn_request("Archive then restore"))
        .await
        .unwrap();
    let archivable = wait_for_condition("archivable session", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == "working" && session.metadata.contains_key("worktree"))
                    .then_some(session)
            })
        }
    })
    .await;

    let worktree = archivable.metadata["worktree"].clone();
    harness.state.archive_session(&archivable.id).await.unwrap();
    let archived = wait_for_condition("archived session", || {
        let state = harness.state.clone();
        let session_id = archivable.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == "archived").then_some(session)
            })
        }
    })
    .await;
    assert_eq!(archived.summary.as_deref(), Some("Archived"));
    assert!(!std::path::Path::new(&worktree).exists());

    let restored = harness.state.restore_session(&archived.id).await.unwrap();
    let resumed = wait_for_condition("restored session to launch", || {
        let state = harness.state.clone();
        let session_id = restored.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == "working" || session.status == "needs_input")
                    .then_some(session)
            })
        }
    })
    .await;
    assert_ne!(resumed.id, archived.id);
    assert_eq!(resumed.project_id, "demo");
    assert_eq!(resumed.prompt, "Archive then restore");
}

#[tokio::test]
async fn resume_session_restores_tmux_runtime_when_live_handle_is_missing() {
    if tokio::process::Command::new("tmux")
        .arg("-V")
        .output()
        .await
        .is_err()
    {
        return;
    }
    let probe_socket = std::env::temp_dir().join(format!("conductor-tmux-probe-{}.sock", uuid::Uuid::new_v4()));
    let probe_output = tokio::process::Command::new("tmux")
        .args(["-S", &probe_socket.to_string_lossy(), "start-server"])
        .output()
        .await;
    let tmux_runtime_supported = matches!(probe_output, Ok(ref output) if output.status.success());
    if tmux_runtime_supported {
        let _ = tokio::process::Command::new("tmux")
            .args(["-S", &probe_socket.to_string_lossy(), "kill-server"])
            .output()
            .await;
    } else {
        return;
    }

    let harness = TestHarness::new("conductor-session-resume-test", "tmux").await;
    harness
        .state
        .executors
        .write()
        .await
        .insert(AgentKind::Codex, Arc::new(TmuxResumeExecutor));

    let queued = harness
        .state
        .spawn_session(spawn_request("Start tmux runtime"))
        .await
        .unwrap();
    let session = wait_for_condition("tmux runtime session", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                let is_tmux = session
                    .metadata
                    .get("runtimeMode")
                    .filter(|value| value.as_str() == "tmux")
                    .is_some();
                if is_tmux {
                    Some(session)
                } else {
                    None
                }
            })
        }
    })
    .await;

    harness.state.live_sessions.write().await.remove(&session.id);

    harness
        .state
        .resume_session_with_prompt(
            &session.id,
            "Continue after reconnect".to_string(),
            Vec::new(),
            None,
            None,
            "follow_up",
        )
        .await
        .unwrap();

    let updated = wait_for_condition("resumed tmux session output", || {
        let state = harness.state.clone();
        let session_id = session.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                session
                    .output
                    .contains("echo:Continue after reconnect")
                    .then_some(session)
            })
        }
    })
    .await;

    assert!(updated.output.contains("echo:Continue after reconnect"));
    assert!(updated
        .conversation
        .iter()
        .any(|entry| entry.kind == "user_message" && entry.text == "Continue after reconnect"));

    harness.state.kill_session(&session.id).await.unwrap();
}
