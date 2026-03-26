/// Error logging and tracking module.
///
/// Provides structured error logging and aggregation for Conductor.
/// Logs errors to structured output and optionally to SQLite for analysis.
use anyhow::Result;
use conductor_db::repo::{ErrorRecord, ErrorRepo};
use conductor_db::Database;
use serde_json::json;
use std::collections::HashMap;
use tracing::{error, warn};

#[derive(Debug, Clone)]
pub struct ErrorContext {
    /// Error category (spawn_error, terminal_error, cleanup_error, etc.)
    pub category: String,
    /// Session ID if applicable
    pub session_id: Option<String>,
    /// Project ID if applicable
    pub project_id: Option<String>,
    /// Structured context data
    pub context: HashMap<String, String>,
    /// Error severity (error, warn, critical)
    pub severity: String,
}

impl ErrorContext {
    pub fn new(category: impl Into<String>) -> Self {
        Self {
            category: category.into(),
            session_id: None,
            project_id: None,
            context: HashMap::new(),
            severity: "error".to_string(),
        }
    }

    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    pub fn with_project(mut self, project_id: impl Into<String>) -> Self {
        self.project_id = Some(project_id.into());
        self
    }

    pub fn with_context(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.context.insert(key.into(), value.into());
        self
    }

    pub fn critical(mut self) -> Self {
        self.severity = "critical".to_string();
        self
    }

    pub fn warning(mut self) -> Self {
        self.severity = "warn".to_string();
        self
    }

    pub fn to_record(&self, message: impl AsRef<str>) -> Result<ErrorRecord> {
        let message = message.as_ref().to_string();
        let context = if self.context.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&self.context)?)
        };

        Ok(ErrorRecord {
            error_type: self.category.clone(),
            category: self.category.clone(),
            message,
            context,
            session_id: self.session_id.clone(),
            project_id: self.project_id.clone(),
            stack_trace: None,
            severity: self.severity.clone(),
            resolved_at: None,
        })
    }
}

/// Log an error with structured context.
pub fn log_error(ctx: &ErrorContext, message: impl AsRef<str>) {
    let message = message.as_ref().to_string();

    // Build structured log entry
    let error_json = json!({
        "category": ctx.category,
        "message": message,
        "severity": ctx.severity,
        "session_id": ctx.session_id,
        "project_id": ctx.project_id,
        "context": ctx.context,
    });

    // Log based on severity
    match ctx.severity.as_str() {
        "critical" => error!(
            error = %error_json,
            "{}",
            message
        ),
        "warn" => warn!(
            error = %error_json,
            "{}",
            message
        ),
        _ => error!(
            error = %error_json,
            "{}",
            message
        ),
    }
}

pub async fn persist_error(
    db: &Database,
    ctx: &ErrorContext,
    message: impl AsRef<str>,
) -> Result<()> {
    let record = ctx.to_record(message)?;
    ErrorRepo::record(db.pool(), &record).await
}

/// Error categories for classification
pub mod categories {
    pub const SPAWN_ERROR: &str = "spawn_error";
    pub const TERMINAL_ERROR: &str = "terminal_error";
    pub const CLEANUP_ERROR: &str = "cleanup_error";
    pub const SESSION_ERROR: &str = "session_error";
    pub const CONFIG_ERROR: &str = "config_error";
    pub const DATABASE_ERROR: &str = "database_error";
    pub const AUTH_ERROR: &str = "auth_error";
    pub const WEBHOOK_ERROR: &str = "webhook_error";
    pub const IO_ERROR: &str = "io_error";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_context_builder_works() {
        let ctx = ErrorContext::new("spawn_error")
            .with_session("session-123")
            .with_project("proj-456")
            .with_context("executor", "claude-code")
            .critical();

        assert_eq!(ctx.category, "spawn_error");
        assert_eq!(ctx.session_id, Some("session-123".to_string()));
        assert_eq!(ctx.project_id, Some("proj-456".to_string()));
        assert_eq!(ctx.severity, "critical");
        assert_eq!(
            ctx.context.get("executor"),
            Some(&"claude-code".to_string())
        );
    }
}
