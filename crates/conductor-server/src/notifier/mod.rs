pub mod desktop;
pub mod discord;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationPriority {
    Urgent,
    Action,
    Warning,
    Info,
}

impl NotificationPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Urgent => "urgent",
            Self::Action => "action",
            Self::Warning => "warning",
            Self::Info => "info",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEvent {
    pub session_id: String,
    pub project_id: String,
    pub event_type: String,
    pub priority: NotificationPriority,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    #[serde(default)]
    pub data: HashMap<String, Value>,
}

impl NotificationEvent {
    pub fn new(
        session_id: impl Into<String>,
        project_id: impl Into<String>,
        event_type: impl Into<String>,
        priority: NotificationPriority,
        message: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            project_id: project_id.into(),
            event_type: event_type.into(),
            priority,
            message: message.into(),
            timestamp: Utc::now(),
            data: HashMap::new(),
        }
    }
}
