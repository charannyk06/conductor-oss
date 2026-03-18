mod common;
use common::{spawn_request, wait_for_condition, ResumeExecutor, TestExecutor, TestHarness};
use conductor_core::types::AgentKind;
use conductor_core::types::SessionStatus;
use conductor_server::state::SessionRecord;
use std::sync::Arc;

#[tokio::test]
async fn archive_restore_and_kill_cover_session_lifecycle_transitions() {
    let harness = TestHarness::new("conductor-session-test", "ttyd").await;
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
                (session.status == SessionStatus::Working
                    && session.metadata.contains_key("worktree"))
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

    let updated = wait_for_condition("follow-up persisted", || {
        let state = harness.state.clone();
        let session_id = session.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.model.as_deref() == Some("gpt-5.4")
                    && session.reasoning_effort.as_deref() == Some("high")
                    && session
                        .conversation
                        .iter()
                        .any(|entry| entry.kind == "user_message"
                            && entry.text == "Continue with detail"))
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
            state
                .get_session(&session_id)
                .await
                .and_then(|session| (session.status == SessionStatus::Killed).then_some(session))
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
                (session.status == SessionStatus::Working
                    && session.metadata.contains_key("worktree"))
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
            state
                .get_session(&session_id)
                .await
                .and_then(|session| (session.status == SessionStatus::Archived).then_some(session))
        }
    })
    .await;
    assert_eq!(archived.summary.as_deref(), Some("Archived"));
    wait_for_condition("archived worktree removal", || {
        let worktree = worktree.clone();
        async move { (!std::path::Path::new(&worktree).exists()).then_some(()) }
    })
    .await;
    assert!(!std::path::Path::new(&worktree).exists());

    let restored = harness.state.restore_session(&archived.id).await.unwrap();
    let resumed = wait_for_condition("restored session to launch", || {
        let state = harness.state.clone();
        let session_id = restored.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == SessionStatus::Working
                    || session.status == SessionStatus::NeedsInput)
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
async fn resume_session_uses_ttyd_runtime_even_when_project_requests_legacy_tmux() {
    let harness = TestHarness::new("conductor-session-resume-test", "tmux").await;
    harness
        .state
        .executors
        .write()
        .await
        .insert(AgentKind::Codex, Arc::new(ResumeExecutor));

    let session = SessionRecord::new(
        "resume-ttyd-session".to_string(),
        "demo".to_string(),
        None,
        None,
        Some(harness.repo.to_string_lossy().to_string()),
        "codex".to_string(),
        None,
        None,
        "Start runtime".to_string(),
        None,
    );
    harness
        .state
        .sessions
        .write()
        .await
        .insert(session.id.clone(), session);

    harness
        .state
        .resume_session_with_prompt(
            "resume-ttyd-session",
            "Continue after reconnect".to_string(),
            Vec::new(),
            None,
            None,
            "follow_up",
        )
        .await
        .unwrap();

    let updated = wait_for_condition("resumed ttyd session", || {
        let state = harness.state.clone();
        async move {
            state.get_session("resume-ttyd-session").await.and_then(|session| {
                (session.metadata.get("runtimeMode").map(String::as_str) == Some("ttyd")
                    && session.pid.is_some())
                .then_some(session)
            })
        }
    })
    .await;

    assert_eq!(
        updated.metadata.get("runtimeMode").map(String::as_str),
        Some("ttyd")
    );

    harness.state.kill_session("resume-ttyd-session").await.unwrap();
}
