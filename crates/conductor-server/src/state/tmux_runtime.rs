use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use conductor_core::config::ProjectConfig;
use conductor_executors::executor::{
    Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions,
};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{mpsc, oneshot};

use super::helpers::sanitize_terminal_text;
use crate::state::{AppState, SessionRecord, SessionStatus};

pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
pub(crate) const TMUX_RUNTIME_MODE: &str = "tmux";
pub(crate) const RUNTIME_MODE_METADATA_KEY: &str = "runtimeMode";
pub(crate) const TMUX_SESSION_METADATA_KEY: &str = "tmuxSession";
pub(crate) const TMUX_SOCKET_METADATA_KEY: &str = "tmuxSocket";
pub(crate) const TMUX_LOG_PATH_METADATA_KEY: &str = "tmuxLogPath";
pub(crate) const TMUX_EXIT_PATH_METADATA_KEY: &str = "tmuxExitPath";
pub(crate) const TMUX_LOG_OFFSET_METADATA_KEY: &str = "tmuxLogOffset";
pub(crate) const TMUX_LAUNCH_COMMAND_METADATA_KEY: &str = "tmuxLaunchCommand";
const TMUX_OBSERVED_ACTIVITY_METADATA_KEY: &str = "tmuxObservedActivity";
const TMUX_OBSERVED_ACTIVITY_STREAK_METADATA_KEY: &str = "tmuxObservedActivityStreak";

const TMUX_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TMUX_EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const TMUX_ACTIVITY_WATCH_INTERVAL: Duration = Duration::from_millis(750);
const TMUX_ACTIVITY_OUTPUT_GRACE_PERIOD: Duration = Duration::from_millis(2500);
const TMUX_DEFAULT_COLUMNS: &str = "120";
const TMUX_DEFAULT_ROWS: &str = "32";
const TMUX_HISTORY_LIMIT: &str = "50000";
static TMUX_AVAILABILITY: OnceLock<Result<(), String>> = OnceLock::new();

fn new_tmux_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("tmux");
    command.env_remove("TMUX");
    command
}

pub(crate) struct RuntimeLaunch {
    pub handle: ExecutorHandle,
    pub metadata: HashMap<String, String>,
}

struct TmuxRuntimeAttachment {
    kind: conductor_core::types::AgentKind,
    session_id: String,
    tmux_session: String,
    socket_path: PathBuf,
    log_path: PathBuf,
    exit_path: PathBuf,
    start_offset: u64,
    pid: u32,
}

struct TmuxOutputForwarder {
    session_id: String,
    tmux_session: String,
    socket_path: PathBuf,
    log_path: PathBuf,
    exit_path: PathBuf,
    offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TmuxActivityState {
    Active,
    Ready,
    WaitingInput,
    Blocked,
}

fn pane_lines(pane: &str) -> Vec<&str> {
    pane.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect()
}

fn last_non_empty_line(pane: &str) -> &str {
    pane.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

fn sanitize_tmux_pane_text(pane: &str) -> String {
    sanitize_terminal_text(pane)
}

fn squash_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn remove_whitespace(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn shell_prompt_visible(line: &str) -> bool {
    let trimmed = line.trim_end();
    matches!(trimmed, ">" | "$" | "#" | "%")
        || trimmed.ends_with(" >")
        || trimmed.ends_with(" $")
        || trimmed.ends_with(" #")
        || trimmed.ends_with(" %")
}

fn prompt_visible(agent: &str, line: &str) -> bool {
    if line.is_empty() {
        return false;
    }

    match conductor_core::types::AgentKind::parse(agent) {
        conductor_core::types::AgentKind::Codex => {
            line.starts_with('›')
                || shell_prompt_visible(line)
                || line
                    .split_whitespace()
                    .next()
                    .map(|token| token.chars().all(|ch| ch.is_ascii_digit() || ch == '%'))
                    .unwrap_or(false)
                    && (line.contains(" left") || line.contains(" remaining"))
        }
        conductor_core::types::AgentKind::Gemini => {
            line.starts_with('❯') || shell_prompt_visible(line)
        }
        _ => matches!(line, "❯") || shell_prompt_visible(line),
    }
}

fn classify_tmux_pane(agent: &str, pane: &str) -> TmuxActivityState {
    let sanitized = sanitize_tmux_pane_text(pane);
    if sanitized.trim().is_empty() {
        return TmuxActivityState::Ready;
    }

    let lines = pane_lines(&sanitized);
    let last_line = last_non_empty_line(&sanitized);
    if prompt_visible(agent, last_line) {
        return TmuxActivityState::Ready;
    }

    let tail = lines
        .iter()
        .rev()
        .take(8)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    let tail_compact = squash_whitespace(&tail);
    let tail_nowhitespace = remove_whitespace(&tail_compact);

    if tail_compact.contains("not authenticated")
        || tail_compact.contains("authentication required")
        || tail_compact.contains("login required")
        || tail_compact.contains("auth login")
        || tail_compact.contains("device code")
        || tail_compact.contains("open this url to authenticate")
        || (tail_compact.contains("sign in") && tail_compact.contains("browser"))
    {
        return TmuxActivityState::Blocked;
    }

    if tail_compact.contains("(y)es") && tail_compact.contains("(n)o")
        || tail_compact.contains("do you want")
        || tail_compact.contains("confirm")
        || tail_compact.contains("approve")
        || tail_compact.contains("proceed")
        || tail_compact.contains("select an option")
        || tail_compact.contains("press enter to continue")
        || tail_compact.contains("do you trust the files in this folder")
        || tail_compact.contains("enter to select")
        || tail_compact.contains("yes, and remember this folder for future sessions")
        || tail_nowhitespace.contains("doyouwant")
        || tail_nowhitespace.contains("doyoutrustthefilesinthisfolder")
        || tail_nowhitespace.contains("pressentertocontinue")
        || tail_nowhitespace.contains("entertoselect")
    {
        return TmuxActivityState::WaitingInput;
    }

    if ["done", "complete", "completed", "finished", "exiting"]
        .iter()
        .any(|prefix| last_line.to_ascii_lowercase().starts_with(prefix))
    {
        return TmuxActivityState::Ready;
    }

    TmuxActivityState::Active
}

fn summarize_tmux_pane(agent: &str, pane: &str, activity: TmuxActivityState) -> Option<String> {
    let sanitized = sanitize_tmux_pane_text(pane);
    let lines = pane_lines(&sanitized);
    if lines.is_empty() {
        return match activity {
            TmuxActivityState::Active => None,
            TmuxActivityState::Blocked => {
                Some("Authentication or terminal input required".to_string())
            }
            TmuxActivityState::Ready | TmuxActivityState::WaitingInput => {
                Some("Ready for follow-up".to_string())
            }
        };
    }

    let candidate = lines
        .iter()
        .rev()
        .copied()
        .find(|line| !prompt_visible(agent, line))
        .unwrap_or_else(|| last_non_empty_line(&sanitized));

    let cleaned = candidate.trim();
    if cleaned.is_empty() {
        return None;
    }

    Some(match activity {
        TmuxActivityState::Active => cleaned.to_string(),
        TmuxActivityState::Blocked => cleaned.to_string(),
        TmuxActivityState::WaitingInput => cleaned.to_string(),
        TmuxActivityState::Ready => {
            if prompt_visible(agent, cleaned) {
                "Ready for follow-up".to_string()
            } else {
                cleaned.to_string()
            }
        }
    })
}

impl AppState {
    pub(crate) async fn spawn_with_runtime(
        self: &Arc<Self>,
        project: &ProjectConfig,
        executor: Arc<dyn Executor>,
        session_id: &str,
        mut options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        match runtime_mode(project) {
            TMUX_RUNTIME_MODE => {
                options.interactive = true;
                // User-facing tmux sessions should render the agent's native terminal UI.
                // Enabling structured output here streams raw JSON into the pane.
                options.structured_output = false;
                self.spawn_tmux_runtime(executor, session_id, options).await
            }
            _ => {
                options.interactive = false;
                let handle = executor.spawn(options).await?;
                Ok(RuntimeLaunch {
                    handle,
                    metadata: HashMap::from([(
                        RUNTIME_MODE_METADATA_KEY.to_string(),
                        DIRECT_RUNTIME_MODE.to_string(),
                    )]),
                })
            }
        }
    }

    pub(crate) async fn restore_runtime_sessions(self: &Arc<Self>) {
        let session_ids = {
            let sessions = self.sessions.read().await;
            sessions
                .values()
                .filter(|session| !session.status.is_terminal())
                .filter(|session| {
                    session
                        .metadata
                        .get(RUNTIME_MODE_METADATA_KEY)
                        .map(|value| value == TMUX_RUNTIME_MODE)
                        .unwrap_or_else(|| {
                            session
                                .metadata
                                .get(TMUX_SESSION_METADATA_KEY)
                                .map(|value| !value.trim().is_empty())
                                .unwrap_or(false)
                        })
                })
                .map(|session| session.id.clone())
                .collect::<Vec<_>>()
        };

        for session_id in session_ids {
            if let Err(err) = self.restore_tmux_session(&session_id).await {
                tracing::warn!(session_id, error = %err, "Failed to restore tmux runtime session");
            }
        }
    }

    pub(crate) fn start_tmux_activity_watchdog(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(TMUX_ACTIVITY_WATCH_INTERVAL);
            loop {
                interval.tick().await;

                let session_ids = state
                    .live_sessions
                    .read()
                    .await
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();

                for session_id in session_ids {
                    if let Err(err) = state.reconcile_tmux_session_activity(&session_id).await {
                        tracing::debug!(
                            session_id,
                            error = %err,
                            "Failed to reconcile tmux activity"
                        );
                    }
                }
            }
        });
    }

    pub(crate) async fn ensure_session_live(self: &Arc<Self>, session_id: &str) -> Result<bool> {
        if self.terminal_runtime_attached(session_id).await {
            return Ok(true);
        }

        let Some(session) = self.get_session(session_id).await else {
            return Ok(false);
        };

        if matches!(
            session.status,
            SessionStatus::Archived | SessionStatus::Killed
        ) {
            return Ok(false);
        }

        let is_tmux_runtime = session
            .metadata
            .get(RUNTIME_MODE_METADATA_KEY)
            .map(|value| value == TMUX_RUNTIME_MODE)
            .unwrap_or_else(|| {
                session
                    .metadata
                    .get(TMUX_SESSION_METADATA_KEY)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            });

        if !is_tmux_runtime {
            return Ok(false);
        }

        self.restore_tmux_session(session_id).await?;
        Ok(self.terminal_runtime_attached(session_id).await)
    }

    async fn reconcile_tmux_session_activity(&self, session_id: &str) -> Result<()> {
        let Some(snapshot) = self.get_session(session_id).await else {
            return Ok(());
        };
        if snapshot.status.is_terminal() || snapshot.status == SessionStatus::Queued {
            return Ok(());
        }

        let Some((socket_path, tmux_session)) = tmux_runtime_metadata(&snapshot) else {
            return Ok(());
        };
        if !tmux_session_exists(&socket_path, &tmux_session).await? {
            return Ok(());
        }

        let pane = capture_tmux_pane(&socket_path, &tmux_session, 80).await?;
        let activity = classify_tmux_pane(&snapshot.agent, &pane);
        let summary = summarize_tmux_pane(&snapshot.agent, &pane, activity);

        let mut sessions = self.sessions.write().await;
        let Some(current) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        if current.status.is_terminal() || current.status == SessionStatus::Queued {
            return Ok(());
        }

        let next_status = match activity {
            TmuxActivityState::Active => SessionStatus::Working,
            TmuxActivityState::Ready | TmuxActivityState::WaitingInput => SessionStatus::NeedsInput,
            TmuxActivityState::Blocked => SessionStatus::Stuck,
        };
        let next_activity = match activity {
            TmuxActivityState::Active => "active",
            TmuxActivityState::Ready | TmuxActivityState::WaitingInput => "waiting_input",
            TmuxActivityState::Blocked => "blocked",
        };
        let previous_observed = current
            .metadata
            .get(TMUX_OBSERVED_ACTIVITY_METADATA_KEY)
            .map(String::as_str);
        let previous_streak = current
            .metadata
            .get(TMUX_OBSERVED_ACTIVITY_STREAK_METADATA_KEY)
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let observed_streak = if previous_observed == Some(next_activity) {
            previous_streak.saturating_add(1)
        } else {
            1
        };
        current.metadata.insert(
            TMUX_OBSERVED_ACTIVITY_METADATA_KEY.to_string(),
            next_activity.to_string(),
        );
        current.metadata.insert(
            TMUX_OBSERVED_ACTIVITY_STREAK_METADATA_KEY.to_string(),
            observed_streak.to_string(),
        );

        let summary_changed = summary.as_deref() != current.summary.as_deref();
        let status_changed = current.status != next_status;
        let activity_changed = current.activity.as_deref() != Some(next_activity);
        let is_currently_active = current.status == SessionStatus::Working
            || current.activity.as_deref() == Some("active");
        let saw_recent_output = chrono::DateTime::parse_from_rfc3339(&current.last_activity_at)
            .ok()
            .and_then(|timestamp| (Utc::now() - timestamp.with_timezone(&Utc)).to_std().ok())
            .map(|elapsed| elapsed < TMUX_ACTIVITY_OUTPUT_GRACE_PERIOD)
            .unwrap_or(false);
        let required_streak = match activity {
            TmuxActivityState::Active => 1,
            TmuxActivityState::Ready | TmuxActivityState::WaitingInput => {
                if is_currently_active {
                    if saw_recent_output {
                        4
                    } else {
                        3
                    }
                } else {
                    1
                }
            }
            TmuxActivityState::Blocked => {
                if is_currently_active {
                    if saw_recent_output {
                        3
                    } else {
                        2
                    }
                } else {
                    1
                }
            }
        };

        if observed_streak < required_streak && (status_changed || activity_changed) {
            return Ok(());
        }

        if !summary_changed && !status_changed && !activity_changed {
            return Ok(());
        }

        current.status = next_status;
        current.activity = Some(next_activity.to_string());
        if let Some(summary) = summary {
            current.summary = Some(summary.clone());
            current.metadata.insert("summary".to_string(), summary);
        }

        let updated = current.clone();
        drop(sessions);
        self.persist_session(&updated).await?;
        self.publish_snapshot().await;
        Ok(())
    }

    async fn spawn_tmux_runtime(
        self: &Arc<Self>,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        ensure_tmux_available().await?;

        let runtime_root = self.tmux_runtime_root();
        tokio::fs::create_dir_all(&runtime_root).await?;

        let socket_path = self.tmux_socket_path();
        let session_name = format!("conductor-{}", sanitize_token(session_id));
        let log_path = runtime_root.join(format!("{session_id}.log"));
        let exit_path = runtime_root.join(format!("{session_id}.exit"));
        let ready_path = runtime_root.join(format!("{session_id}.ready"));

        let _ = tokio::fs::remove_file(&log_path).await;
        let _ = tokio::fs::remove_file(&exit_path).await;
        let _ = tokio::fs::remove_file(&ready_path).await;

        let launch_command = build_shell_command(
            executor.binary_path(),
            &executor.build_args(&options),
            &options.env,
        );
        let login_shell = resolve_login_shell();
        let wrapper =
            build_login_shell_wrapper(&login_shell, &ready_path, &exit_path, &launch_command);

        run_tmux_command(
            &socket_path,
            [
                "new-session",
                "-d",
                "-x",
                TMUX_DEFAULT_COLUMNS,
                "-y",
                TMUX_DEFAULT_ROWS,
                "-s",
                session_name.as_str(),
                "-c",
                options.cwd.to_string_lossy().as_ref(),
            ],
            Some(format!("sh -c {}", shell_escape(&wrapper))),
        )
        .await
        .with_context(|| format!("Failed to create tmux session {session_name}"))?;

        configure_tmux_session(&socket_path, &session_name).await?;

        let pipe_command = format!("cat >> {}", shell_escape(&log_path.to_string_lossy()));
        run_tmux_command(
            &socket_path,
            ["pipe-pane", "-o", "-t", session_name.as_str()],
            Some(pipe_command),
        )
        .await
        .with_context(|| format!("Failed to pipe tmux pane output for {session_name}"))?;

        tokio::fs::write(&ready_path, b"ready").await?;

        let pane_pid = tmux_pane_pid(&socket_path, &session_name)
            .await
            .unwrap_or(0);
        let handle = self
            .attach_tmux_runtime_handle(TmuxRuntimeAttachment {
                kind: executor.kind(),
                session_id: session_id.to_string(),
                tmux_session: session_name.clone(),
                socket_path: socket_path.clone(),
                log_path: log_path.clone(),
                exit_path: exit_path.clone(),
                start_offset: 0,
                pid: pane_pid,
            })
            .await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            RUNTIME_MODE_METADATA_KEY.to_string(),
            TMUX_RUNTIME_MODE.to_string(),
        );
        metadata.insert(TMUX_SESSION_METADATA_KEY.to_string(), session_name);
        metadata.insert(
            TMUX_SOCKET_METADATA_KEY.to_string(),
            socket_path.to_string_lossy().to_string(),
        );
        metadata.insert(
            TMUX_LOG_PATH_METADATA_KEY.to_string(),
            log_path.to_string_lossy().to_string(),
        );
        metadata.insert(
            TMUX_EXIT_PATH_METADATA_KEY.to_string(),
            exit_path.to_string_lossy().to_string(),
        );
        metadata.insert(TMUX_LOG_OFFSET_METADATA_KEY.to_string(), "0".to_string());
        if !launch_command.trim().is_empty() {
            metadata.insert(TMUX_LAUNCH_COMMAND_METADATA_KEY.to_string(), launch_command);
        }

        Ok(RuntimeLaunch { handle, metadata })
    }

    async fn restore_tmux_session(self: &Arc<Self>, session_id: &str) -> Result<()> {
        if self.live_sessions.read().await.contains_key(session_id) {
            return Ok(());
        }

        let session = self
            .get_session(session_id)
            .await
            .with_context(|| format!("Session {session_id} not found"))?;
        let Some(tmux_session) = session.metadata.get(TMUX_SESSION_METADATA_KEY).cloned() else {
            return Ok(());
        };
        let Some(socket_path) = session.metadata.get(TMUX_SOCKET_METADATA_KEY).cloned() else {
            return Ok(());
        };
        let Some(log_path) = session.metadata.get(TMUX_LOG_PATH_METADATA_KEY).cloned() else {
            return Ok(());
        };
        let Some(exit_path) = session.metadata.get(TMUX_EXIT_PATH_METADATA_KEY).cloned() else {
            return Ok(());
        };
        let offset = session
            .metadata
            .get(TMUX_LOG_OFFSET_METADATA_KEY)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);

        let socket_path = PathBuf::from(socket_path);
        if tmux_session_exists(&socket_path, &tmux_session).await? {
            let executors = self.executors.read().await;
            let executor = executors
                .get(&conductor_core::types::AgentKind::parse(&session.agent))
                .cloned()
                .with_context(|| format!("Executor '{}' is not available", session.agent))?;
            drop(executors);

            let pid = tmux_pane_pid(&socket_path, &tmux_session)
                .await
                .unwrap_or(0);
            let handle = self
                .attach_tmux_runtime_handle(TmuxRuntimeAttachment {
                    kind: executor.kind(),
                    session_id: session_id.to_string(),
                    tmux_session: tmux_session.clone(),
                    socket_path: socket_path.clone(),
                    log_path: PathBuf::from(&log_path),
                    exit_path: PathBuf::from(&exit_path),
                    start_offset: offset,
                    pid,
                })
                .await?;
            let (_pid, _kind, output_rx, input_tx, kill_tx) = handle.into_parts();

            self.attach_terminal_runtime(session_id, input_tx, kill_tx)
                .await;

            self.start_output_consumer(
                session_id.to_string(),
                executor,
                output_rx,
                false,
                true,
                None,
            );

            let mut sessions = self.sessions.write().await;
            if let Some(current) = sessions.get_mut(session_id) {
                current.pid = Some(pid);
                current.activity = match &current.status {
                    SessionStatus::NeedsInput => Some("waiting_input".to_string()),
                    SessionStatus::Queued => Some("idle".to_string()),
                    _ => Some("active".to_string()),
                };
                if current.status == SessionStatus::Spawning {
                    current.status = SessionStatus::Working;
                }
                current.metadata.remove("recoveryState");
                current.metadata.remove("recoveryAction");
                current.metadata.remove("detachedPid");
                let updated = current.clone();
                drop(sessions);
                self.replace_session(updated).await?;
            }

            if let Err(err) = self.reconcile_tmux_session_activity(session_id).await {
                tracing::debug!(
                    session_id,
                    error = %err,
                    "Failed to reconcile tmux activity immediately after restore"
                );
            }

            return Ok(());
        }

        if let Some(exit_code) = read_exit_code(Path::new(&exit_path)).await? {
            let event = if exit_code == 0 {
                ExecutorOutput::Completed { exit_code }
            } else {
                ExecutorOutput::Failed {
                    error: format!("Process exited with code {exit_code}"),
                    exit_code: Some(exit_code),
                }
            };
            self.apply_runtime_event(session_id, event).await?;
            return Ok(());
        }

        let mut sessions = self.sessions.write().await;
        if let Some(current) = sessions.get_mut(session_id) {
            current.status = SessionStatus::Stuck;
            current.activity = Some("blocked".to_string());
            current.summary = Some(
                "Tmux runtime was not found after restart. Send a message to resume in the same workspace."
                    .to_string(),
            );
            current.metadata.insert(
                "summary".to_string(),
                current.summary.clone().unwrap_or_default(),
            );
            current
                .metadata
                .insert("recoveryState".to_string(), "resume_required".to_string());
            current
                .metadata
                .insert("recoveryAction".to_string(), "resume".to_string());
            current.pid = None;
            let updated = current.clone();
            drop(sessions);
            self.replace_session(updated).await?;
        }

        Ok(())
    }

    pub(crate) fn tmux_runtime_root(&self) -> PathBuf {
        self.workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("tmux")
    }

    fn tmux_socket_path(&self) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        self.workspace_path.hash(&mut hasher);
        std::env::temp_dir().join(format!("conductor-tmux-{:016x}.sock", hasher.finish()))
    }

    async fn attach_tmux_runtime_handle(
        self: &Arc<Self>,
        attachment: TmuxRuntimeAttachment,
    ) -> Result<ExecutorHandle> {
        let TmuxRuntimeAttachment {
            kind,
            session_id,
            tmux_session,
            socket_path,
            log_path,
            exit_path,
            start_offset,
            pid,
        } = attachment;
        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let input_socket = socket_path.clone();
        let input_session_name = tmux_session.clone();
        let input_session_id = session_id.clone();

        tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                let result = match input {
                    ExecutorInput::Text(text) => {
                        send_tmux_text(&input_socket, &input_session_name, &text).await
                    }
                    ExecutorInput::Raw(raw) => {
                        send_tmux_raw_bytes(&input_socket, &input_session_name, raw.as_bytes())
                            .await
                    }
                };
                if let Err(err) = result {
                    tracing::warn!(input_session_id, error = %err, "Failed to send input to tmux runtime");
                    break;
                }
            }
        });

        let kill_socket = socket_path.clone();
        let kill_session_name = tmux_session.clone();
        tokio::spawn(async move {
            if kill_rx.await.is_ok() {
                let _ = kill_tmux_session(&kill_socket, &kill_session_name).await;
            }
        });

        let state = self.clone();
        let forwarder = TmuxOutputForwarder {
            session_id: session_id.clone(),
            tmux_session: tmux_session.clone(),
            socket_path: socket_path.clone(),
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
            offset: start_offset,
        };
        tokio::spawn(async move {
            if let Err(err) = state.forward_tmux_output(forwarder, output_tx).await {
                tracing::warn!(session_id, error = %err, "Tmux output forwarder failed");
            }
        });

        Ok(ExecutorHandle::new(pid, kind, output_rx, input_tx, kill_tx))
    }

    async fn forward_tmux_output(
        self: Arc<Self>,
        forwarder: TmuxOutputForwarder,
        output_tx: mpsc::Sender<ExecutorOutput>,
    ) -> Result<()> {
        let TmuxOutputForwarder {
            session_id,
            tmux_session,
            socket_path,
            log_path,
            exit_path,
            mut offset,
        } = forwarder;
        let mut partial = Vec::new();
        let mut exit_deadline = None;

        loop {
            if let Some((next_offset, chunk)) = read_tmux_log_chunk(&log_path, offset).await? {
                self.process_terminal_bytes(&session_id, &chunk).await;
                self.emit_terminal_stream_event(
                    &session_id,
                    super::types::TerminalStreamEvent::Output(chunk.clone()),
                )
                .await;
                let lines = split_tmux_log_lines(&mut partial, &chunk);
                for line in lines {
                    if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                        return Ok(());
                    }
                }
                offset = next_offset;
                self.update_tmux_log_offset(&session_id, offset).await?;
            }

            if !tmux_session_exists(&socket_path, &tmux_session).await? {
                let deadline = exit_deadline
                    .get_or_insert_with(|| tokio::time::Instant::now() + TMUX_EXIT_WAIT_TIMEOUT);
                if !partial.is_empty() {
                    let line = String::from_utf8_lossy(&partial)
                        .trim_end_matches('\r')
                        .to_string();
                    partial.clear();
                    if !line.is_empty() {
                        if output_tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                            return Ok(());
                        }
                        self.update_tmux_log_offset(&session_id, offset).await?;
                    }
                }

                if let Some(exit_code) = read_exit_code(&exit_path).await? {
                    self.emit_terminal_stream_event(
                        &session_id,
                        super::types::TerminalStreamEvent::Exit(exit_code),
                    )
                    .await;
                    let event = if exit_code == 0 {
                        ExecutorOutput::Completed { exit_code }
                    } else {
                        ExecutorOutput::Failed {
                            error: format!("Process exited with code {exit_code}"),
                            exit_code: Some(exit_code),
                        }
                    };
                    let _ = output_tx.send(event).await;
                    return Ok(());
                }

                if tokio::time::Instant::now() >= *deadline {
                    self.emit_terminal_stream_event(
                        &session_id,
                        super::types::TerminalStreamEvent::Error(
                            "Tmux session exited unexpectedly".to_string(),
                        ),
                    )
                    .await;
                    let _ = output_tx
                        .send(ExecutorOutput::Failed {
                            error: "Tmux session exited unexpectedly".to_string(),
                            exit_code: None,
                        })
                        .await;
                    return Ok(());
                }
            } else {
                exit_deadline = None;
            }

            tokio::time::sleep(TMUX_POLL_INTERVAL).await;
        }
    }

    pub(crate) async fn update_tmux_log_offset(&self, session_id: &str, offset: u64) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        let next = offset.to_string();
        if session
            .metadata
            .get(TMUX_LOG_OFFSET_METADATA_KEY)
            .map(|value| value == &next)
            .unwrap_or(false)
        {
            return Ok(());
        }

        session
            .metadata
            .insert(TMUX_LOG_OFFSET_METADATA_KEY.to_string(), next);
        let updated = session.clone();
        drop(sessions);
        self.persist_session(&updated).await
    }

    pub(crate) async fn resize_live_terminal(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        self.resize_terminal_store(session_id, cols, rows).await;
        let Some(session) = self.get_session(session_id).await else {
            return Ok(());
        };
        let Some((socket_path, tmux_session)) = tmux_runtime_metadata(&session) else {
            return Ok(());
        };
        if !tmux_session_exists(&socket_path, &tmux_session).await? {
            return Ok(());
        }
        resize_tmux_session(&socket_path, &tmux_session, cols, rows).await
    }
}

pub(crate) fn runtime_mode(project: &ProjectConfig) -> &str {
    project
        .runtime
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(TMUX_RUNTIME_MODE)
}

pub(crate) fn tmux_runtime_metadata(session: &SessionRecord) -> Option<(PathBuf, String)> {
    let socket = session.metadata.get(TMUX_SOCKET_METADATA_KEY)?.clone();
    let name = session.metadata.get(TMUX_SESSION_METADATA_KEY)?.clone();
    Some((PathBuf::from(socket), name))
}

pub(crate) async fn tmux_session_exists(socket_path: &Path, session_name: &str) -> Result<bool> {
    let status = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("has-session")
        .arg("-t")
        .arg(session_name)
        .status()
        .await
        .with_context(|| format!("Failed to query tmux session {session_name}"))?;
    Ok(status.success())
}

pub(crate) async fn capture_tmux_pane(
    socket_path: &Path,
    session_name: &str,
    lines: usize,
) -> Result<String> {
    let history_start = lines.saturating_sub(1);
    let output = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("capture-pane")
        .arg("-e")
        .arg("-p")
        .arg("-t")
        .arg(session_name)
        .arg("-S")
        .arg(format!("-{history_start}"))
        .output()
        .await
        .with_context(|| format!("Failed to capture tmux pane for {session_name}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(anyhow!("tmux capture-pane failed for {session_name}"))
    }
}

async fn configure_tmux_session(socket_path: &Path, session_name: &str) -> Result<()> {
    run_tmux_command(
        socket_path,
        [
            "set-option",
            "-t",
            session_name,
            "history-limit",
            TMUX_HISTORY_LIMIT,
            ";",
            "set-option",
            "-as",
            "-t",
            session_name,
            "terminal-overrides",
            ",xterm-256color:Tc,screen-256color:Tc,tmux-256color:Tc",
            ";",
            "set-option",
            "-t",
            session_name,
            "status",
            "off",
        ],
        None,
    )
    .await
    .with_context(|| format!("Failed to configure tmux session {session_name}"))
}

pub(crate) async fn kill_tmux_session(socket_path: &Path, session_name: &str) -> Result<()> {
    let status = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("kill-session")
        .arg("-t")
        .arg(session_name)
        .status()
        .await
        .with_context(|| format!("Failed to kill tmux session {session_name}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("tmux kill-session failed for {session_name}"))
    }
}

async fn ensure_tmux_available() -> Result<()> {
    if let Some(cached) = TMUX_AVAILABILITY.get() {
        return cached
            .as_ref()
            .map(|_| ())
            .map_err(|error| anyhow!(error.clone()));
    }

    let result = match new_tmux_command()
        .arg("-V")
        .status()
        .await
        .context("Failed to execute tmux")
    {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("tmux is required for runtime 'tmux'".to_string()),
        Err(error) => Err(error.to_string()),
    };

    let cached = TMUX_AVAILABILITY.get_or_init(|| result.clone());
    cached
        .as_ref()
        .map(|_| ())
        .map_err(|error| anyhow!(error.clone()))
}

async fn tmux_pane_pid(socket_path: &Path, session_name: &str) -> Result<u32> {
    let output = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("display-message")
        .arg("-p")
        .arg("-t")
        .arg(session_name)
        .arg("#{pane_pid}")
        .output()
        .await
        .with_context(|| format!("Failed to read pane pid for {session_name}"))?;
    if !output.status.success() {
        return Err(anyhow!("tmux display-message failed for {session_name}"));
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    value
        .parse::<u32>()
        .with_context(|| format!("Invalid pane pid '{value}' for {session_name}"))
}

async fn run_tmux_command<I, S>(socket_path: &Path, args: I, trailing: Option<String>) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut command = new_tmux_command();
    command.arg("-S").arg(socket_path);
    for arg in args {
        command.arg(arg.as_ref());
    }
    if let Some(value) = trailing {
        command.arg(value);
    }
    let status = command.status().await?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("tmux command failed"))
    }
}

async fn send_tmux_literal(socket_path: &Path, session_name: &str, value: &str) -> Result<()> {
    let status = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("send-keys")
        .arg("-t")
        .arg(session_name)
        .arg("-l")
        .arg(value)
        .status()
        .await
        .with_context(|| format!("Failed to send keys to tmux session {session_name}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("tmux send-keys failed for {session_name}"))
    }
}

async fn send_tmux_text(socket_path: &Path, session_name: &str, value: &str) -> Result<()> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let mut segments = normalized.split('\n').peekable();
    while let Some(segment) = segments.next() {
        if !segment.is_empty() {
            send_tmux_literal(socket_path, session_name, segment).await?;
        }

        if segments.peek().is_some() {
            send_tmux_enter(socket_path, session_name).await?;
        }
    }

    if !value.ends_with('\n') && !value.ends_with('\r') {
        send_tmux_enter(socket_path, session_name).await?;
    }

    Ok(())
}

async fn send_tmux_raw_bytes(socket_path: &Path, session_name: &str, bytes: &[u8]) -> Result<()> {
    for byte in bytes {
        let status = new_tmux_command()
            .arg("-S")
            .arg(socket_path)
            .arg("send-keys")
            .arg("-t")
            .arg(session_name)
            .arg("-H")
            .arg(format!("{byte:02x}"))
            .status()
            .await
            .with_context(|| format!("Failed to send raw bytes to tmux session {session_name}"))?;
        if !status.success() {
            return Err(anyhow!("tmux send-keys -H failed for {session_name}"));
        }
    }

    Ok(())
}

async fn resize_tmux_session(
    socket_path: &Path,
    session_name: &str,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let status = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("resize-window")
        .arg("-t")
        .arg(session_name)
        .arg("-x")
        .arg(cols.max(1).to_string())
        .arg("-y")
        .arg(rows.max(1).to_string())
        .status()
        .await
        .with_context(|| format!("Failed to resize tmux session {session_name}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("tmux resize-window failed for {session_name}"))
    }
}

async fn send_tmux_enter(socket_path: &Path, session_name: &str) -> Result<()> {
    let status = new_tmux_command()
        .arg("-S")
        .arg(socket_path)
        .arg("send-keys")
        .arg("-t")
        .arg(session_name)
        .arg("Enter")
        .status()
        .await
        .with_context(|| format!("Failed to send Enter to tmux session {session_name}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("tmux send-keys Enter failed for {session_name}"))
    }
}

async fn read_tmux_log_chunk(log_path: &Path, offset: u64) -> Result<Option<(u64, Vec<u8>)>> {
    let mut file = match tokio::fs::OpenOptions::new()
        .read(true)
        .open(log_path)
        .await
    {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut chunk = Vec::new();
    file.read_to_end(&mut chunk).await?;
    if chunk.is_empty() {
        return Ok(None);
    }

    let next_offset = offset + chunk.len() as u64;
    Ok(Some((next_offset, chunk)))
}

fn split_tmux_log_lines(partial: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    partial.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(index) = partial.iter().position(|byte| *byte == b'\n') {
        let line = partial.drain(..=index).collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&line)
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();
        if !text.is_empty() {
            lines.push(text);
        }
    }

    lines
}

async fn read_exit_code(path: &Path) -> Result<Option<i32>> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let code = trimmed
        .parse::<i32>()
        .with_context(|| format!("Invalid exit code '{trimmed}' in {}", path.display()))?;
    Ok(Some(code))
}

fn build_shell_command(binary: &Path, args: &[String], env: &HashMap<String, String>) -> String {
    let mut parts = Vec::new();
    if !env.is_empty() {
        parts.push("env".to_string());
        let mut env_entries = env.iter().collect::<Vec<_>>();
        env_entries.sort_by(|left, right| left.0.cmp(right.0));
        for (key, value) in env_entries {
            parts.push(format!("{key}={}", shell_escape(value)));
        }
    }
    parts.push(shell_escape(&binary.to_string_lossy()));
    parts.extend(args.iter().map(|arg| shell_escape(arg)));
    parts.join(" ")
}

fn build_login_shell_wrapper(
    shell: &Path,
    ready_path: &Path,
    exit_path: &Path,
    launch_command: &str,
) -> String {
    let shell_command = if launch_command.trim().is_empty() {
        format!("{} -il", shell_escape(&shell.to_string_lossy()))
    } else {
        format!(
            "/bin/sh -c {}",
            shell_escape(&format!("exec {}", launch_command)),
        )
    };
    format!(
        concat!(
            "while [ ! -f {ready} ]; do sleep 0.05; done; ",
            "export TERM=xterm-256color; ",
            "export COLORTERM=truecolor; ",
            "{shell_command}; ",
            "status=$?; ",
            "printf '%s' \"$status\" > {exit_path}; ",
            "exit $status"
        ),
        ready = shell_escape(&ready_path.to_string_lossy()),
        shell_command = shell_command,
        exit_path = shell_escape(&exit_path.to_string_lossy()),
    )
}

fn resolve_login_shell() -> PathBuf {
    std::env::var("SHELL")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.exists())
        })
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn sanitize_token(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use conductor_core::config::ConductorConfig;
    use conductor_core::types::AgentKind;
    use conductor_db::Database;
    use conductor_executors::process::spawn_process;
    use std::collections::BTreeMap;
    use std::fs;
    use tokio::time::{timeout, Duration};
    use uuid::Uuid;

    #[test]
    fn classify_tmux_pane_marks_codex_prompt_ready() {
        assert_eq!(
            classify_tmux_pane("codex", "Thinking about changes\n› "),
            TmuxActivityState::Ready
        );
    }

    #[test]
    fn classify_tmux_pane_marks_confirmation_waiting_input() {
        assert_eq!(
            classify_tmux_pane("claude-code", "Do you want to proceed?\n(Y)es/(N)o"),
            TmuxActivityState::WaitingInput
        );
    }

    #[test]
    fn classify_tmux_pane_marks_auth_blocked() {
        assert_eq!(
            classify_tmux_pane(
                "cursor-cli",
                "Authentication required. Open this URL to authenticate in your browser."
            ),
            TmuxActivityState::Blocked
        );
    }

    #[test]
    fn classify_tmux_pane_keeps_claude_bypass_prompt_active() {
        assert_eq!(
            classify_tmux_pane(
                "claude-code",
                "\u{001b}[38;2;255;107;128m⏵⏵\u{001b}[39m\u{001b}[38;2;255;107;128mbypasspermissionson\u{001b}[39m (shift+tab to cycle)"
            ),
            TmuxActivityState::Active
        );
    }

    #[test]
    fn classify_tmux_pane_marks_copilot_trust_prompt_waiting_input() {
        assert_eq!(
            classify_tmux_pane(
                "github-copilot",
                "Do you trust the files in this folder?\n1. Yes\n2. Yes, and remember this folder for future sessions\n3. No (Esc)\n↑↓ to navigate · Enter to select · Esc to cancel"
            ),
            TmuxActivityState::WaitingInput
        );
    }

    struct TmuxHarnessExecutor;

    #[async_trait]
    impl Executor for TmuxHarnessExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Tmux Harness"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/sh")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
            let args = self.build_args(&options);
            let handle =
                spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
            Ok(ExecutorHandle::new(
                handle.pid,
                self.kind(),
                handle.output_rx,
                handle.input_tx,
                handle.kill_tx,
            ))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            vec![
                "-lc".to_string(),
                "printf 'phase-one\\n'; sleep 2; printf 'phase-two\\n'".to_string(),
            ]
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    struct TmuxInputHarnessExecutor;

    #[async_trait]
    impl Executor for TmuxInputHarnessExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Tmux Input Harness"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/sh")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
            let args = self.build_args(&options);
            let handle =
                spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
            Ok(ExecutorHandle::new(
                handle.pid,
                self.kind(),
                handle.output_rx,
                handle.input_tx,
                handle.kill_tx,
            ))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            vec![
                "-lc".to_string(),
                "printf 'ready\\n'; IFS= read -r line; printf 'echo:%s\\n' \"$line\"; sleep 0.2"
                    .to_string(),
            ]
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    struct TmuxStructuredHarnessExecutor;

    #[async_trait]
    impl Executor for TmuxStructuredHarnessExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Tmux Structured Harness"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/sh")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
            let args = self.build_args(&options);
            let handle =
                spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
            Ok(ExecutorHandle::new(
                handle.pid,
                self.kind(),
                handle.output_rx,
                handle.input_tx,
                handle.kill_tx,
            ))
        }

        fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
            let marker = if options.structured_output {
                "structured"
            } else {
                "plain"
            };
            vec![
                "-lc".to_string(),
                format!("printf '{marker}\\n'; sleep 0.2"),
            ]
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    async fn build_state(root: &Path) -> Arc<AppState> {
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let config = ConductorConfig {
            workspace: root.to_path_buf(),
            preferences: conductor_core::config::PreferencesConfig {
                coding_agent: "codex".to_string(),
                ..conductor_core::config::PreferencesConfig::default()
            },
            projects: BTreeMap::from([(
                "demo".to_string(),
                ProjectConfig {
                    path: repo.to_string_lossy().to_string(),
                    agent: Some("codex".to_string()),
                    runtime: Some(TMUX_RUNTIME_MODE.to_string()),
                    default_branch: "main".to_string(),
                    ..ProjectConfig::default()
                },
            )]),
            ..ConductorConfig::default()
        };

        let db = Database::in_memory().await.unwrap();
        let state = AppState::new(root.join("conductor.yaml"), config, db).await;
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(TmuxHarnessExecutor));
        state.start_tmux_activity_watchdog();
        state
    }

    #[tokio::test]
    async fn restore_runtime_sessions_reattaches_running_tmux_sessions() {
        let root = std::env::temp_dir().join(format!("conductor-tmux-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let session_id = "tmux-restore-session";
        let state = build_state(&root).await;
        let executor = state
            .executors
            .read()
            .await
            .get(&AgentKind::Codex)
            .cloned()
            .unwrap();

        let launch = state
            .spawn_tmux_runtime(
                executor,
                session_id,
                SpawnOptions {
                    cwd: repo.clone(),
                    prompt: "Inspect".to_string(),
                    model: None,
                    reasoning_effort: None,
                    skip_permissions: false,
                    extra_args: Vec::new(),
                    env: HashMap::new(),
                    branch: None,
                    timeout: None,
                    interactive: false,
                    structured_output: false,
                    resume_target: None,
                },
            )
            .await
            .unwrap();
        let pid = launch.handle.pid;
        let metadata = launch.metadata.clone();
        drop(launch);

        let mut record = SessionRecord::new(
            session_id.to_string(),
            "demo".to_string(),
            Some("session/tmux".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Inspect".to_string(),
            Some(pid),
        );
        record.status = SessionStatus::Working;
        record.activity = Some("active".to_string());
        record.metadata.extend(metadata);
        state.replace_session(record).await.unwrap();

        tokio::time::sleep(Duration::from_millis(300)).await;

        drop(state);
        let restored = build_state(&root).await;
        restored.restore_runtime_sessions().await;

        timeout(Duration::from_secs(2), async {
            loop {
                if restored.live_sessions.read().await.contains_key(session_id) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux session should reattach");

        let output_restored = timeout(Duration::from_secs(10), async {
            loop {
                let session = restored.get_session(session_id).await.unwrap();
                if session.output.contains("phase-two") {
                    return session;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux session output should continue after reattach");

        restored
            .reconcile_tmux_session_activity(session_id)
            .await
            .expect("tmux session should reconcile after reattach");

        let final_session = restored.get_session(session_id).await.unwrap();

        assert_eq!(
            final_session
                .metadata
                .get(RUNTIME_MODE_METADATA_KEY)
                .map(String::as_str),
            Some(TMUX_RUNTIME_MODE)
        );
        assert!(output_restored.output.contains("phase-two"));
        assert!(final_session.output.contains("phase-two"));
        assert!(matches!(
            final_session.status,
            SessionStatus::Working | SessionStatus::NeedsInput
        ));
        assert!(!final_session.metadata.contains_key("recoveryState"));

        if let Some((socket_path, tmux_session)) = tmux_runtime_metadata(&final_session) {
            let _ = kill_tmux_session(&socket_path, &tmux_session).await;
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn send_to_session_reattaches_tmux_runtime_on_demand() {
        let root =
            std::env::temp_dir().join(format!("conductor-tmux-send-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let session_id = "tmux-send-session";
        let state = build_state(&root).await;
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(TmuxInputHarnessExecutor));
        let executor = state
            .executors
            .read()
            .await
            .get(&AgentKind::Codex)
            .cloned()
            .unwrap();

        let launch = state
            .spawn_tmux_runtime(
                executor,
                session_id,
                SpawnOptions {
                    cwd: repo.clone(),
                    prompt: "Inspect".to_string(),
                    model: None,
                    reasoning_effort: None,
                    skip_permissions: false,
                    extra_args: Vec::new(),
                    env: HashMap::new(),
                    branch: None,
                    timeout: None,
                    interactive: false,
                    structured_output: false,
                    resume_target: None,
                },
            )
            .await
            .unwrap();
        let pid = launch.handle.pid;
        let metadata = launch.metadata.clone();
        drop(launch);

        let mut record = SessionRecord::new(
            session_id.to_string(),
            "demo".to_string(),
            Some("session/tmux".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Inspect".to_string(),
            Some(pid),
        );
        record.status = SessionStatus::NeedsInput;
        record.activity = Some("waiting_input".to_string());
        record.metadata.extend(metadata);
        state.replace_session(record).await.unwrap();

        let restored = build_state(&root).await;
        restored
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(TmuxInputHarnessExecutor));

        tokio::time::sleep(Duration::from_millis(250)).await;

        restored
            .send_to_session(
                session_id,
                "make this panel bigger".to_string(),
                Vec::new(),
                None,
                None,
                "follow_up",
            )
            .await
            .unwrap();

        let final_session = timeout(Duration::from_secs(5), async {
            loop {
                let session = restored.get_session(session_id).await.unwrap();
                if session.output.contains("echo:make this panel bigger") {
                    return session;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux session should accept follow-up input after reattach");

        assert!(restored.live_sessions.read().await.contains_key(session_id));
        assert!(final_session
            .conversation
            .iter()
            .any(|entry| entry.kind == "user_message" && entry.text == "make this panel bigger"));

        if let Some((socket_path, tmux_session)) = tmux_runtime_metadata(&final_session) {
            let _ = kill_tmux_session(&socket_path, &tmux_session).await;
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn spawn_with_runtime_preserves_plain_terminal_output_for_tmux_sessions() {
        let root =
            std::env::temp_dir().join(format!("conductor-tmux-structured-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let session_id = "tmux-structured-session";
        let state = build_state(&root).await;
        let executor: Arc<dyn Executor> = Arc::new(TmuxStructuredHarnessExecutor);
        let project = state
            .config
            .read()
            .await
            .projects
            .get("demo")
            .cloned()
            .unwrap();

        let launch = state
            .spawn_with_runtime(
                &project,
                executor,
                session_id,
                SpawnOptions {
                    cwd: repo.clone(),
                    prompt: "Inspect".to_string(),
                    model: None,
                    reasoning_effort: None,
                    skip_permissions: false,
                    extra_args: Vec::new(),
                    env: HashMap::new(),
                    branch: None,
                    timeout: None,
                    interactive: false,
                    structured_output: false,
                    resume_target: None,
                },
            )
            .await
            .unwrap();

        let launch_command = launch
            .metadata
            .get(TMUX_LAUNCH_COMMAND_METADATA_KEY)
            .cloned()
            .unwrap();
        assert!(launch_command.contains("plain"));
        assert!(!launch_command.contains("structured"));

        let socket_path = PathBuf::from(
            launch
                .metadata
                .get(TMUX_SOCKET_METADATA_KEY)
                .cloned()
                .unwrap(),
        );
        let tmux_session = launch
            .metadata
            .get(TMUX_SESSION_METADATA_KEY)
            .cloned()
            .unwrap();
        let status_output = tokio::process::Command::new("tmux")
            .arg("-S")
            .arg(&socket_path)
            .arg("show-options")
            .arg("-v")
            .arg("-t")
            .arg(&tmux_session)
            .arg("status")
            .output()
            .await
            .unwrap();
        assert!(status_output.status.success());
        assert_eq!(String::from_utf8_lossy(&status_output.stdout).trim(), "off");
        let _ = kill_tmux_session(&socket_path, &tmux_session).await;
        let _ = fs::remove_dir_all(&root);
    }

    struct TmuxRawInputHarnessExecutor;

    #[async_trait]
    impl Executor for TmuxRawInputHarnessExecutor {
        fn kind(&self) -> AgentKind {
            AgentKind::Codex
        }

        fn name(&self) -> &str {
            "Tmux Raw Input Harness"
        }

        fn binary_path(&self) -> &Path {
            Path::new("/bin/sh")
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn version(&self) -> Result<String> {
            Ok("test".to_string())
        }

        async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
            let args = self.build_args(&options);
            let handle =
                spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
            Ok(ExecutorHandle::new(
                handle.pid,
                self.kind(),
                handle.output_rx,
                handle.input_tx,
                handle.kill_tx,
            ))
        }

        fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
            vec![
                "-lc".to_string(),
                concat!(
                    "printf 'ready\\n'; ",
                    "IFS= read -r line; ",
                    "printf 'line:%s\\n' \"$line\"; ",
                    "old_tty=$(stty -g); ",
                    "stty raw -echo; ",
                    "bytes=$(dd bs=1 count=3 2>/dev/null | od -An -tx1 | tr -d ' \\n'); ",
                    "stty \"$old_tty\"; ",
                    "printf 'bytes:%s\\n' \"$bytes\"; ",
                    "sleep 0.2"
                )
                .to_string(),
            ]
        }

        fn parse_output(&self, line: &str) -> ExecutorOutput {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    #[tokio::test]
    async fn send_raw_to_session_preserves_escape_sequences_for_tmux_runtime() {
        let root = std::env::temp_dir().join(format!("conductor-tmux-raw-test-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let session_id = "tmux-raw-session";
        let state = build_state(&root).await;
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(TmuxRawInputHarnessExecutor));
        let executor = state
            .executors
            .read()
            .await
            .get(&AgentKind::Codex)
            .cloned()
            .unwrap();

        let launch = state
            .spawn_tmux_runtime(
                executor,
                session_id,
                SpawnOptions {
                    cwd: repo.clone(),
                    prompt: "Inspect".to_string(),
                    model: None,
                    reasoning_effort: None,
                    skip_permissions: false,
                    extra_args: Vec::new(),
                    env: HashMap::new(),
                    branch: None,
                    timeout: None,
                    interactive: false,
                    structured_output: false,
                    resume_target: None,
                },
            )
            .await
            .unwrap();
        let pid = launch.handle.pid;
        let mut record = SessionRecord::new(
            session_id.to_string(),
            "demo".to_string(),
            Some("session/tmux-raw".to_string()),
            None,
            Some(repo.to_string_lossy().to_string()),
            "codex".to_string(),
            None,
            None,
            "Inspect".to_string(),
            Some(pid),
        );
        record.status = SessionStatus::Working;
        record.activity = Some("active".to_string());
        record.metadata.extend(launch.metadata);
        state.replace_session(record).await.unwrap();

        state
            .send_to_session(
                session_id,
                "continue".to_string(),
                Vec::new(),
                None,
                None,
                "follow_up",
            )
            .await
            .unwrap();
        state
            .send_raw_to_session(session_id, "\u{1b}[A".to_string())
            .await
            .unwrap();

        let final_session = timeout(Duration::from_secs(5), async {
            loop {
                let session = state.get_session(session_id).await.unwrap();
                if session.output.contains("line:continue")
                    && session.output.contains("bytes:1b5b41")
                {
                    return session;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux runtime should receive raw escape sequences");

        assert!(final_session.output.contains("line:continue"));
        assert!(final_session.output.contains("bytes:1b5b41"));

        if let Some((socket_path, tmux_session)) = tmux_runtime_metadata(&final_session) {
            let _ = kill_tmux_session(&socket_path, &tmux_session).await;
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn kill_session_keeps_tmux_runtime_sessions_killed() {
        let root =
            std::env::temp_dir().join(format!("conductor-tmux-kill-test-{}", Uuid::new_v4()));
        let state = build_state(&root).await;

        let session = state
            .spawn_session_now(
                crate::state::SpawnRequest {
                    project_id: "demo".to_string(),
                    prompt: "Inspect".to_string(),
                    issue_id: None,
                    agent: None,
                    use_worktree: Some(true),
                    permission_mode: None,
                    model: None,
                    reasoning_effort: None,
                    branch: None,
                    base_branch: None,
                    task_id: None,
                    task_ref: None,
                    attempt_id: None,
                    parent_task_id: None,
                    retry_of_session_id: None,
                    profile: None,
                    brief_path: None,
                    attachments: Vec::new(),
                    source: "spawn".to_string(),
                },
                None,
            )
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(250)).await;
        state.kill_session(&session.id).await.unwrap();

        timeout(Duration::from_secs(3), async {
            loop {
                let current = state.get_session(&session.id).await.unwrap();
                if current.status == SessionStatus::Killed {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux session should transition to killed");

        tokio::time::sleep(Duration::from_secs(3)).await;
        let final_session = state.get_session(&session.id).await.unwrap();
        assert_eq!(final_session.status, SessionStatus::Killed);
        assert_eq!(final_session.summary.as_deref(), Some("Interrupted"));

        let _ = fs::remove_dir_all(&root);
    }
}
