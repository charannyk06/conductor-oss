use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::{AgentKind, EntityId, ExitInfo, HealthGrade, Timestamp};

/// A session represents a running agent process working on a task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: EntityId,
    pub task_id: EntityId,
    pub project_id: String,
    pub executor: AgentKind,
    pub state: SessionState,
    pub pid: Option<u32>,
    pub working_dir: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub exit_info: Option<ExitInfo>,
    pub auto_recover_attempted: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_activity_at: Timestamp,
}

/// Session lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// Being spawned.
    Spawning,
    /// Agent is running and active.
    Active,
    /// Agent is idle, waiting for work.
    Idle,
    /// Agent needs human input.
    NeedsInput,
    /// Agent hit an error.
    Errored,
    /// Session was killed or agent exited.
    Terminated,
    /// Session restored after crash.
    Restored,
}

impl std::fmt::Display for SessionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawning => write!(f, "spawning"),
            Self::Active => write!(f, "active"),
            Self::Idle => write!(f, "idle"),
            Self::NeedsInput => write!(f, "needs_input"),
            Self::Errored => write!(f, "errored"),
            Self::Terminated => write!(f, "terminated"),
            Self::Restored => write!(f, "restored"),
        }
    }
}

impl Session {
    pub fn new(task_id: EntityId, project_id: String, executor: AgentKind) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            task_id,
            project_id,
            executor,
            state: SessionState::Spawning,
            pid: None,
            working_dir: None,
            branch: None,
            model: None,
            exit_info: None,
            auto_recover_attempted: false,
            created_at: now,
            updated_at: now,
            last_activity_at: now,
        }
    }

    /// Calculate health grade based on session metrics.
    pub fn health_grade(&self) -> HealthGrade {
        match self.state {
            SessionState::Active | SessionState::Idle => {
                let idle_secs = Utc::now()
                    .signed_duration_since(self.last_activity_at)
                    .num_seconds();
                if idle_secs < 300 {
                    HealthGrade::Healthy
                } else if idle_secs < 900 {
                    HealthGrade::Degraded
                } else {
                    HealthGrade::Warning
                }
            }
            SessionState::NeedsInput => HealthGrade::Degraded,
            SessionState::Spawning | SessionState::Restored => HealthGrade::Degraded,
            SessionState::Errored | SessionState::Terminated => HealthGrade::Critical,
        }
    }

    /// Mark the session as active with updated timestamp.
    pub fn touch(&mut self) {
        self.last_activity_at = Utc::now();
        self.updated_at = Utc::now();
    }
}
