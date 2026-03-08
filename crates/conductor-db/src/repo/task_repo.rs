use anyhow::Result;
use sqlx::SqlitePool;

use conductor_core::task::{Task, TaskState};
use conductor_core::types::Priority;

pub struct TaskRepo;

impl TaskRepo {
    /// Create a new task.
    pub async fn create(pool: &SqlitePool, task: &Task) -> Result<()> {
        sqlx::query(
            "INSERT INTO tasks (id, project_id, title, description, state, priority, executor, branch, pr_url, parent_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(task.id.to_string())
        .bind(&task.project_id)
        .bind(&task.title)
        .bind(&task.description)
        .bind(task.state.to_string())
        .bind(serde_json::to_string(&task.priority)?)
        .bind(task.executor.as_ref().map(|e| e.to_string()))
        .bind(&task.branch)
        .bind(&task.pr_url)
        .bind(task.parent_id.map(|id| id.to_string()))
        .bind(task.created_at.to_rfc3339())
        .bind(task.updated_at.to_rfc3339())
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Get a task by ID.
    pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Task>> {
        let row = sqlx::query_as::<_, TaskRow>(
            "SELECT id, project_id, title, description, state, priority, executor, branch, pr_url, parent_id, created_at, updated_at, completed_at
             FROM tasks WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        match row {
            Some(r) => Ok(Some(r.into_task()?)),
            None => Ok(None),
        }
    }

    /// List tasks for a project, optionally filtered by state.
    pub async fn list(
        pool: &SqlitePool,
        project_id: &str,
        state_filter: Option<&str>,
    ) -> Result<Vec<Task>> {
        let rows = if let Some(state) = state_filter {
            sqlx::query_as::<_, TaskRow>(
                "SELECT id, project_id, title, description, state, priority, executor, branch, pr_url, parent_id, created_at, updated_at, completed_at
                 FROM tasks WHERE project_id = ? AND state = ? ORDER BY created_at DESC",
            )
            .bind(project_id)
            .bind(state)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, TaskRow>(
                "SELECT id, project_id, title, description, state, priority, executor, branch, pr_url, parent_id, created_at, updated_at, completed_at
                 FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
            )
            .bind(project_id)
            .fetch_all(pool)
            .await?
        };

        rows.into_iter().map(|r| r.into_task()).collect()
    }

    /// Update task state.
    pub async fn update_state(pool: &SqlitePool, id: &str, state: &str) -> Result<()> {
        let completed_at = match state {
            "done" | "cancelled" => Some(chrono::Utc::now().to_rfc3339()),
            _ => None,
        };

        sqlx::query(
            "UPDATE tasks SET state = ?, updated_at = datetime('now'), completed_at = COALESCE(?, completed_at) WHERE id = ?",
        )
        .bind(state)
        .bind(completed_at)
        .bind(id)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Count tasks by state for a project.
    pub async fn count_by_state(pool: &SqlitePool, project_id: &str) -> Result<Vec<(String, i64)>> {
        let rows = sqlx::query_as::<_, (String, i64)>(
            "SELECT state, COUNT(*) FROM tasks WHERE project_id = ? GROUP BY state",
        )
        .bind(project_id)
        .fetch_all(pool)
        .await?;

        Ok(rows)
    }
}

/// Intermediate row type for SQLite mapping.
#[derive(sqlx::FromRow)]
struct TaskRow {
    id: String,
    project_id: String,
    title: String,
    description: Option<String>,
    state: String,
    priority: String,
    executor: Option<String>,
    branch: Option<String>,
    pr_url: Option<String>,
    parent_id: Option<String>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

impl TaskRow {
    fn into_task(self) -> Result<Task> {
        use chrono::DateTime;
        use uuid::Uuid;

        let state = match self.state.as_str() {
            "inbox" => TaskState::Inbox,
            "ready" => TaskState::Ready,
            "dispatching" => TaskState::Dispatching,
            "in_progress" => TaskState::InProgress,
            "needs_input" => TaskState::NeedsInput,
            "blocked" => TaskState::Blocked,
            "errored" => TaskState::Errored,
            "review" => TaskState::Review,
            "merge" => TaskState::Merge,
            "done" => TaskState::Done,
            "cancelled" => TaskState::Cancelled,
            _ => TaskState::Inbox,
        };

        let priority: Priority =
            serde_json::from_str(&format!("\"{}\"", self.priority.trim_matches('"')))
                .unwrap_or_default();

        Ok(Task {
            id: Uuid::parse_str(&self.id)?,
            project_id: self.project_id,
            title: self.title,
            description: self.description,
            state,
            priority,
            tags: Vec::new(),
            executor: self.executor.map(|e| {
                serde_json::from_str(&format!("\"{e}\""))
                    .unwrap_or(conductor_core::types::AgentKind::Custom(e))
            }),
            branch: self.branch,
            pr_url: self.pr_url,
            parent_id: self.parent_id.and_then(|id| Uuid::parse_str(&id).ok()),
            created_at: DateTime::parse_from_rfc3339(&self.created_at)?.with_timezone(&chrono::Utc),
            updated_at: DateTime::parse_from_rfc3339(&self.updated_at)?.with_timezone(&chrono::Utc),
            completed_at: self.completed_at.and_then(|t| {
                DateTime::parse_from_rfc3339(&t)
                    .ok()
                    .map(|d| d.with_timezone(&chrono::Utc))
            }),
        })
    }
}
