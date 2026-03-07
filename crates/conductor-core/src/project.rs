use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::types::AgentKind;

/// A registered project in the Conductor workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub board_path: Option<PathBuf>,
    pub default_executor: Option<AgentKind>,
    pub max_sessions: usize,
    pub setup_script: Option<String>,
    pub cleanup_script: Option<String>,
    pub active_sessions: usize,
}

impl Project {
    pub fn new(id: String, name: String, path: PathBuf) -> Self {
        Self {
            id,
            name,
            path,
            board_path: None,
            default_executor: None,
            max_sessions: 2,
            setup_script: None,
            cleanup_script: None,
            active_sessions: 0,
        }
    }

    /// Check if we can spawn another session for this project.
    pub fn can_spawn(&self) -> bool {
        self.active_sessions < self.max_sessions
    }

    /// Get the board file path, defaulting to CONDUCTOR.md in project dir.
    pub fn board_file(&self) -> PathBuf {
        self.board_path
            .clone()
            .unwrap_or_else(|| self.path.join("CONDUCTOR.md"))
    }
}
