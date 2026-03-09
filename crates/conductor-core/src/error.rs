use thiserror::Error;

/// Typed errors for the Conductor system.
///
/// Use these when the caller needs to distinguish error kinds (e.g., returning
/// different HTTP status codes). For internal-only errors where the caller just
/// propagates, `anyhow` is still fine.
#[derive(Debug, Error)]
pub enum ConductorError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Session is not running: {0}")]
    SessionNotRunning(String),

    #[error("Project not found: {0}")]
    ProjectNotFound(String),

    #[error("Executor not available: {0}")]
    ExecutorNotAvailable(String),

    #[error("No workspace path for session: {0}")]
    NoWorkspacePath(String),

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Board parse error: {0}")]
    BoardParse(String),

    #[error("Spawn failed: {0}")]
    SpawnFailed(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Result alias using ConductorError.
pub type ConductorResult<T> = Result<T, ConductorError>;
