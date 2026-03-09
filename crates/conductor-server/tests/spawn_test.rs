mod common;

use common::{spawn_request, wait_for_condition, TestExecutor, TestHarness};
use conductor_core::types::AgentKind;
use conductor_core::types::SessionStatus;
use std::sync::Arc;

#[tokio::test]
async fn spawn_session_runs_from_queue_to_follow_up_ready_state() {
    let harness = TestHarness::new("conductor-spawn-test", "direct").await;
    harness.state.executors.write().await.insert(
        AgentKind::Codex,
        Arc::new(TestExecutor {
            kind: AgentKind::Codex,
            auto_complete: true,
        }),
    );

    let queued = harness
        .state
        .spawn_session(spawn_request("Ship the test harness"))
        .await
        .unwrap();
    assert_eq!(queued.status, SessionStatus::Queued);

    let session = wait_for_condition("spawned session to reach follow-up state", || {
        let state = harness.state.clone();
        let session_id = queued.id.clone();
        async move {
            state.get_session(&session_id).await.and_then(|session| {
                (session.status == SessionStatus::NeedsInput
                    && session.output.contains("prompt:Ship the test harness")
                    && session.metadata.contains_key("worktree"))
                .then_some(session)
            })
        }
    })
    .await;

    assert_eq!(session.project_id, "demo");
    assert_eq!(session.agent, "codex");
    assert_eq!(session.activity.as_deref(), Some("waiting_input"));
    assert_eq!(
        session.summary.as_deref(),
        Some("prompt:Ship the test harness")
    );
    assert!(session.metadata.contains_key("worktree"));
    assert!(session
        .conversation
        .iter()
        .any(|entry| entry.kind == "assistant_message"
            && entry.text.contains("prompt:Ship the test harness")));
}
