use anyhow::{Context, Result};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use super::{ConversationEntry, SessionRecord, SessionStatus, SpawnRequest};
use crate::state::AppState;

const MAX_GLOBAL_CONCURRENT_LAUNCHES: usize = 5;
const MAX_PROJECT_CONCURRENT_LAUNCHES: usize = 2;
const SPAWN_REQUEST_METADATA_KEY: &str = "spawnRequest";
const QUEUED_AT_METADATA_KEY: &str = "queuedAt";
const QUEUED_SOURCE_METADATA_KEY: &str = "queueSource";
const QUEUE_ERROR_METADATA_KEY: &str = "queueError";
const LAUNCH_ATTEMPTS_METADATA_KEY: &str = "launchAttempts";
const LAUNCH_STATE_METADATA_KEY: &str = "launchState";
const LAUNCH_STARTED_AT_METADATA_KEY: &str = "launchStartedAt";

fn session_occupies_launch_capacity(session: &SessionRecord, is_live: bool) -> bool {
    if session.status.is_terminal() || session.status == SessionStatus::Queued {
        return false;
    }

    if matches!(session.status, SessionStatus::NeedsInput | SessionStatus::Stuck | SessionStatus::Errored) {
        return false;
    }

    session.status == SessionStatus::Spawning || is_live
}

impl AppState {
    pub async fn spawn_session(self: &Arc<Self>, request: SpawnRequest) -> Result<SessionRecord> {
        self.enqueue_session_spawn(request).await
    }

    pub async fn enqueue_session_spawn(
        self: &Arc<Self>,
        request: SpawnRequest,
    ) -> Result<SessionRecord> {
        let config = self.config.read().await.clone();
        let project = config
            .projects
            .get(&request.project_id)
            .cloned()
            .with_context(|| format!("Unknown project: {}", request.project_id))?;

        let requested_agent = request
            .agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let project_agent = requested_agent
            .or_else(|| project.agent.clone())
            .unwrap_or_else(|| config.preferences.coding_agent.clone());

        let session_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let spawn_request = serde_json::to_string(&request)?;

        let mut record = SessionRecord::new(
            session_id.clone(),
            request.project_id.clone(),
            request.branch.clone(),
            request.issue_id.clone(),
            None,
            project_agent,
            request.model.clone(),
            request.reasoning_effort.clone(),
            request.prompt.clone(),
            None,
        );
        record.status = SessionStatus::Queued;
        record.activity = Some("idle".to_string());
        record.summary = Some("Queued for launch".to_string());
        record
            .metadata
            .insert("summary".to_string(), "Queued for launch".to_string());
        record
            .metadata
            .insert(SPAWN_REQUEST_METADATA_KEY.to_string(), spawn_request);
        record
            .metadata
            .insert(QUEUED_AT_METADATA_KEY.to_string(), now.clone());
        record.metadata.insert(
            QUEUED_SOURCE_METADATA_KEY.to_string(),
            request.source.clone(),
        );
        record
            .metadata
            .insert(LAUNCH_ATTEMPTS_METADATA_KEY.to_string(), "0".to_string());
        record
            .metadata
            .insert(LAUNCH_STATE_METADATA_KEY.to_string(), "queued".to_string());
        record.created_at = now.clone();
        record.last_activity_at = now;
        record.conversation.push(ConversationEntry {
            id: Uuid::new_v4().to_string(),
            kind: "user_message".to_string(),
            source: request.source,
            text: request.prompt.clone(),
            created_at: Utc::now().to_rfc3339(),
            attachments: request.attachments.clone(),
            metadata: HashMap::new(),
        });

        self.replace_session(record.clone()).await?;
        self.kick_spawn_supervisor();
        Ok(record)
    }

    pub(crate) fn kick_spawn_supervisor(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let _guard = state.spawn_guard.lock().await;

            loop {
                let Some((session_id, request)) = state.next_queueable_spawn().await else {
                    break;
                };

                if let Err(err) = state.mark_queued_session_launching(&session_id).await {
                    tracing::warn!(session_id, error = %err, "Failed to mark queued session as launching");
                    continue;
                }

                match state
                    .spawn_session_now(request.clone(), Some(session_id.clone()))
                    .await
                {
                    Ok(_) => {}
                    Err(err) => {
                        tracing::warn!(session_id, error = %err, "Queued session launch failed");
                        let _ = state
                            .mark_queued_session_failed(&session_id, &err.to_string())
                            .await;
                    }
                }
            }
        });
    }

    async fn next_queueable_spawn(&self) -> Option<(String, SpawnRequest)> {
        let (queued_ids, active_prompts) = {
            let sessions = self.sessions.read().await;
            let live_ids = self
                .live_sessions
                .read()
                .await
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>();

            let mut queued = sessions
                .values()
                .filter(|session| session.status == SessionStatus::Queued)
                .map(|session| (session.created_at.clone(), session.id.clone()))
                .collect::<Vec<_>>();
            queued.sort_by(|left, right| left.0.cmp(&right.0));
            let queued_ids: Vec<_> = queued.into_iter().map(|(_, id)| id).collect();

            // Collect (project_id, prompt) pairs for all active (non-terminal, non-queued) sessions.
            let active_prompts: std::collections::HashSet<(String, String)> = sessions
                .values()
                .filter(|s| {
                    !s.status.is_terminal()
                        && s.status != SessionStatus::Queued
                        && (s.status == SessionStatus::Spawning || live_ids.contains(&s.id))
                })
                .map(|s| (s.project_id.clone(), s.prompt.clone()))
                .collect();

            (queued_ids, active_prompts)
        };

        if queued_ids.is_empty() {
            return None;
        }

        let (global_active, per_project_active) = self.launch_capacity_snapshot().await;
        if global_active >= MAX_GLOBAL_CONCURRENT_LAUNCHES {
            return None;
        }

        for session_id in queued_ids {
            let Some(session) = self.get_session(&session_id).await else {
                continue;
            };

            // Dedup: skip if an active session already exists for the same project + prompt.
            if active_prompts.contains(&(session.project_id.clone(), session.prompt.clone())) {
                tracing::debug!(
                    session_id,
                    project_id = session.project_id,
                    "Skipping duplicate spawn: active session exists with same prompt"
                );
                continue;
            }

            let project_active = per_project_active
                .get(&session.project_id)
                .copied()
                .unwrap_or_default();
            if project_active >= MAX_PROJECT_CONCURRENT_LAUNCHES {
                continue;
            }

            let Some(raw_request) = session.metadata.get(SPAWN_REQUEST_METADATA_KEY).cloned()
            else {
                let _ = self
                    .mark_queued_session_failed(
                        &session_id,
                        "Queued session is missing spawn request metadata",
                    )
                    .await;
                continue;
            };

            match serde_json::from_str::<SpawnRequest>(&raw_request) {
                Ok(request) => return Some((session_id, request)),
                Err(err) => {
                    let _ = self
                        .mark_queued_session_failed(
                            &session_id,
                            &format!("Invalid queued spawn request: {err}"),
                        )
                        .await;
                }
            }
        }

        None
    }

    async fn launch_capacity_snapshot(&self) -> (usize, HashMap<String, usize>) {
        let live_session_ids = self
            .live_sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let sessions = self.sessions.read().await;
        let mut global = 0usize;
        let mut per_project = HashMap::new();

        for session in sessions.values() {
            if !session_occupies_launch_capacity(session, live_session_ids.contains(&session.id)) {
                continue;
            }
            global += 1;
            *per_project.entry(session.project_id.clone()).or_insert(0) += 1;
        }

        (global, per_project)
    }

    async fn mark_queued_session_launching(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Queued session {session_id} not found"))?;
        if session.status != SessionStatus::Queued {
            return Ok(());
        }

        session.status = SessionStatus::Spawning;
        session.activity = Some("active".to_string());
        session.last_activity_at = Utc::now().to_rfc3339();
        session.summary = Some("Launching queued session".to_string());
        session.metadata.insert(
            "summary".to_string(),
            "Launching queued session".to_string(),
        );
        let attempts = session
            .metadata
            .get(LAUNCH_ATTEMPTS_METADATA_KEY)
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0)
            + 1;
        session.metadata.insert(
            LAUNCH_ATTEMPTS_METADATA_KEY.to_string(),
            attempts.to_string(),
        );
        session.metadata.insert(
            LAUNCH_STATE_METADATA_KEY.to_string(),
            "launching".to_string(),
        );
        session.metadata.insert(
            LAUNCH_STARTED_AT_METADATA_KEY.to_string(),
            Utc::now().to_rfc3339(),
        );
        session.metadata.remove(QUEUE_ERROR_METADATA_KEY);

        let updated = session.clone();
        drop(sessions);
        self.replace_session(updated).await
    }

    async fn mark_queued_session_failed(&self, session_id: &str, error: &str) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .with_context(|| format!("Queued session {session_id} not found"))?;

        session.status = SessionStatus::Errored;
        session.activity = Some("exited".to_string());
        session.last_activity_at = Utc::now().to_rfc3339();
        session.summary = Some(error.trim().to_string());
        session
            .metadata
            .insert("summary".to_string(), error.trim().to_string());
        session.metadata.insert(
            QUEUE_ERROR_METADATA_KEY.to_string(),
            error.trim().to_string(),
        );
        session
            .metadata
            .insert(LAUNCH_STATE_METADATA_KEY.to_string(), "failed".to_string());

        let updated = session.clone();
        drop(sessions);
        self.replace_session(updated).await
    }
}
