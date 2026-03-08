use anyhow::Result;
use sqlx::SqlitePool;

/// Run all database migrations.
pub async fn run(pool: &SqlitePool) -> Result<()> {
    // Create migrations table if it doesn't exist.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    let migrations: Vec<(&str, &str)> = vec![
        ("001_init", MIGRATION_001_INIT),
        ("002_session_logs", MIGRATION_002_SESSION_LOGS),
        ("003_board_snapshots", MIGRATION_003_BOARD_SNAPSHOTS),
        ("004_indexes", MIGRATION_004_INDEXES),
    ];

    for (name, sql) in migrations {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = ?)")
                .bind(name)
                .fetch_one(pool)
                .await?;

        if !exists {
            tracing::info!("Running migration: {name}");
            // Split multi-statement SQL and execute each statement individually,
            // because sqlx::query().execute() only runs the first statement.
            let sanitized = sql
                .lines()
                .filter(|line| !line.trim_start().starts_with("--"))
                .collect::<Vec<_>>()
                .join("\n");
            for statement in sanitized
                .split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                sqlx::query(statement).execute(pool).await?;
            }
            sqlx::query("INSERT INTO _migrations (name) VALUES (?)")
                .bind(name)
                .execute(pool)
                .await?;
        }
    }

    Ok(())
}

const MIGRATION_001_INIT: &str = r#"
-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    board_path TEXT,
    default_executor TEXT,
    max_sessions INTEGER NOT NULL DEFAULT 2,
    setup_script TEXT,
    cleanup_script TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT,
    state TEXT NOT NULL DEFAULT 'inbox',
    priority TEXT NOT NULL DEFAULT 'normal',
    executor TEXT,
    branch TEXT,
    pr_url TEXT,
    parent_id TEXT REFERENCES tasks(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- Task tags junction
CREATE TABLE IF NOT EXISTS task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (task_id, tag_id)
);

-- Sessions table (running agent processes)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    executor TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'spawning',
    pid INTEGER,
    working_dir TEXT,
    branch TEXT,
    model TEXT,
    exit_code INTEGER,
    exit_signal TEXT,
    exit_at TEXT,
    auto_recover_attempted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);

-- Events log
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- Config snapshots (for drift detection)
CREATE TABLE IF NOT EXISTS config_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

const MIGRATION_002_SESSION_LOGS: &str = r#"
-- Session output logs (structured, not flat files)
CREATE TABLE IF NOT EXISTS session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    line_type TEXT NOT NULL DEFAULT 'stdout',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_logs_created ON session_logs(created_at);
"#;

const MIGRATION_003_BOARD_SNAPSHOTS: &str = r#"
-- Board file snapshots for change detection
CREATE TABLE IF NOT EXISTS board_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    diff_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_board_snapshots_project ON board_snapshots(project_id);
"#;

const MIGRATION_004_INDEXES: &str = r#"
-- Additional indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_sessions_project_state ON sessions(project_id, state);
CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(pid);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
"#;
