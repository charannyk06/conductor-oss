use super::*;
use crate::repo::ProjectRepo;
use crate::Database;
use conductor_core::task::{Task, TaskState};
use conductor_core::types::{AgentKind, Priority};
use sqlx::SqlitePool;

async fn seed_project(pool: &SqlitePool, project_id: &str) {
    ProjectRepo::upsert(
        pool,
        project_id,
        &format!("Project {project_id}"),
        &format!("/tmp/{project_id}"),
        Some(&format!("boards/{project_id}.md")),
        Some("codex"),
        2,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn task_repo_supports_create_get_list_and_counts() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    seed_project(pool, "demo").await;

    let mut ready = Task::new("demo".to_string(), "Ship API".to_string());
    ready.state = TaskState::Ready;
    ready.priority = Priority::High;
    ready.description = Some("Add smoke coverage".to_string());
    ready.executor = Some(AgentKind::Codex);
    ready.branch = Some("feature/api-tests".to_string());
    TaskRepo::create(pool, &ready).await.unwrap();

    let mut blocked = Task::new("demo".to_string(), "Fix flaky build".to_string());
    blocked.state = TaskState::Blocked;
    blocked.priority = Priority::Critical;
    blocked.executor = Some(AgentKind::ClaudeCode);
    blocked.parent_id = Some(ready.id);
    TaskRepo::create(pool, &blocked).await.unwrap();

    let fetched = TaskRepo::get(pool, &ready.id.to_string()).await.unwrap().unwrap();
    assert_eq!(fetched.title, "Ship API");
    assert_eq!(fetched.description.as_deref(), Some("Add smoke coverage"));
    assert_eq!(fetched.state, TaskState::Ready);
    assert_eq!(fetched.priority, Priority::High);
    assert_eq!(fetched.executor, Some(AgentKind::Codex));
    assert_eq!(fetched.branch.as_deref(), Some("feature/api-tests"));

    let all = TaskRepo::list(pool, "demo", None).await.unwrap();
    assert_eq!(all.len(), 2);

    let blocked_only = TaskRepo::list(pool, "demo", Some("blocked")).await.unwrap();
    assert_eq!(blocked_only.len(), 1);
    assert_eq!(blocked_only[0].id, blocked.id);

    let mut counts = TaskRepo::count_by_state(pool, "demo").await.unwrap();
    counts.sort();
    assert_eq!(
        counts,
        vec![("blocked".to_string(), 1), ("ready".to_string(), 1)]
    );
}

#[tokio::test]
async fn task_repo_updates_terminal_state_and_preserves_completion_timestamp() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    seed_project(pool, "demo").await;

    let task = Task::new("demo".to_string(), "Close release".to_string());
    let task_id = task.id.to_string();
    TaskRepo::create(pool, &task).await.unwrap();

    TaskRepo::update_state(pool, &task_id, "done").await.unwrap();

    let state: String = sqlx::query_scalar("SELECT state FROM tasks WHERE id = ?")
        .bind(&task_id)
        .fetch_one(pool)
        .await
        .unwrap();
    let completed_at: Option<String> =
        sqlx::query_scalar("SELECT completed_at FROM tasks WHERE id = ?")
            .bind(&task_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(state, "done");
    assert!(completed_at.is_some());

    TaskRepo::update_state(pool, &task_id, "review").await.unwrap();
    let preserved_completed_at: Option<String> =
        sqlx::query_scalar("SELECT completed_at FROM tasks WHERE id = ?")
            .bind(&task_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(preserved_completed_at, completed_at);

    let counts = TaskRepo::count_by_state(pool, "demo").await.unwrap();
    assert_eq!(counts, vec![("review".to_string(), 1)]);
}

#[tokio::test]
async fn task_repo_handles_unicode_long_values_and_unknown_states() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    seed_project(pool, "unicode").await;

    let mut task = Task::new("unicode".to_string(), "修复 Rust migration 🦀".repeat(16));
    task.description = Some("長い説明 ".repeat(128));
    task.priority = Priority::Low;
    TaskRepo::create(pool, &task).await.unwrap();

    TaskRepo::update_state(pool, &task.id.to_string(), "unexpected_state")
        .await
        .unwrap();

    let stored_state: String = sqlx::query_scalar("SELECT state FROM tasks WHERE id = ?")
        .bind(task.id.to_string())
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(stored_state, "unexpected_state");

    let counts = TaskRepo::count_by_state(pool, "unicode").await.unwrap();
    assert_eq!(counts, vec![("unexpected_state".to_string(), 1)]);
}
