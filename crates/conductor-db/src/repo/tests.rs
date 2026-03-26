use super::{ProjectRepo, SessionRepo, TaskRepo};
use crate::{migrations, Database};
use conductor_core::task::Task;
use sqlx::SqlitePool;
use tokio::task::JoinSet;

async fn seed_session_fixture(pool: &SqlitePool) -> String {
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

#[tokio::test]
async fn migrations_are_idempotent() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();

    migrations::run(pool).await.unwrap();
    migrations::run(pool).await.unwrap();

    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _migrations")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(applied, 5);

    let sessions_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let session_logs_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_logs'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(sessions_exists, 1);
    assert_eq!(session_logs_exists, 1);
}

#[tokio::test]
async fn concurrent_reads_and_writes_keep_session_logs_consistent() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool().clone();
    let session_id = seed_session_fixture(&pool).await;

    let mut jobs = JoinSet::new();
    for index in 0..24 {
        let pool = pool.clone();
        let session_id = session_id.clone();
        jobs.spawn(async move {
            SessionRepo::append_log(&pool, &session_id, "stdout", &format!("line-{index:02}"))
                .await
                .unwrap();
        });
    }
    for _ in 0..12 {
        let pool = pool.clone();
        let session_id = session_id.clone();
        jobs.spawn(async move {
            let _ = SessionRepo::get_logs(&pool, &session_id, 8).await.unwrap();
        });
    }

    while jobs.join_next().await.is_some() {}

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_logs WHERE session_id = ?")
        .bind(&session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 24);

    let recent = SessionRepo::get_logs(&pool, &session_id, 5).await.unwrap();
    assert_eq!(recent.len(), 5);
    assert!(recent.iter().all(|row| row.line_type == "stdout"));
}
