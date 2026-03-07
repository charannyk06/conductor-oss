use anyhow::Result;
use sqlx::SqlitePool;

pub struct ProjectRepo;

impl ProjectRepo {
    /// Upsert a project (insert or update).
    pub async fn upsert(
        pool: &SqlitePool,
        id: &str,
        name: &str,
        path: &str,
        board_path: Option<&str>,
        default_executor: Option<&str>,
        max_sessions: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO projects (id, name, path, board_path, default_executor, max_sessions)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                path = excluded.path,
                board_path = excluded.board_path,
                default_executor = excluded.default_executor,
                max_sessions = excluded.max_sessions,
                updated_at = datetime('now')",
        )
        .bind(id)
        .bind(name)
        .bind(path)
        .bind(board_path)
        .bind(default_executor)
        .bind(max_sessions)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Get a project by ID.
    pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<ProjectRow>> {
        let row = sqlx::query_as::<_, ProjectRow>(
            "SELECT id, name, path, board_path, default_executor, max_sessions, created_at, updated_at
             FROM projects WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }

    /// List all projects.
    pub async fn list(pool: &SqlitePool) -> Result<Vec<ProjectRow>> {
        let rows = sqlx::query_as::<_, ProjectRow>(
            "SELECT id, name, path, board_path, default_executor, max_sessions, created_at, updated_at
             FROM projects ORDER BY name",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Delete a project.
    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub path: String,
    pub board_path: Option<String>,
    pub default_executor: Option<String>,
    pub max_sessions: i64,
    pub created_at: String,
    pub updated_at: String,
}
