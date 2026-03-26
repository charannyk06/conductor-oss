use anyhow::Result;
use serde::Serialize;
use sqlx::SqlitePool;

pub struct ErrorRepo;

#[derive(Debug, Clone)]
pub struct ErrorRecord {
    pub error_type: String,
    pub category: String,
    pub message: String,
    pub context: Option<String>,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub stack_trace: Option<String>,
    pub severity: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ErrorRow {
    pub id: i64,
    pub error_type: String,
    pub category: String,
    pub message: String,
    pub context: Option<String>,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub stack_trace: Option<String>,
    pub severity: String,
    pub resolved_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ErrorSummary {
    pub total: i64,
    pub unresolved: i64,
    pub critical: i64,
    pub warning: i64,
    pub error: i64,
    pub resolved: i64,
    pub latest_created_at: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct ErrorSummaryRow {
    total: i64,
    unresolved: i64,
    critical: i64,
    warning: i64,
    error: i64,
    resolved: i64,
    latest_created_at: Option<String>,
}

impl ErrorRepo {
    pub async fn record(pool: &SqlitePool, record: &ErrorRecord) -> Result<()> {
        sqlx::query(
            "INSERT INTO errors (
                error_type,
                category,
                message,
                context,
                session_id,
                project_id,
                stack_trace,
                severity,
                resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.error_type)
        .bind(&record.category)
        .bind(&record.message)
        .bind(&record.context)
        .bind(&record.session_id)
        .bind(&record.project_id)
        .bind(&record.stack_trace)
        .bind(&record.severity)
        .bind(&record.resolved_at)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn summary(pool: &SqlitePool, category: Option<&str>) -> Result<ErrorSummary> {
        let row = if let Some(category) = category {
            sqlx::query_as::<_, ErrorSummaryRow>(
                "SELECT
                    COUNT(*) AS total,
                    COUNT(CASE WHEN resolved_at IS NULL THEN 1 END) AS unresolved,
                    COUNT(CASE WHEN resolved_at IS NULL AND severity = 'critical' THEN 1 END) AS critical,
                    COUNT(CASE WHEN resolved_at IS NULL AND severity = 'warn' THEN 1 END) AS warning,
                    COUNT(CASE WHEN resolved_at IS NULL AND severity = 'error' THEN 1 END) AS error,
                    COUNT(CASE WHEN resolved_at IS NOT NULL THEN 1 END) AS resolved,
                    MAX(created_at) AS latest_created_at
                 FROM errors
                 WHERE category = ?",
            )
            .bind(category)
            .fetch_one(pool)
            .await?
        } else {
            sqlx::query_as::<_, ErrorSummaryRow>(
                "SELECT
                    COUNT(*) AS total,
                    COUNT(CASE WHEN resolved_at IS NULL THEN 1 END) AS unresolved,
                    COUNT(CASE WHEN resolved_at IS NULL AND severity = 'critical' THEN 1 END) AS critical,
                    COUNT(CASE WHEN resolved_at IS NULL AND severity = 'warn' THEN 1 END) AS warning,
                    COUNT(CASE WHEN resolved_at IS NULL AND severity = 'error' THEN 1 END) AS error,
                    COUNT(CASE WHEN resolved_at IS NOT NULL THEN 1 END) AS resolved,
                    MAX(created_at) AS latest_created_at
                 FROM errors",
            )
            .fetch_one(pool)
            .await?
        };

        Ok(ErrorSummary {
            total: row.total,
            unresolved: row.unresolved,
            critical: row.critical,
            warning: row.warning,
            error: row.error,
            resolved: row.resolved,
            latest_created_at: row.latest_created_at,
        })
    }

    pub async fn recent(
        pool: &SqlitePool,
        category: Option<&str>,
        limit: i64,
    ) -> Result<Vec<ErrorRow>> {
        let limit = limit.max(1);
        let rows = if let Some(category) = category {
            sqlx::query_as::<_, ErrorRow>(
                "SELECT id, error_type, category, message, context, session_id, project_id, stack_trace, severity, resolved_at, created_at
                 FROM errors
                 WHERE category = ?
                 ORDER BY id DESC
                 LIMIT ?",
            )
            .bind(category)
            .bind(limit)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, ErrorRow>(
                "SELECT id, error_type, category, message, context, session_id, project_id, stack_trace, severity, resolved_at, created_at
                 FROM errors
                 ORDER BY id DESC
                 LIMIT ?",
            )
            .bind(limit)
            .fetch_all(pool)
            .await?
        };

        Ok(rows)
    }
}

#[cfg(test)]
#[path = "error_repo_tests.rs"]
mod tests;
