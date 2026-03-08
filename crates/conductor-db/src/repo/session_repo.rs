use anyhow::Result;
use sqlx::SqlitePool;

pub struct SessionRepo;

impl SessionRepo {
    /// Create a new session.
    pub async fn create(
        pool: &SqlitePool,
        id: &str,
        task_id: &str,
        project_id: &str,
        executor: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO sessions (id, task_id, project_id, executor, state, created_at, updated_at, last_activity_at)
             VALUES (?, ?, ?, ?, 'spawning', datetime('now'), datetime('now'), datetime('now'))",
        )
        .bind(id)
        .bind(task_id)
        .bind(project_id)
        .bind(executor)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update session state.
    pub async fn update_state(pool: &SqlitePool, id: &str, state: &str) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET state = ?, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?",
        )
        .bind(state)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Set session PID.
    pub async fn set_pid(pool: &SqlitePool, id: &str, pid: u32) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET pid = ?, state = 'active', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(pid as i64)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Mark session as terminated.
    pub async fn terminate(pool: &SqlitePool, id: &str, exit_code: Option<i32>) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET state = 'terminated', exit_code = ?, exit_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        )
        .bind(exit_code)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// List active sessions for a project.
    pub async fn list_active(pool: &SqlitePool, project_id: &str) -> Result<Vec<SessionRow>> {
        let rows = sqlx::query_as::<_, SessionRow>(
            "SELECT id, task_id, project_id, executor, state, pid, working_dir, branch, model, exit_code, created_at, updated_at, last_activity_at
             FROM sessions WHERE project_id = ? AND state NOT IN ('terminated') ORDER BY created_at DESC",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// List all sessions optionally filtered by state.
    pub async fn list(pool: &SqlitePool, state_filter: Option<&str>) -> Result<Vec<SessionRow>> {
        let rows = if let Some(state) = state_filter {
            sqlx::query_as::<_, SessionRow>(
                "SELECT id, task_id, project_id, executor, state, pid, working_dir, branch, model, exit_code, created_at, updated_at, last_activity_at
                 FROM sessions WHERE state = ? ORDER BY created_at DESC",
            )
            .bind(state)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, SessionRow>(
                "SELECT id, task_id, project_id, executor, state, pid, working_dir, branch, model, exit_code, created_at, updated_at, last_activity_at
                 FROM sessions ORDER BY created_at DESC",
            )
            .fetch_all(pool)
            .await?
        };
        Ok(rows)
    }

    /// Count active sessions per project.
    pub async fn count_active_per_project(pool: &SqlitePool) -> Result<Vec<(String, i64)>> {
        let rows = sqlx::query_as::<_, (String, i64)>(
            "SELECT project_id, COUNT(*) FROM sessions WHERE state IN ('spawning', 'active', 'idle', 'needs_input') GROUP BY project_id",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Touch last_activity_at for a session.
    pub async fn touch(pool: &SqlitePool, id: &str) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET last_activity_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Append a log line for a session.
    pub async fn append_log(
        pool: &SqlitePool,
        session_id: &str,
        line_type: &str,
        content: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO session_logs (session_id, line_type, content) VALUES (?, ?, ?)")
            .bind(session_id)
            .bind(line_type)
            .bind(content)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Get recent logs for a session.
    pub async fn get_logs(pool: &SqlitePool, session_id: &str, limit: i64) -> Result<Vec<LogRow>> {
        let rows = sqlx::query_as::<_, LogRow>(
            "SELECT line_type, content, created_at FROM session_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        )
        .bind(session_id)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Delete all but the most recent N logs for a session.
    pub async fn cleanup_old_logs(
        pool: &SqlitePool,
        session_id: &str,
        keep_count: i64,
    ) -> Result<u64> {
        let result = sqlx::query(
            "DELETE FROM session_logs WHERE session_id = ? AND id NOT IN (
                SELECT id FROM session_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?
            )",
        )
        .bind(session_id)
        .bind(session_id)
        .bind(keep_count)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Delete logs older than N days across all sessions.
    pub async fn cleanup_stale_logs(pool: &SqlitePool, older_than_days: i64) -> Result<u64> {
        let result = sqlx::query(
            "DELETE FROM session_logs WHERE created_at < datetime('now', ? || ' days')",
        )
        .bind(-older_than_days)
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct SessionRow {
    pub id: String,
    pub task_id: String,
    pub project_id: String,
    pub executor: String,
    pub state: String,
    pub pid: Option<i64>,
    pub working_dir: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub exit_code: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_at: String,
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct LogRow {
    pub line_type: String,
    pub content: String,
    pub created_at: String,
}
