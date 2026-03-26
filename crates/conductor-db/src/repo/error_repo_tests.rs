use super::*;
use crate::repo::{ProjectRepo, SessionRepo, TaskRepo};
use crate::Database;
use conductor_core::task::Task;
use sqlx::SqlitePool;

async fn seed_error_fixture(pool: &SqlitePool) -> String {
    ProjectRepo::upsert(
        pool,
        "demo",
        "Demo",
        "/tmp/demo",
        Some("boards/demo.md"),
        Some("codex"),
        2,
    )
    .await
    .unwrap();

    let task = Task::new("demo".to_string(), "Fixture".to_string());
    let task_id = task.id.to_string();
    TaskRepo::create(pool, &task).await.unwrap();
    SessionRepo::create(pool, "session-1", &task_id, "demo", "codex")
        .await
        .unwrap();
    "session-1".to_string()
}

async fn insert_error(
    pool: &SqlitePool,
    error_type: &str,
    category: &str,
    message: &str,
    severity: &str,
    resolved_at: Option<String>,
) {
    ErrorRepo::record(
        pool,
        &ErrorRecord {
            error_type: error_type.to_string(),
            category: category.to_string(),
            message: message.to_string(),
            context: Some(r#"{"source":"test"}"#.to_string()),
            session_id: Some("session-1".to_string()),
            project_id: Some("demo".to_string()),
            stack_trace: None,
            severity: severity.to_string(),
            resolved_at,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn error_repo_summarizes_and_filters_by_category() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    let _session_id = seed_error_fixture(pool).await;

    insert_error(
        pool,
        "spawn",
        "spawn_error",
        "launch failed",
        "critical",
        None,
    )
    .await;
    insert_error(
        pool,
        "spawn",
        "spawn_error",
        "queued launch retried",
        "warn",
        None,
    )
    .await;
    insert_error(
        pool,
        "spawn",
        "spawn_error",
        "resolved launch",
        "error",
        Some(chrono::Utc::now().to_rfc3339()),
    )
    .await;
    insert_error(
        pool,
        "terminal",
        "terminal_error",
        "ttyd disconnected",
        "error",
        None,
    )
    .await;

    let all = ErrorRepo::summary(pool, None).await.unwrap();
    assert_eq!(all.total, 4);
    assert_eq!(all.unresolved, 3);
    assert_eq!(all.critical, 1);
    assert_eq!(all.warning, 1);
    assert_eq!(all.error, 1);
    assert_eq!(all.resolved, 1);
    assert!(all.latest_created_at.is_some());

    let spawn = ErrorRepo::summary(pool, Some("spawn_error")).await.unwrap();
    assert_eq!(spawn.total, 3);
    assert_eq!(spawn.unresolved, 2);
    assert_eq!(spawn.critical, 1);
    assert_eq!(spawn.warning, 1);
    assert_eq!(spawn.error, 0);
    assert_eq!(spawn.resolved, 1);

    let terminal = ErrorRepo::summary(pool, Some("terminal_error"))
        .await
        .unwrap();
    assert_eq!(terminal.total, 1);
    assert_eq!(terminal.unresolved, 1);
    assert_eq!(terminal.error, 1);
}

#[tokio::test]
async fn error_repo_returns_recent_rows_in_descending_order() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    let _session_id = seed_error_fixture(pool).await;

    insert_error(pool, "spawn", "spawn_error", "first", "error", None).await;
    insert_error(pool, "spawn", "spawn_error", "second", "warn", None).await;
    insert_error(pool, "spawn", "spawn_error", "third", "critical", None).await;

    let recent = ErrorRepo::recent(pool, Some("spawn_error"), 2)
        .await
        .unwrap();
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0].message, "third");
    assert_eq!(recent[1].message, "second");
}
