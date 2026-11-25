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

/// The server's sessions are not rows in this database, so an error must be
/// recordable against a session id the `sessions` table has never seen.
#[tokio::test]
async fn error_repo_records_errors_for_sessions_outside_the_database() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();

    ErrorRepo::record(
        pool,
        &ErrorRecord {
            error_type: "spawn_error".to_string(),
            category: "spawn_error".to_string(),
            message: "ttyd runtime is required".to_string(),
            context: None,
            session_id: Some("0daa44c6-2bf9-4671-86cc-e56547a21bc6".to_string()),
            project_id: Some("demo-app".to_string()),
            stack_trace: None,
            severity: "critical".to_string(),
            resolved_at: None,
        },
    )
    .await
    .expect("an error for an unknown session id must be stored");

    let summary = ErrorRepo::summary(pool, Some("spawn_error")).await.unwrap();
    assert_eq!(summary.total, 1);
    assert_eq!(summary.critical, 1);

    let foreign_keys: Vec<(i64,)> =
        sqlx::query_as("SELECT id FROM pragma_foreign_key_list('errors')")
            .fetch_all(pool)
            .await
            .unwrap();
    assert!(foreign_keys.is_empty());
}

/// Rows written before the table was rebuilt survive the migration.
#[tokio::test]
async fn errors_migration_keeps_existing_rows() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    let _session_id = seed_error_fixture(pool).await;
    insert_error(pool, "spawn_error", "spawn_error", "first", "error", None).await;

    // Put the table back to its pre-migration shape with the row in it, then
    // run the migrations again.
    for statement in [
        "ALTER TABLE errors RENAME TO errors_new",
        "CREATE TABLE errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            error_type TEXT NOT NULL,
            category TEXT NOT NULL,
            message TEXT NOT NULL,
            context TEXT,
            session_id TEXT REFERENCES sessions(id),
            project_id TEXT,
            stack_trace TEXT,
            severity TEXT DEFAULT 'error',
            resolved_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
        "INSERT INTO errors SELECT * FROM errors_new",
        "DROP TABLE errors_new",
        "DELETE FROM _migrations WHERE name = '006_errors_without_session_fk'",
    ] {
        sqlx::query(statement).execute(pool).await.unwrap();
    }
    crate::migrations::run(pool).await.unwrap();

    let messages: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT message, session_id FROM errors")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(
        messages,
        vec![("first".to_string(), Some("session-1".to_string()))]
    );
    insert_error(pool, "spawn_error", "spawn_error", "second", "error", None).await;
}

/// The same upgrade on a database file, where the pool hands statements to
/// several connections. An in-memory database has only one.
#[tokio::test]
async fn errors_migration_upgrades_an_existing_database_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conductor.db");

    {
        let db = Database::connect(&path).await.unwrap();
        let pool = db.pool();
        let _session_id = seed_error_fixture(pool).await;
        insert_error(
            pool,
            "spawn_error",
            "spawn_error",
            "before upgrade",
            "error",
            None,
        )
        .await;
        for statement in [
            "ALTER TABLE errors RENAME TO errors_new",
            "CREATE TABLE errors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                error_type TEXT NOT NULL,
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                context TEXT,
                session_id TEXT REFERENCES sessions(id),
                project_id TEXT,
                stack_trace TEXT,
                severity TEXT DEFAULT 'error',
                resolved_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
            "INSERT INTO errors SELECT * FROM errors_new",
            "DROP TABLE errors_new",
            "DELETE FROM _migrations WHERE name = '006_errors_without_session_fk'",
        ] {
            sqlx::query(statement).execute(pool).await.unwrap();
        }
        pool.close().await;
    }

    let db = Database::connect(&path)
        .await
        .expect("an existing database must upgrade");
    let pool = db.pool();
    ErrorRepo::record(
        pool,
        &ErrorRecord {
            error_type: "spawn_error".to_string(),
            category: "spawn_error".to_string(),
            message: "after upgrade".to_string(),
            context: None,
            session_id: Some("not-in-the-sessions-table".to_string()),
            project_id: None,
            stack_trace: None,
            severity: "error".to_string(),
            resolved_at: None,
        },
    )
    .await
    .unwrap();
    let messages: Vec<(String,)> = sqlx::query_as("SELECT message FROM errors ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(
        messages,
        vec![
            ("before upgrade".to_string(),),
            ("after upgrade".to_string(),)
        ]
    );
}

/// A fresh database file reaches the current schema.
#[tokio::test]
async fn a_new_database_file_accepts_errors_for_unknown_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::connect(&dir.path().join("conductor.db"))
        .await
        .unwrap();
    ErrorRepo::record(
        db.pool(),
        &ErrorRecord {
            error_type: "spawn_error".to_string(),
            category: "spawn_error".to_string(),
            message: "launch failed".to_string(),
            context: None,
            session_id: Some("unknown-session".to_string()),
            project_id: None,
            stack_trace: None,
            severity: "critical".to_string(),
            resolved_at: None,
        },
    )
    .await
    .unwrap();
}
