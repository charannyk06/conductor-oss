use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::AppState;

const MAX_BOARD_ACTIVITY: usize = 50;
const MAX_TASK_COMMENTS: usize = 100;
const MAX_WEBHOOK_DELIVERIES: usize = 50;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoardActivityRecord {
    pub id: String,
    pub source: String,
    pub action: String,
    pub detail: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BoardCommentRecord {
    pub id: String,
    pub task_id: String,
    pub author: String,
    pub author_email: Option<String>,
    pub provider: Option<String>,
    pub body: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WebhookDeliveryRecord {
    pub id: String,
    pub event: String,
    pub action: String,
    pub status: String,
    pub detail: String,
    pub repository: Option<String>,
    pub timestamp: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ProjectBoardCollaboration {
    #[serde(default)]
    pub activity: Vec<BoardActivityRecord>,
    #[serde(default)]
    pub task_comments: HashMap<String, Vec<BoardCommentRecord>>,
    #[serde(default)]
    pub webhook_deliveries: Vec<WebhookDeliveryRecord>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct BoardCollaborationStore {
    #[serde(default)]
    pub projects: HashMap<String, ProjectBoardCollaboration>,
}

impl AppState {
    pub fn board_collaboration_path(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("board-collaboration.json")
    }

    pub(crate) async fn load_board_collaboration_from_disk(&self) {
        let path = self.board_collaboration_path();
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            return;
        };
        let Ok(store) = serde_json::from_str::<BoardCollaborationStore>(&content) else {
            tracing::warn!(
                path = %path.to_string_lossy(),
                "failed to parse persisted board collaboration state"
            );
            return;
        };
        let mut collaboration = self.board_collaboration.write().await;
        *collaboration = store;
    }

    async fn persist_board_collaboration_snapshot(
        &self,
        snapshot: &BoardCollaborationStore,
    ) -> Result<()> {
        let path = self.board_collaboration_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let content = serde_json::to_string_pretty(snapshot)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub async fn push_board_activity(
        &self,
        project_id: &str,
        source: impl Into<String>,
        action: impl Into<String>,
        detail: impl Into<String>,
    ) {
        let snapshot = {
            let mut collaboration = self.board_collaboration.write().await;
            let project = collaboration
                .projects
                .entry(project_id.to_string())
                .or_default();
            project.activity.insert(
                0,
                BoardActivityRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: source.into(),
                    action: action.into(),
                    detail: detail.into(),
                    timestamp: Utc::now().to_rfc3339(),
                },
            );
            if project.activity.len() > MAX_BOARD_ACTIVITY {
                project.activity.truncate(MAX_BOARD_ACTIVITY);
            }
            collaboration.clone()
        };

        if let Err(err) = self.persist_board_collaboration_snapshot(&snapshot).await {
            tracing::warn!(error = %err, "failed to persist board activity");
        }
    }

    pub async fn recent_board_activity(&self, project_id: &str) -> Vec<BoardActivityRecord> {
        self.board_collaboration
            .read()
            .await
            .projects
            .get(project_id)
            .map(|value| value.activity.clone())
            .unwrap_or_default()
    }

    pub async fn add_board_comment(
        &self,
        project_id: &str,
        task_id: &str,
        author: impl Into<String>,
        author_email: Option<String>,
        provider: Option<String>,
        body: impl Into<String>,
    ) -> BoardCommentRecord {
        let record = BoardCommentRecord {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            author: author.into(),
            author_email,
            provider,
            body: body.into(),
            timestamp: Utc::now().to_rfc3339(),
        };

        let snapshot = {
            let mut collaboration = self.board_collaboration.write().await;
            let project = collaboration
                .projects
                .entry(project_id.to_string())
                .or_default();
            let comments = project
                .task_comments
                .entry(task_id.to_string())
                .or_default();
            comments.push(record.clone());
            if comments.len() > MAX_TASK_COMMENTS {
                let start = comments.len().saturating_sub(MAX_TASK_COMMENTS);
                comments.drain(0..start);
            }
            collaboration.clone()
        };

        if let Err(err) = self.persist_board_collaboration_snapshot(&snapshot).await {
            tracing::warn!(error = %err, "failed to persist board comment");
        }

        record
    }

    pub async fn task_comments(
        &self,
        project_id: &str,
    ) -> HashMap<String, Vec<BoardCommentRecord>> {
        self.board_collaboration
            .read()
            .await
            .projects
            .get(project_id)
            .map(|value| value.task_comments.clone())
            .unwrap_or_default()
    }

    pub async fn record_webhook_delivery(
        &self,
        project_id: &str,
        event: impl Into<String>,
        action: impl Into<String>,
        status: impl Into<String>,
        detail: impl Into<String>,
        repository: Option<String>,
    ) {
        let snapshot = {
            let mut collaboration = self.board_collaboration.write().await;
            let project = collaboration
                .projects
                .entry(project_id.to_string())
                .or_default();
            project.webhook_deliveries.insert(
                0,
                WebhookDeliveryRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    event: event.into(),
                    action: action.into(),
                    status: status.into(),
                    detail: detail.into(),
                    repository,
                    timestamp: Utc::now().to_rfc3339(),
                },
            );
            if project.webhook_deliveries.len() > MAX_WEBHOOK_DELIVERIES {
                project.webhook_deliveries.truncate(MAX_WEBHOOK_DELIVERIES);
            }
            collaboration.clone()
        };

        if let Err(err) = self.persist_board_collaboration_snapshot(&snapshot).await {
            tracing::warn!(error = %err, "failed to persist webhook delivery");
        }
    }

    pub async fn recent_webhook_deliveries(&self, project_id: &str) -> Vec<WebhookDeliveryRecord> {
        self.board_collaboration
            .read()
            .await
            .projects
            .get(project_id)
            .map(|value| value.webhook_deliveries.clone())
            .unwrap_or_default()
    }
}
