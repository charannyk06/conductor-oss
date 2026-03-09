use super::*;
use crate::repo::{ProjectRepo, TaskRepo};
use crate::Database;
use conductor_core::task::Task;
use sqlx::SqlitePool;

async fn seed_project_and_task(pool: &SqlitePool) -> Task {
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

    let task = Task::new("demo".to_string(), "Seed task".to_string());
    TaskRepo::create(pool, &task).await.unwrap();
    task
}

#[tokio::test]
async fn session_repo_supports_crud_listing_and_log_cleanup() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    let task = seed_project_and_task(pool).await;

    SessionRepo::create(pool, "session-1", &task.id.to_string(), "demo", "codex")
        .await
        .unwrap();

    let active = SessionRepo::list_active(pool, "demo").await.unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "session-1");
    assert_eq!(active[0].state, "spawning");

    SessionRepo::update_state(pool, "session-1", "idle")
        .await
        .unwrap();
    SessionRepo::set_pid(pool, "session-1", 4242).await.unwrap();
    SessionRepo::touch(pool, "session-1").await.unwrap();

    SessionRepo::append_log(pool, "session-1", "stdout", "first line")
        .await
        .unwrap();
    SessionRepo::append_log(pool, "session-1", "stderr", "second line")
        .await
        .unwrap();
    SessionRepo::append_log(pool, "session-1", "stdout", "third line")
        .await
        .unwrap();

    let logs = SessionRepo::get_logs(pool, "session-1", 10).await.unwrap();
    assert_eq!(logs.len(), 3);
    assert_eq!(logs[0].content, "third line");
    assert_eq!(logs[1].line_type, "stderr");

    let listed = SessionRepo::list(pool, Some("active")).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pid, Some(4242));

    let counts = SessionRepo::count_active_per_project(pool).await.unwrap();
    assert_eq!(counts, vec![("demo".to_string(), 1)]);

    let deleted = SessionRepo::cleanup_old_logs(pool, "session-1", 1)
        .await
        .unwrap();
    assert_eq!(deleted, 2);
    let retained = SessionRepo::get_logs(pool, "session-1", 10).await.unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].content, "third line");

    SessionRepo::terminate(pool, "session-1", Some(137))
        .await
        .unwrap();

    let terminated = SessionRepo::list(pool, Some("terminated")).await.unwrap();
    assert_eq!(terminated.len(), 1);
    assert_eq!(terminated[0].exit_code, Some(137));
    assert!(SessionRepo::list_active(pool, "demo")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn session_repo_handles_unicode_and_stale_log_cleanup() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    let task = seed_project_and_task(pool).await;
    let session_id = "session-🦀-長い";
    let executor = "custom-executor-✨";
    let long_line = "出力 ".repeat(256);

    SessionRepo::create(pool, session_id, &task.id.to_string(), "demo", executor)
        .await
        .unwrap();
    SessionRepo::update_state(pool, session_id, "needs_input")
        .await
        .unwrap();
    SessionRepo::append_log(pool, session_id, "stdout", "")
        .await
        .unwrap();
    SessionRepo::append_log(pool, session_id, "stdout", &long_line)
        .await
        .unwrap();

    sqlx::query(
        "UPDATE session_logs SET created_at = datetime('now', '-10 days') WHERE content = ''",
    )
    .execute(pool)
    .await
    .unwrap();

    let removed = SessionRepo::cleanup_stale_logs(pool, 5).await.unwrap();
    assert_eq!(removed, 1);

    let session = SessionRepo::list(pool, Some("needs_input")).await.unwrap();
    assert_eq!(session.len(), 1);
    assert_eq!(session[0].id, session_id);
    assert_eq!(session[0].executor, executor);

    let logs = SessionRepo::get_logs(pool, session_id, 10).await.unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].content, long_line);
}
