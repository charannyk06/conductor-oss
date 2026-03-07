use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::types::{AgentKind, EntityId, Priority, Timestamp};

/// A task represents a unit of work to be dispatched to an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: EntityId,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    pub state: TaskState,
    pub priority: Priority,
    pub tags: Vec<String>,
    pub executor: Option<AgentKind>,
    pub branch: Option<String>,
    pub pr_url: Option<String>,
    pub parent_id: Option<EntityId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub completed_at: Option<Timestamp>,
}

/// Task lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    /// Newly created, not yet processed.
    Inbox,
    /// Enhanced by AI, ready for dispatch.
    Ready,
    /// Being dispatched to an agent.
    Dispatching,
    /// Agent is actively working on it.
    InProgress,
    /// Agent needs human input.
    NeedsInput,
    /// Agent is blocked on something.
    Blocked,
    /// Agent errored, may need retry.
    Errored,
    /// Work complete, pending review.
    Review,
    /// PR is open, ready to merge.
    Merge,
    /// Task is done.
    Done,
    /// Task was cancelled.
    Cancelled,
}

impl std::fmt::Display for TaskState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Inbox => write!(f, "inbox"),
            Self::Ready => write!(f, "ready"),
            Self::Dispatching => write!(f, "dispatching"),
            Self::InProgress => write!(f, "in_progress"),
            Self::NeedsInput => write!(f, "needs_input"),
            Self::Blocked => write!(f, "blocked"),
            Self::Errored => write!(f, "errored"),
            Self::Review => write!(f, "review"),
            Self::Merge => write!(f, "merge"),
            Self::Done => write!(f, "done"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl Task {
    pub fn new(project_id: String, title: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            project_id,
            title,
            description: None,
            state: TaskState::Inbox,
            priority: Priority::default(),
            tags: Vec::new(),
            executor: None,
            branch: None,
            pr_url: None,
            parent_id: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        }
    }

    /// Transition to a new state with validation.
    pub fn transition(&mut self, new_state: TaskState) -> Result<(), String> {
        let valid = match (&self.state, &new_state) {
            (TaskState::Inbox, TaskState::Ready) => true,
            (TaskState::Ready, TaskState::Dispatching) => true,
            (TaskState::Dispatching, TaskState::InProgress) => true,
            (TaskState::Dispatching, TaskState::Errored) => true,
            (TaskState::InProgress, TaskState::NeedsInput) => true,
            (TaskState::InProgress, TaskState::Blocked) => true,
            (TaskState::InProgress, TaskState::Errored) => true,
            (TaskState::InProgress, TaskState::Review) => true,
            (TaskState::InProgress, TaskState::Done) => true,
            (TaskState::NeedsInput, TaskState::InProgress) => true,
            (TaskState::Blocked, TaskState::InProgress) => true,
            (TaskState::Errored, TaskState::Ready) => true, // retry
            (TaskState::Review, TaskState::Merge) => true,
            (TaskState::Review, TaskState::InProgress) => true, // changes requested
            (TaskState::Merge, TaskState::Done) => true,
            (_, TaskState::Cancelled) => true, // can always cancel
            _ => false,
        };

        if valid {
            self.state = new_state;
            self.updated_at = Utc::now();
            if new_state == TaskState::Done || new_state == TaskState::Cancelled {
                self.completed_at = Some(Utc::now());
            }
            Ok(())
        } else {
            Err(format!(
                "Invalid transition: {} -> {}",
                self.state, new_state
            ))
        }
    }
}
