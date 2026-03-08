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

use crate::state::{AppState, SessionRecord};

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

impl AppState {
    pub(crate) async fn spawn_with_runtime(
        self: &Arc<Self>,
        project: &ProjectConfig,
        executor: Arc<dyn Executor>,
        session_id: &str,
        options: SpawnOptions,
    ) -> Result<RuntimeLaunch> {
        match runtime_mode(project) {
            TMUX_RUNTIME_MODE => self.spawn_tmux_runtime(executor, session_id, options).await,
            _ => {
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
                .filter(|session| !super::helpers::is_terminal_status(&session.status))
                .filter(|session| {
                    session
                        .metadata
                        .get(RUNTIME_MODE_METADATA_KEY)
                        .map(|value| value == TMUX_RUNTIME_MODE)
                        .unwrap_or(false)
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
            Some(format!("sh -lc {}", shell_escape(&wrapper))),
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

            self.start_output_consumer(session_id.to_string(), executor, output_rx);

            let mut sessions = self.sessions.write().await;
            if let Some(current) = sessions.get_mut(session_id) {
                current.pid = Some(pid);
                current.activity = match current.status.as_str() {
                    "needs_input" => Some("waiting_input".to_string()),
                    "queued" => Some("idle".to_string()),
                    _ => Some("active".to_string()),
                };
                current.status = match current.status.as_str() {
                    "spawning" => "working".to_string(),
                    other => other.to_string(),
                };
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
            current.status = "stuck".to_string();
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
                        if let Err(err) =
                            send_tmux_literal(&input_socket, &input_session_name, &text).await
                        {
                            Err(err)
                        } else if text.ends_with('\n') || text.ends_with('\r') {
                            Ok(())
                        } else {
                            send_tmux_enter(&input_socket, &input_session_name).await
                        }
                    }
                    ExecutorInput::Raw(raw) => {
                        send_tmux_literal(&input_socket, &input_session_name, &raw).await
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
        record.status = "working".to_string();
        record.activity = Some("active".to_string());
        record.metadata.extend(metadata);
        state.replace_session(record).await.unwrap();

        tokio::time::sleep(Duration::from_millis(300)).await;

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
                if session.status == "needs_input" && session.output.contains("phase-two") {
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
        assert!(final_session.output.contains("phase-one"));
        assert!(final_session.output.contains("phase-two"));
        assert!(!final_session.metadata.contains_key("recoveryState"));

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
                if current.status == "killed" {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("tmux session should transition to killed");

        tokio::time::sleep(Duration::from_secs(3)).await;
        let final_session = state.get_session(&session.id).await.unwrap();
        assert_eq!(final_session.status, "killed");
        assert_eq!(final_session.summary.as_deref(), Some("Interrupted"));

        let _ = fs::remove_dir_all(&root);
    }
}
