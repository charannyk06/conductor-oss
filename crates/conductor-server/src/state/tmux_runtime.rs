use anyhow::{anyhow, Context, Result};
use conductor_core::config::ProjectConfig;
use conductor_executors::executor::{
    Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions,
};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{mpsc, oneshot};

use crate::state::{AppState, SessionRecord, SessionStatus};

pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
pub(crate) const TMUX_RUNTIME_MODE: &str = "tmux";
pub(crate) const RUNTIME_MODE_METADATA_KEY: &str = "runtimeMode";
pub(crate) const TMUX_SESSION_METADATA_KEY: &str = "tmuxSession";
pub(crate) const TMUX_SOCKET_METADATA_KEY: &str = "tmuxSocket";
pub(crate) const TMUX_LOG_PATH_METADATA_KEY: &str = "tmuxLogPath";
pub(crate) const TMUX_EXIT_PATH_METADATA_KEY: &str = "tmuxExitPath";
pub(crate) const TMUX_LOG_OFFSET_METADATA_KEY: &str = "tmuxLogOffset";

const TMUX_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TMUX_EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const TMUX_ACTIVITY_WATCH_INTERVAL: Duration = Duration::from_secs(2);

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

fn prompt_visible(agent: &str, line: &str) -> bool {
    if line.is_empty() {
        return false;
    }

    match conductor_core::types::AgentKind::parse(agent) {
        conductor_core::types::AgentKind::Codex => {
            line.starts_with('›')
                || matches!(line, ">" | "$" | "#")
                || line
                    .split_whitespace()
                    .next()
                    .map(|token| token.chars().all(|ch| ch.is_ascii_digit() || ch == '%'))
                    .unwrap_or(false)
                    && (line.contains(" left") || line.contains(" remaining"))
        }
        conductor_core::types::AgentKind::Gemini => {
            line.starts_with('❯') || matches!(line, ">" | "$" | "#")
        }
        _ => matches!(line, "❯" | ">" | "$" | "#"),
    }
}

fn classify_tmux_pane(agent: &str, pane: &str) -> TmuxActivityState {
    if pane.trim().is_empty() {
        return TmuxActivityState::Ready;
    }

    let lines = pane_lines(pane);
    let last_line = last_non_empty_line(pane);
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

    if tail.contains("not authenticated")
        || tail.contains("authentication required")
        || tail.contains("login required")
        || tail.contains("auth login")
        || tail.contains("device code")
        || tail.contains("open this url to authenticate")
        || (tail.contains("sign in") && tail.contains("browser"))
    {
        return TmuxActivityState::Blocked;
    }

    if tail.contains("(y)es") && tail.contains("(n)o")
        || tail.contains("do you want")
        || tail.contains("confirm")
        || tail.contains("approve")
        || tail.contains("proceed")
        || tail.contains("select an option")
        || tail.contains("press enter to continue")
        || tail.contains("bypass permissions")
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
    let lines = pane_lines(pane);
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
        .unwrap_or_else(|| last_non_empty_line(pane));

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
        if self.live_sessions.read().await.contains_key(session_id) {
            return Ok(true);
        }

        let Some(session) = self.get_session(session_id).await else {
            return Ok(false);
        };

        if matches!(session.status, SessionStatus::Archived | SessionStatus::Killed) {
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
        Ok(self.live_sessions.read().await.contains_key(session_id))
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

        let summary_changed = summary.as_deref() != current.summary.as_deref();
        let status_changed = current.status != next_status;
        let activity_changed = current.activity.as_deref() != Some(next_activity);

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

        let command = build_shell_command(
            executor.binary_path(),
            &executor.build_args(&options),
            &options.env,
        );
        let wrapper = format!(
            "while [ ! -f {ready} ]; do sleep 0.05; done; {command}; status=$?; printf '%s' \"$status\" > {exit_path}; exit $status",
            ready = shell_escape(&ready_path.to_string_lossy()),
            command = command,
            exit_path = shell_escape(&exit_path.to_string_lossy()),
        );

        run_tmux_command(
            &socket_path,
            [
                "new-session",
                "-d",
                "-s",
                session_name.as_str(),
                "-c",
                options.cwd.to_string_lossy().as_ref(),
            ],
            Some(format!("sh -c {}", shell_escape(&wrapper))),
        )
        .await
        .with_context(|| format!("Failed to create tmux session {session_name}"))?;

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

            self.live_sessions.write().await.insert(
                session_id.to_string(),
                Arc::new(super::types::LiveSessionHandle {
                    input_tx,
                    kill_tx: tokio::sync::Mutex::new(Some(kill_tx)),
                }),
            );

            self.start_output_consumer(session_id.to_string(), executor, output_rx, false, None);

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
            if let Some((next_offset, lines)) =
                read_tmux_log_delta(&log_path, offset, &mut partial).await?
            {
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
    let status = tokio::process::Command::new("tmux")
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

async fn capture_tmux_pane(socket_path: &Path, session_name: &str, lines: usize) -> Result<String> {
    let output = tokio::process::Command::new("tmux")
        .arg("-S")
        .arg(socket_path)
        .arg("capture-pane")
        .arg("-p")
        .arg("-t")
        .arg(session_name)
        .arg("-S")
        .arg(format!("-{lines}"))
        .output()
        .await
        .with_context(|| format!("Failed to capture tmux pane for {session_name}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(anyhow!("tmux capture-pane failed for {session_name}"))
    }
}

pub(crate) async fn kill_tmux_session(socket_path: &Path, session_name: &str) -> Result<()> {
    let status = tokio::process::Command::new("tmux")
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
    let status = tokio::process::Command::new("tmux")
        .arg("-V")
        .status()
        .await
        .context("Failed to execute tmux")?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("tmux is required for runtime 'tmux'"))
    }
}

async fn tmux_pane_pid(socket_path: &Path, session_name: &str) -> Result<u32> {
    let output = tokio::process::Command::new("tmux")
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
    let mut command = tokio::process::Command::new("tmux");
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
    let status = tokio::process::Command::new("tmux")
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
        let status = tokio::process::Command::new("tmux")
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

async fn send_tmux_enter(socket_path: &Path, session_name: &str) -> Result<()> {
    let status = tokio::process::Command::new("tmux")
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

async fn read_tmux_log_delta(
    log_path: &Path,
    offset: u64,
    partial: &mut Vec<u8>,
) -> Result<Option<(u64, Vec<String>)>> {
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
    partial.extend_from_slice(&chunk);
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

    Ok(Some((next_offset, lines)))
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

    async fn build_state(root: &Path) -> Arc<AppState> {
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();

        let mut config = ConductorConfig::default();
        config.workspace = root.to_path_buf();
        config.preferences.coding_agent = "codex".to_string();
        config.projects = BTreeMap::from([(
            "demo".to_string(),
            ProjectConfig {
                path: repo.to_string_lossy().to_string(),
                agent: Some("codex".to_string()),
                runtime: Some(TMUX_RUNTIME_MODE.to_string()),
                default_branch: "main".to_string(),
                ..ProjectConfig::default()
            },
        )]);

        let db = Database::in_memory().await.unwrap();
        let state = AppState::new(root.join("conductor.yaml"), config, db).await;
        state
            .executors
            .write()
            .await
            .insert(AgentKind::Codex, Arc::new(TmuxHarnessExecutor));
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

        let final_session = timeout(Duration::from_secs(5), async {
            loop {
                let session = restored.get_session(session_id).await.unwrap();
                if session.status == SessionStatus::NeedsInput && session.output.contains("phase-two") {
                    return session;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux session should finish after reattach");

        assert_eq!(
            final_session
                .metadata
                .get(RUNTIME_MODE_METADATA_KEY)
                .map(String::as_str),
            Some(TMUX_RUNTIME_MODE)
        );
        assert!(final_session.output.contains("phase-two"));
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
