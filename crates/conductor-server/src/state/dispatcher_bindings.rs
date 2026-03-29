use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

use super::{AppState, CreateDispatcherThreadOptions};

const MAX_PROJECT_BINDINGS: usize = 200;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatcherBindingRecord {
    pub id: String,
    pub project_id: String,
    pub provider: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub bridge_id: Option<String>,
    #[serde(default)]
    pub dispatcher_thread_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DispatcherBindingLookup {
    pub binding_id: Option<String>,
    pub provider: Option<String>,
    pub thread_id: Option<String>,
    pub session_id: Option<String>,
    pub channel_id: Option<String>,
    pub bridge_id: Option<String>,
    pub dispatcher_thread_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct UpsertDispatcherBindingInput {
    pub binding_id: Option<String>,
    pub provider: String,
    pub thread_id: Option<String>,
    pub session_id: Option<String>,
    pub channel_id: Option<String>,
    pub bridge_id: Option<String>,
    pub dispatcher_thread_id: Option<String>,
    pub create_dispatcher: bool,
    pub force_new_dispatcher: bool,
    pub dispatcher_agent: Option<String>,
    pub implementation_agent: Option<String>,
    pub dispatcher_model: Option<String>,
    pub dispatcher_reasoning_effort: Option<String>,
    pub implementation_model: Option<String>,
    pub implementation_reasoning_effort: Option<String>,
    pub title: Option<String>,
    pub metadata: HashMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct DispatcherBindingStore {
    #[serde(default)]
    projects: HashMap<String, Vec<DispatcherBindingRecord>>,
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn lookup_has_explicit_target(lookup: &DispatcherBindingLookup) -> bool {
    lookup.binding_id.is_some()
        || lookup.thread_id.is_some()
        || lookup.session_id.is_some()
        || lookup.channel_id.is_some()
        || lookup.dispatcher_thread_id.is_some()
}

fn binding_matches_lookup(
    binding: &DispatcherBindingRecord,
    lookup: &DispatcherBindingLookup,
) -> bool {
    if let Some(binding_id) = lookup.binding_id.as_deref() {
        return binding.id == binding_id;
    }

    if let Some(provider) = lookup.provider.as_deref() {
        if binding.provider != provider {
            return false;
        }
    }
    if let Some(thread_id) = lookup.thread_id.as_deref() {
        if binding.thread_id.as_deref() != Some(thread_id) {
            return false;
        }
    }
    if let Some(session_id) = lookup.session_id.as_deref() {
        if binding.session_id.as_deref() != Some(session_id) {
            return false;
        }
    }
    if let Some(channel_id) = lookup.channel_id.as_deref() {
        if binding.channel_id.as_deref() != Some(channel_id) {
            return false;
        }
    }
    if let Some(bridge_id) = lookup.bridge_id.as_deref() {
        if binding.bridge_id.as_deref() != Some(bridge_id) {
            return false;
        }
    }
    if let Some(dispatcher_thread_id) = lookup.dispatcher_thread_id.as_deref() {
        if binding.dispatcher_thread_id.as_deref() != Some(dispatcher_thread_id) {
            return false;
        }
    }

    true
}

fn find_matching_binding_index(
    bindings: &[DispatcherBindingRecord],
    lookup: &DispatcherBindingLookup,
) -> Option<usize> {
    bindings
        .iter()
        .position(|binding| binding_matches_lookup(binding, lookup))
}

fn upsert_lookup(input: &UpsertDispatcherBindingInput) -> DispatcherBindingLookup {
    DispatcherBindingLookup {
        binding_id: normalize_optional_text(input.binding_id.clone()),
        provider: Some(input.provider.clone()),
        thread_id: normalize_optional_text(input.thread_id.clone()),
        session_id: normalize_optional_text(input.session_id.clone()),
        channel_id: normalize_optional_text(input.channel_id.clone()),
        bridge_id: normalize_optional_text(input.bridge_id.clone()),
        dispatcher_thread_id: None,
    }
}

impl AppState {
    pub fn dispatcher_bindings_path(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("dispatcher-bindings.json")
    }

    pub(crate) async fn load_dispatcher_bindings_from_disk(&self) {
        let path = self.dispatcher_bindings_path();
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            return;
        };
        let Ok(store) = serde_json::from_str::<DispatcherBindingStore>(&content) else {
            tracing::warn!(
                path = %path.to_string_lossy(),
                "failed to parse persisted dispatcher bindings"
            );
            return;
        };
        let mut bindings = self.dispatcher_bindings.write().await;
        *bindings = store.projects;
    }

    async fn persist_dispatcher_bindings_snapshot(
        &self,
        snapshot: &HashMap<String, Vec<DispatcherBindingRecord>>,
    ) -> Result<()> {
        let path = self.dispatcher_bindings_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let content = serde_json::to_string_pretty(&DispatcherBindingStore {
            projects: snapshot.clone(),
        })?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub(crate) async fn list_dispatcher_bindings(
        &self,
        project_id: &str,
        lookup: Option<&DispatcherBindingLookup>,
    ) -> Vec<DispatcherBindingRecord> {
        let mut bindings = self
            .dispatcher_bindings
            .read()
            .await
            .get(project_id)
            .cloned()
            .unwrap_or_default();
        if let Some(lookup) = lookup {
            bindings.retain(|binding| binding_matches_lookup(binding, lookup));
        }
        bindings.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(right.created_at.cmp(&left.created_at))
        });
        bindings
    }

    pub(crate) async fn get_dispatcher_binding(
        &self,
        project_id: &str,
        lookup: &DispatcherBindingLookup,
    ) -> Option<DispatcherBindingRecord> {
        if !lookup_has_explicit_target(lookup) {
            return None;
        }
        self.list_dispatcher_bindings(project_id, Some(lookup))
            .await
            .into_iter()
            .next()
    }

    pub(crate) async fn upsert_dispatcher_binding(
        self: &Arc<Self>,
        project_id: &str,
        mut input: UpsertDispatcherBindingInput,
    ) -> Result<DispatcherBindingRecord> {
        input.provider = input.provider.trim().to_string();
        if input.provider.is_empty() {
            return Err(anyhow!("provider is required"));
        }

        input.binding_id = normalize_optional_text(input.binding_id);
        input.thread_id = normalize_optional_text(input.thread_id);
        input.session_id = normalize_optional_text(input.session_id);
        input.channel_id = normalize_optional_text(input.channel_id);
        input.bridge_id = normalize_optional_text(input.bridge_id);
        input.dispatcher_thread_id = normalize_optional_text(input.dispatcher_thread_id);
        input.title = normalize_optional_text(input.title);
        input.dispatcher_agent = normalize_optional_text(input.dispatcher_agent);
        input.implementation_agent = normalize_optional_text(input.implementation_agent);
        input.dispatcher_model = normalize_optional_text(input.dispatcher_model);
        input.dispatcher_reasoning_effort =
            normalize_optional_text(input.dispatcher_reasoning_effort);
        input.implementation_model = normalize_optional_text(input.implementation_model);
        input.implementation_reasoning_effort =
            normalize_optional_text(input.implementation_reasoning_effort);

        if input.thread_id.is_none() && input.session_id.is_none() && input.channel_id.is_none() {
            return Err(anyhow!("threadId, sessionId, or channelId is required"));
        }

        let config = self.config.read().await.clone();
        if !config.projects.contains_key(project_id) {
            return Err(anyhow!("Unknown project: {project_id}"));
        }
        drop(config);

        let lookup = upsert_lookup(&input);
        let existing = self.get_dispatcher_binding(project_id, &lookup).await;
        let now = Utc::now().to_rfc3339();

        let mut dispatcher_thread_id = input.dispatcher_thread_id.clone().or_else(|| {
            existing
                .as_ref()
                .and_then(|binding| binding.dispatcher_thread_id.clone())
        });
        let mut bridge_id = input.bridge_id.clone().or_else(|| {
            existing
                .as_ref()
                .and_then(|binding| binding.bridge_id.clone())
        });

        if let Some(thread_id) = dispatcher_thread_id.clone() {
            let dispatcher = self
                .get_dispatcher_thread(&thread_id)
                .await
                .with_context(|| format!("Unknown dispatcher thread {thread_id}"))?;
            if dispatcher.project_id != project_id {
                return Err(anyhow!(
                    "Dispatcher thread {thread_id} does not belong to project {project_id}"
                ));
            }
            if let Some(expected_bridge_id) = bridge_id.as_deref() {
                if dispatcher.bridge_id.as_deref() != Some(expected_bridge_id) {
                    return Err(anyhow!(
                        "Dispatcher thread {thread_id} is not scoped to bridge {expected_bridge_id}"
                    ));
                }
            } else {
                bridge_id = dispatcher.bridge_id.clone();
            }
        }

        if input.create_dispatcher || input.force_new_dispatcher {
            let dispatcher = self
                .create_project_dispatcher_thread(
                    project_id,
                    CreateDispatcherThreadOptions {
                        bridge_id: bridge_id.clone(),
                        dispatcher_agent: input.dispatcher_agent.clone(),
                        implementation_agent: input.implementation_agent.clone(),
                        dispatcher_model: input.dispatcher_model.clone(),
                        dispatcher_reasoning_effort: input.dispatcher_reasoning_effort.clone(),
                        implementation_model: input.implementation_model.clone(),
                        implementation_reasoning_effort: input
                            .implementation_reasoning_effort
                            .clone(),
                        force_new: input.force_new_dispatcher,
                    },
                )
                .await?;
            bridge_id = dispatcher.bridge_id.clone().or(bridge_id);
            dispatcher_thread_id = Some(dispatcher.id);
        }

        let binding = DispatcherBindingRecord {
            id: existing
                .as_ref()
                .map(|binding| binding.id.clone())
                .or_else(|| input.binding_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            project_id: project_id.to_string(),
            provider: input.provider,
            thread_id: input.thread_id.clone().or_else(|| {
                existing
                    .as_ref()
                    .and_then(|binding| binding.thread_id.clone())
            }),
            session_id: input.session_id.clone().or_else(|| {
                existing
                    .as_ref()
                    .and_then(|binding| binding.session_id.clone())
            }),
            channel_id: input.channel_id.clone().or_else(|| {
                existing
                    .as_ref()
                    .and_then(|binding| binding.channel_id.clone())
            }),
            bridge_id,
            dispatcher_thread_id,
            title: input
                .title
                .clone()
                .or_else(|| existing.as_ref().and_then(|binding| binding.title.clone())),
            metadata: if input.metadata.is_empty() {
                existing
                    .as_ref()
                    .map(|binding| binding.metadata.clone())
                    .unwrap_or_default()
            } else {
                input.metadata.clone()
            },
            created_at: existing
                .as_ref()
                .map(|binding| binding.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
        };

        let snapshot = {
            let mut bindings = self.dispatcher_bindings.write().await;
            let project_bindings = bindings.entry(project_id.to_string()).or_default();
            if let Some(index) = find_matching_binding_index(project_bindings, &lookup) {
                project_bindings[index] = binding.clone();
            } else {
                project_bindings.insert(0, binding.clone());
            }
            project_bindings.sort_by(|left, right| {
                right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then(right.created_at.cmp(&left.created_at))
            });
            if project_bindings.len() > MAX_PROJECT_BINDINGS {
                project_bindings.truncate(MAX_PROJECT_BINDINGS);
            }
            bindings.clone()
        };

        self.persist_dispatcher_bindings_snapshot(&snapshot).await?;
        if binding.provider.eq_ignore_ascii_case("openclaw") {
            if let Some(dispatcher_thread_id) = binding.dispatcher_thread_id.as_deref() {
                let _ = self
                    .update_dispatcher_integration_binding(
                        dispatcher_thread_id,
                        Some(binding.thread_id.clone()),
                        Some(binding.session_id.clone()),
                    )
                    .await;
            }
        }
        Ok(binding)
    }

    pub(crate) async fn clear_dispatcher_binding_thread(&self, thread_id: &str) -> Result<()> {
        let snapshot = {
            let mut bindings = self.dispatcher_bindings.write().await;
            let mut changed = false;
            for project_bindings in bindings.values_mut() {
                for binding in project_bindings.iter_mut() {
                    if binding.dispatcher_thread_id.as_deref() == Some(thread_id) {
                        binding.dispatcher_thread_id = None;
                        binding.updated_at = Utc::now().to_rfc3339();
                        changed = true;
                    }
                }
            }
            if !changed {
                return Ok(());
            }
            bindings.clone()
        };

        self.persist_dispatcher_bindings_snapshot(&snapshot).await
    }
}

#[cfg(test)]
mod tests {
    use super::{
        binding_matches_lookup, find_matching_binding_index, upsert_lookup,
        DispatcherBindingLookup, DispatcherBindingRecord, UpsertDispatcherBindingInput,
    };
    use std::collections::HashMap;

    fn binding(id: &str, bridge_id: Option<&str>) -> DispatcherBindingRecord {
        DispatcherBindingRecord {
            id: id.to_string(),
            project_id: "demo".to_string(),
            provider: "openclaw".to_string(),
            thread_id: Some("discord-thread-42".to_string()),
            session_id: Some("openclaw-session-9".to_string()),
            channel_id: None,
            bridge_id: bridge_id.map(str::to_string),
            dispatcher_thread_id: Some(format!("dispatcher-{id}")),
            title: None,
            metadata: HashMap::new(),
            created_at: "2026-03-29T00:00:00Z".to_string(),
            updated_at: "2026-03-29T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn binding_lookup_respects_bridge_scope() {
        let scoped = binding("a", Some("bridge-a"));
        let lookup = DispatcherBindingLookup {
            provider: Some("openclaw".to_string()),
            thread_id: Some("discord-thread-42".to_string()),
            bridge_id: Some("bridge-a".to_string()),
            ..DispatcherBindingLookup::default()
        };

        assert!(binding_matches_lookup(&scoped, &lookup));

        let mismatched_lookup = DispatcherBindingLookup {
            bridge_id: Some("bridge-b".to_string()),
            ..lookup
        };
        assert!(!binding_matches_lookup(&scoped, &mismatched_lookup));
    }

    #[test]
    fn upsert_lookup_keeps_bridge_scope_for_existing_binding_matches() {
        let bindings = vec![
            binding("a", Some("bridge-a")),
            binding("b", Some("bridge-b")),
        ];
        let lookup = upsert_lookup(&UpsertDispatcherBindingInput {
            provider: "openclaw".to_string(),
            thread_id: Some("discord-thread-42".to_string()),
            bridge_id: Some("bridge-b".to_string()),
            ..UpsertDispatcherBindingInput::default()
        });

        assert_eq!(lookup.bridge_id.as_deref(), Some("bridge-b"));
        assert_eq!(find_matching_binding_index(&bindings, &lookup), Some(1));
    }
}
