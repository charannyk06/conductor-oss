use anyhow::{Context, Result};
use conductor_core::board::Board;
use conductor_core::config::{ConductorConfig, ProjectConfig};
use conductor_core::event::{Event, EventBus};
use conductor_core::support::{
    resolve_project_path, startup_config_sync, sync_workspace_support_files,
};
use conductor_core::task::TaskState;
use conductor_core::types::AgentKind;
use conductor_watcher::BoardWatcher;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};

use crate::state::{AppState, SessionStatus, SpawnRequest};

const MAX_GLOBAL_AUTODISPATCH_SESSIONS: usize = 5;
const MAX_PROJECT_AUTODISPATCH_SESSIONS: usize = 2;
const AUTODISPATCH_RETRY_INTERVAL: Duration = Duration::from_secs(10);

pub struct RuntimeHandles {
    _watchers: Vec<BoardWatcher>,
    _automation_task: JoinHandle<()>,
}

pub async fn initialize_runtime(
    config: &ConductorConfig,
    state: Arc<AppState>,
    event_bus: EventBus,
) -> Result<RuntimeHandles> {
    let config_sync = startup_config_sync(config, &state.workspace_path, false)?;
    if config_sync.regenerated > 0 || config_sync.skipped_unmanaged > 0 {
        tracing::info!(
            regenerated = config_sync.regenerated,
            skipped_unmanaged = config_sync.skipped_unmanaged,
            "Synced project-local conductor.yaml mirrors"
        );
    }

    let support_file_locations = sync_workspace_support_files(config, &state.workspace_path)?;
    if support_file_locations > 0 {
        tracing::info!(
            locations = support_file_locations,
            "Synced workspace support files from Rust runtime"
        );
    }

    let board_paths = collect_board_paths(config, &state.workspace_path);
    let watchers = if board_paths.is_empty() {
        Vec::new()
    } else {
        vec![BoardWatcher::new(event_bus.clone(), board_paths.clone())?]
    };

    let project_board_map = board_paths
        .iter()
        .map(|(project_id, path)| (project_id.clone(), path.clone()))
        .collect::<HashMap<_, _>>();
    let automation_state = state.clone();
    let automation_bus = event_bus.clone();
    let automation_task = tokio::spawn(async move {
        run_board_automation(automation_state, automation_bus, project_board_map).await;
    });

    for (project_id, board_path) in &board_paths {
        if board_path.exists() {
            event_bus.publish(Event::BoardChanged {
                project_id: project_id.clone(),
                path: board_path.display().to_string(),
            });
        }
    }

    Ok(RuntimeHandles {
        _watchers: watchers,
        _automation_task: automation_task,
    })
}

fn collect_board_paths(config: &ConductorConfig, workspace_path: &Path) -> Vec<(String, PathBuf)> {
    config
        .projects
        .iter()
        .map(|(project_id, project)| {
            (
                project_id.clone(),
                resolve_board_path(workspace_path, project_id, project),
            )
        })
        .collect()
}

fn resolve_board_path(workspace_path: &Path, project_id: &str, project: &ProjectConfig) -> PathBuf {
    let project_root = resolve_project_path(workspace_path, &project.path);
    let basename = project_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(project_id);
    let board_dir = project.board_dir.as_deref().unwrap_or(project_id).trim();

    let mut candidates = Vec::new();
    if !board_dir.is_empty() {
        if board_dir.ends_with(".md") {
            candidates.push(PathBuf::from(board_dir));
            candidates.push(workspace_path.join("projects").join(board_dir));
        } else {
            candidates.push(PathBuf::from(board_dir).join("CONDUCTOR.md"));
            candidates.push(
                workspace_path
                    .join("projects")
                    .join(board_dir)
                    .join("CONDUCTOR.md"),
            );
        }
    }

    candidates.push(project_root.join("CONDUCTOR.md"));
    candidates.push(
        workspace_path
            .join("projects")
            .join(basename)
            .join("CONDUCTOR.md"),
    );
    candidates.push(workspace_path.join("CONDUCTOR.md"));

    for candidate in &candidates {
        let resolved = if candidate.is_absolute() {
            candidate.clone()
        } else {
            workspace_path.join(candidate)
        };
        if resolved.exists() {
            return resolved;
        }
    }

    let fallback = candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| project_root.join("CONDUCTOR.md"));
    if fallback.is_absolute() {
        fallback
    } else {
        workspace_path.join(fallback)
    }
}

async fn run_board_automation(
    state: Arc<AppState>,
    event_bus: EventBus,
    project_board_map: HashMap<String, PathBuf>,
) {
    run_board_automation_with_retry_interval(
        state,
        event_bus,
        project_board_map,
        AUTODISPATCH_RETRY_INTERVAL,
    )
    .await;
}

async fn run_board_automation_with_retry_interval(
    state: Arc<AppState>,
    event_bus: EventBus,
    project_board_map: HashMap<String, PathBuf>,
    retry_interval: Duration,
) {
    let mut receiver = event_bus.subscribe();
    let mut retry_tick = tokio::time::interval_at(Instant::now() + retry_interval, retry_interval);
    retry_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        let Event::BoardChanged { project_id, .. } = &*event else {
                            continue;
                        };

                        let Some(board_path) = project_board_map.get(project_id).cloned() else {
                            continue;
                        };

                        if let Err(err) = process_board_change(state.clone(), project_id.clone(), board_path).await
                        {
                            tracing::warn!(project_id, error = %err, "Rust board automation failed");
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "Board automation lagged behind board-change events");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = retry_tick.tick() => {
                for (project_id, board_path) in &project_board_map {
                    if let Err(err) = process_board_change(state.clone(), project_id.clone(), board_path.clone()).await
                    {
                        tracing::warn!(project_id, error = %err, "Rust board automation retry tick failed");
                    }
                }
            }
        }
    }
}

async fn process_board_change(
    state: Arc<AppState>,
    project_id: String,
    board_path: PathBuf,
) -> Result<()> {
    if !board_path.exists() {
        return Ok(());
    }

    let board = Board::from_file(&board_path)
        .with_context(|| format!("Failed to parse board {}", board_path.display()))?;
    let ready_cards = board.dispatchable_cards();
    if ready_cards.is_empty() {
        return Ok(());
    }

    // Serialize board-triggered spawns to prevent TOCTOU races in limit checks
    let _spawn_guard = state.spawn_guard.lock().await;

    let (active_global, active_project) = active_session_counts(&state, &project_id).await;
    let mut available_global = MAX_GLOBAL_AUTODISPATCH_SESSIONS.saturating_sub(active_global);
    let mut available_project = MAX_PROJECT_AUTODISPATCH_SESSIONS.saturating_sub(active_project);
    if available_global == 0 || available_project == 0 {
        return Ok(());
    }

    let config = state.config.read().await.clone();
    let project_default_agent = config
        .projects
        .get(&project_id)
        .and_then(|project| project.agent.clone())
        .unwrap_or_else(|| config.preferences.coding_agent.clone());

    let mut moved_cards = Vec::new();
    for card in ready_cards {
        if available_global == 0 || available_project == 0 {
            break;
        }

        let agent = resolve_card_agent(&card.tags)
            .unwrap_or_else(|| AgentKind::parse(&project_default_agent))
            .to_string();
        let model = card.metadata.get("model").cloned();
        let reasoning_effort = card.metadata.get("reasoningEffort").cloned();

        let spawn_result = state
            .spawn_session(SpawnRequest {
                project_id: project_id.clone(),
                prompt: card.title.clone(),
                issue_id: None,
                agent: Some(agent),
                use_worktree: Some(true),
                permission_mode: None,
                model,
                reasoning_effort,
                branch: None,
                base_branch: None,
                attachments: Vec::new(),
                source: "board_dispatch".to_string(),
            })
            .await;

        match spawn_result {
            Ok(session) => {
                tracing::info!(
                    project_id,
                    session_id = session.id,
                    title = card.title,
                    "Queued session from Rust board automation"
                );
                moved_cards.push(card.title.clone());
                available_global = available_global.saturating_sub(1);
                available_project = available_project.saturating_sub(1);
            }
            Err(err) => {
                tracing::warn!(
                    project_id,
                    title = card.title,
                    error = %err,
                    "Failed to spawn session from board"
                );
            }
        }
    }

    if moved_cards.is_empty() {
        return Ok(());
    }

    let mut updated_board = Board::from_file(&board_path)
        .with_context(|| format!("Failed to reload board {}", board_path.display()))?;
    for title in moved_cards {
        updated_board.move_card(&title, TaskState::Dispatching);
    }
    updated_board
        .write_to_file(&board_path)
        .with_context(|| format!("Failed to update board {}", board_path.display()))?;

    Ok(())
}

async fn active_session_counts(state: &Arc<AppState>, project_id: &str) -> (usize, usize) {
    let live_session_ids = state
        .live_sessions
        .read()
        .await
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let sessions = state.sessions.read().await;
    let mut global = 0usize;
    let mut project = 0usize;
    for session in sessions.values() {
        if session.status.is_terminal()
            || session.status == SessionStatus::Queued
            || matches!(session.status, SessionStatus::NeedsInput | SessionStatus::Stuck | SessionStatus::Errored)
        {
            continue;
        }
        let is_live = live_session_ids.contains(&session.id);
        if session.status != SessionStatus::Spawning && !is_live {
            continue;
        }
        global += 1;
        if session.project_id == project_id {
            project += 1;
        }
    }
    (global, project)
}

fn resolve_card_agent(tags: &[String]) -> Option<AgentKind> {
    for tag in tags {
        let normalized = tag.trim().trim_start_matches('@').trim_start_matches('#');
        let candidate = normalized
            .strip_prefix("agent/")
            .unwrap_or(normalized)
            .trim();
        if candidate.is_empty() {
            continue;
        }
        let parsed = AgentKind::parse(candidate);
        if !matches!(parsed, AgentKind::Custom(_)) {
            return Some(parsed);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use conductor_core::config::ConductorConfig;
    use conductor_db::Database;
    use conductor_executors::executor::{
        Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::timeout;
    use uuid::Uuid;

    struct TestExecutor;

    #[async_trait]
    impl Executor for TestExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Test Executor"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/true")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, _options: SpawnOptions) -> Result<ExecutorHandle> {
            let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8);
            drop(output_tx);
            let (input_tx, _input_rx) = mpsc::channel::<ExecutorInput>(8);
            let (kill_tx, _kill_rx) = oneshot::channel();
            Ok(ExecutorHandle::new(
                1,
                self.kind(),
                output_rx,
                input_tx,
                kill_tx,
            ))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            Vec::new()
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    async fn wait_for_condition<F, T>(label: &str, mut check: F) -> T
    where
        F: FnMut() -> Option<T>,
    {
        timeout(Duration::from_secs(3), async move {
            loop {
                if let Some(value) = check() {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
    }

    #[tokio::test]
    async fn board_automation_retries_ready_cards_without_new_board_events() {
        let root = std::env::temp_dir().join(format!("conductor-runtime-test-{}", Uuid::new_v4()));
        let project_root = root.join("repo");
        fs::create_dir_all(&project_root).unwrap();
        let board_path = project_root.join("CONDUCTOR.md");
        fs::write(
            &board_path,
            [
                "## Ready to Dispatch",
                "",
                "- [ ] Task one",
                "- [ ] Task two",
                "- [ ] Task three",
                "",
                "## Dispatching",
                "",
            ]
            .join("\n"),
        )
        .unwrap();

        let mut config = ConductorConfig::default();
        config.workspace = root.clone();
        config.preferences.coding_agent = "codex".to_string();
        config.projects = BTreeMap::from([(
            "demo".to_string(),
            ProjectConfig {
                path: project_root.to_string_lossy().to_string(),
                agent: Some("codex".to_string()),
                runtime: Some("direct".to_string()),
                ..ProjectConfig::default()
            },
        )]);

        let db = Database::in_memory().await.unwrap();
        let config_path = root.join("conductor.yaml");
        let state = AppState::new(config_path, config, db).await;
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(TestExecutor));

        let project_board_map = HashMap::from([("demo".to_string(), board_path.clone())]);
        let event_bus = EventBus::new(16);
        let automation = tokio::spawn(run_board_automation_with_retry_interval(
            state.clone(),
            event_bus.clone(),
            project_board_map,
            Duration::from_millis(50),
        ));

        event_bus.publish(Event::BoardChanged {
            project_id: "demo".to_string(),
            path: board_path.display().to_string(),
        });

        wait_for_condition("initial dispatch wave", || {
            let board = Board::from_file(&board_path).ok()?;
            let dispatching = board
                .columns
                .iter()
                .find(|column| column.state == TaskState::Dispatching)
                .map(|column| column.cards.len())
                .unwrap_or(0);
            if dispatching == 2 {
                Some(())
            } else {
                None
            }
        })
        .await;

        let active_session_id = wait_for_condition("initial launched demo sessions", || {
            let Ok(sessions) = state.sessions.try_read() else {
                return None;
            };
            let active = sessions
                .values()
                .filter(|session| {
                    session.project_id == "demo"
                        && matches!(session.status, SessionStatus::Spawning | SessionStatus::Working)
                })
                .map(|session| session.id.clone())
                .collect::<Vec<_>>();
            if active.len() == 2 {
                active.into_iter().next()
            } else {
                None
            }
        })
        .await;

        state.kill_session(&active_session_id).await.unwrap();

        wait_for_condition("retry dispatch wave", || {
            let board = Board::from_file(&board_path).ok()?;
            let ready = board
                .columns
                .iter()
                .find(|column| column.state == TaskState::Ready)
                .map(|column| column.cards.len())
                .unwrap_or(0);
            let dispatching = board
                .columns
                .iter()
                .find(|column| column.state == TaskState::Dispatching)
                .map(|column| column.cards.len())
                .unwrap_or(0);
            if ready == 0 && dispatching == 3 {
                Some(())
            } else {
                None
            }
        })
        .await;

        automation.abort();
        let _ = automation.await;
        let _ = fs::remove_dir_all(&root);
    }
}
