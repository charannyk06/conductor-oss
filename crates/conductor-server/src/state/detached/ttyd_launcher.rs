//! Launch real ttyd binary per session for reliable terminal streaming.
//!
//! Conductor now treats ttyd as the only interactive runtime. Each session
//! gets a real ttyd process and one backend-owned upstream ttyd websocket.
//! The dashboard renders ttyd's native frontend through a same-origin backend
//! facade so the browser never creates a second terminal process upstream.
//!
//! Architecture:
//!   Browser <--> backend ttyd facade <--> backend-owned ttyd websocket <--> ttyd
//!                                                                         PTY -> shell -> agent

use anyhow::{anyhow, Context, Result};
use conductor_executors::executor::{Executor, ExecutorHandle, ExecutorInput, ExecutorOutput};
use conductor_executors::process::PtyDimensions;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::helpers::prepare_detached_runtime_env;
use super::types::{
    DETACHED_PID_METADATA_KEY, RUNTIME_MODE_METADATA_KEY, TTYD_PID_METADATA_KEY,
    TTYD_PORT_METADATA_KEY, TTYD_RUNTIME_MODE, TTYD_WS_URL_METADATA_KEY,
};
use super::RuntimeLaunch;
use crate::routes::ttyd_protocol;
use crate::state::AppState;
use conductor_executors::executor::SpawnOptions;

/// How long to wait for ttyd to bind its listening port.
const TTYD_STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const TTYD_OWNER_ATTACH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const TTYD_BINARY_ENV: &str = "CONDUCTOR_TTYD_BINARY";
const FALLBACK_INTERACTIVE_SHELLS: &[&str] = &["/bin/zsh", "/bin/bash", "/bin/sh"];

struct TtydSessionOwnerChannels {
    output_tx: mpsc::Sender<ExecutorOutput>,
    input_rx: mpsc::Receiver<ExecutorInput>,
    resize_rx: mpsc::Receiver<PtyDimensions>,
    ready_tx: Option<oneshot::Sender<Result<()>>>,
}

fn candidate_ttyd_paths(workspace_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    candidates.push(workspace_path.join(".conductor").join("bin").join("ttyd"));
    candidates.push(
        workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("bin")
            .join("ttyd"),
    );

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local").join("bin").join("ttyd"));
        candidates.push(home.join(".cargo").join("bin").join("ttyd"));
        candidates.push(home.join(".bun").join("bin").join("ttyd"));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/ttyd"));
        candidates.push(PathBuf::from("/usr/local/bin/ttyd"));
    }

    candidates
}

fn is_launchable_ttyd(path: &Path) -> bool {
    path.is_file()
}

pub fn resolve_ttyd_binary(workspace_path: &Path) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var(TTYD_BINARY_ENV) {
        let candidate = PathBuf::from(override_path.trim());
        if is_launchable_ttyd(&candidate) {
            return Some(candidate);
        }
    }

    for candidate in candidate_ttyd_paths(workspace_path) {
        if is_launchable_ttyd(&candidate) {
            return Some(candidate);
        }
    }

    which::which("ttyd").ok()
}

pub fn ttyd_missing_error(workspace_path: &Path) -> anyhow::Error {
    let searched = candidate_ttyd_paths(workspace_path)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    anyhow!(
        "ttyd runtime is required, but no ttyd binary was found. Install ttyd, set {TTYD_BINARY_ENV}, or place the binary in one of: {searched}"
    )
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }

    if value
        .bytes()
        .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'_' | b'-' | b':' | b'@' | b'+' | b'='))
    {
        return value.to_string();
    }

    format!("'{}'", value.replace('\'', r#"'\"'\"'"#))
}

fn build_agent_launch_command(binary: &Path, args: &[String]) -> String {
    std::iter::once(binary.to_string_lossy().to_string())
        .chain(args.iter().cloned())
        .map(|part| shell_quote(&part))
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_ttyd_shell_args(shell: &Path, binary: Option<&Path>, args: &[String]) -> Vec<String> {
    let shell_path = shell.to_string_lossy().to_string();
    let Some(binary) = binary else {
        return vec![shell_path, "-i".to_string()];
    };

    let interactive_shell = shell_quote(&shell_path);
    let bootstrap = format!("\"$@\"; exec {interactive_shell} -i");
    let mut ttyd_args = vec![
        shell_path,
        "-c".to_string(),
        bootstrap,
        "ttyd-agent".to_string(),
        binary.to_string_lossy().to_string(),
    ];
    ttyd_args.extend(args.iter().cloned());
    ttyd_args
}

fn resolve_interactive_shell(env: &HashMap<String, String>) -> PathBuf {
    let inherited_shell = std::env::var("SHELL").ok();
    let mut candidates = Vec::new();
    if let Some(shell) = env
        .get("SHELL")
        .map(String::as_str)
        .filter(|value| !value.is_empty())
    {
        candidates.push(PathBuf::from(shell));
    }
    if let Some(shell) = inherited_shell.as_deref().filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(shell));
    }
    candidates.extend(FALLBACK_INTERACTIVE_SHELLS.iter().map(PathBuf::from));

    for candidate in candidates {
        if candidate.is_file() {
            return candidate;
        }
    }

    PathBuf::from("/bin/sh")
}

fn reserve_ttyd_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .context("Failed to reserve a loopback port for ttyd")?;
    let port = listener
        .local_addr()
        .context("Failed to read reserved ttyd port")?
        .port();
    drop(listener);
    Ok(port)
}

async fn wait_for_ttyd_startup(
    child: &mut tokio::process::Child,
    port: u16,
    session_id: &str,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + TTYD_STARTUP_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().context("Failed to poll ttyd process")? {
            return Err(anyhow!(
                "ttyd exited before accepting connections for session {session_id}: {status}"
            ));
        }

        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("ttyd startup timeout"));
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

async fn drain_ttyd_log<R>(session_id: String, stream_name: &'static str, reader: R)
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(session_id = %session_id, stream = stream_name, ttyd = %line);
    }
}

/// Spawn a session through real ttyd binary for native WebSocket terminal streaming.
pub async fn spawn_ttyd_runtime(
    state: &Arc<AppState>,
    executor: Arc<dyn Executor>,
    session_id: &str,
    mut options: SpawnOptions,
    ttyd_binary: &Path,
) -> Result<RuntimeLaunch> {
    options.interactive = executor.supports_direct_terminal_ui();
    options.structured_output = false;
    let mut env_remove = Vec::new();
    prepare_detached_runtime_env(
        executor.kind(),
        options.interactive,
        &mut options.env,
        &mut env_remove,
    );

    let binary = executor.binary_path().to_path_buf();
    let args = executor.build_args(&options);
    let launch_command = build_agent_launch_command(&binary, &args);
    let terminal_shell = resolve_interactive_shell(&options.env);
    let ttyd_shell_args = build_ttyd_shell_args(&terminal_shell, Some(&binary), &args);
    let port = reserve_ttyd_port()?;

    let mut cmd = tokio::process::Command::new(ttyd_binary);
    cmd.arg("-p")
        .arg(port.to_string())
        .arg("-i")
        .arg("127.0.0.1")
        .arg("-W")
        .arg("-w")
        .arg(&options.cwd)
        .arg("-t")
        .arg("enableSixel=true")
        .arg("--ping-interval")
        .arg("30");
    for arg in &ttyd_shell_args {
        cmd.arg(arg);
    }
    for key in &env_remove {
        cmd.env_remove(key);
    }
    for (key, value) in &options.env {
        cmd.env(key, value);
    }
    cmd.current_dir(&options.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(unix)]
    {
        #[allow(unused_imports)]
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }

    let mut child = cmd.spawn().context("Failed to spawn ttyd")?;
    let ttyd_pid = child.id().unwrap_or(0);
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(drain_ttyd_log(session_id.to_string(), "stdout", stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain_ttyd_log(session_id.to_string(), "stderr", stderr));
    }
    wait_for_ttyd_startup(&mut child, port, session_id).await?;
    let ttyd_ws_url = ttyd_protocol::upstream_ws_url(port);
    tracing::info!(session_id, ttyd_pid, port, "ttyd launched");

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (input_tx, input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<PtyDimensions>(8);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    // Process monitor: wait for ttyd to exit
    let otx = output_tx.clone();
    let sid = session_id.to_string();
    let st = state.clone();
    tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = kill_rx => {
                #[cfg(unix)]
                if ttyd_pid > 0 {
                    unsafe {
                        libc::kill(-(ttyd_pid as i32), libc::SIGTERM);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    unsafe {
                        libc::kill(-(ttyd_pid as i32), libc::SIGKILL);
                    }
                }
                let _ = child.kill().await;
                let _ = otx.send(ExecutorOutput::Completed { exit_code: 0 }).await;
            }
            status = child.wait() => {
                let ec = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                tracing::info!(session_id = %sid, exit_code = ec, "ttyd exited");
                if ec == 0 {
                    let _ = otx
                        .send(ExecutorOutput::Completed { exit_code: ec })
                        .await;
                } else {
                    let _ = otx
                        .send(ExecutorOutput::Failed {
                            error: format!("ttyd exit {ec}"),
                            exit_code: Some(ec),
                        })
                        .await;
                }
            }
        }
        st.detach_terminal_runtime(&sid).await;
    });

    // Own a single ttyd websocket session inside the backend. ttyd spawns a
    // separate terminal process per websocket client, so Conductor must keep
    // exactly one upstream connection alive and expose that shared session to
    // the browser through its own ttyd-compatible facade.
    let st2 = state.clone();
    let sid2 = session_id.to_string();
    let url2 = ttyd_ws_url.clone();
    let owner_executor = executor.clone();
    let (owner_ready_tx, owner_ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        if let Err(err) = run_ttyd_session_owner(
            &st2,
            &sid2,
            &url2,
            owner_executor,
            TtydSessionOwnerChannels {
                output_tx,
                input_rx,
                resize_rx,
                ready_tx: Some(owner_ready_tx),
            },
        )
        .await
        {
            tracing::warn!(session_id = %sid2, error = %err, "ttyd session owner exited");
        }
    });
    tokio::time::timeout(TTYD_OWNER_ATTACH_TIMEOUT, owner_ready_rx)
        .await
        .context("Timed out waiting for ttyd session owner to attach")?
        .map_err(|_| anyhow!("ttyd session owner did not report readiness"))??;

    let handle = ExecutorHandle::new(ttyd_pid, executor.kind(), output_rx, input_tx, kill_tx)
        .with_terminal_io(None, Some(resize_tx));

    Ok(RuntimeLaunch {
        handle,
        metadata: HashMap::from([
            (
                RUNTIME_MODE_METADATA_KEY.to_string(),
                TTYD_RUNTIME_MODE.to_string(),
            ),
            (TTYD_PORT_METADATA_KEY.to_string(), port.to_string()),
            (TTYD_PID_METADATA_KEY.to_string(), ttyd_pid.to_string()),
            (TTYD_WS_URL_METADATA_KEY.to_string(), ttyd_ws_url),
            (DETACHED_PID_METADATA_KEY.to_string(), ttyd_pid.to_string()),
            ("agentLaunchCommand".to_string(), launch_command),
            (
                "terminalShell".to_string(),
                terminal_shell.to_string_lossy().to_string(),
            ),
        ]),
        streams_terminal_bytes: true,
    })
}

/// Restore a ttyd session after server restart.
/// If the ttyd process is still alive, reconnect mirror and input forwarder.
/// If dead, mark the session as completed.
pub async fn restore_ttyd_runtime(state: &Arc<AppState>, session_id: &str) -> Result<()> {
    if state.terminal_runtime_attached(session_id).await {
        return Ok(());
    }

    let session = state
        .get_session(session_id)
        .await
        .ok_or_else(|| anyhow!("Session {session_id} not found"))?;

    let pid_str = session
        .metadata
        .get(TTYD_PID_METADATA_KEY)
        .ok_or_else(|| anyhow!("No ttyd PID in session metadata"))?;
    let pid = pid_str.parse::<u32>().context("Invalid ttyd PID")?;
    let ws_url = session
        .metadata
        .get(TTYD_WS_URL_METADATA_KEY)
        .cloned()
        .ok_or_else(|| anyhow!("No ttyd WS URL in session metadata"))?;

    // Check if ttyd process is still alive
    #[cfg(unix)]
    let alive = pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0;
    #[cfg(not(unix))]
    let alive = false;

    if !alive {
        tracing::info!(session_id, pid, "ttyd process is dead, marking completed");
        state
            .apply_runtime_event(session_id, ExecutorOutput::Completed { exit_code: 0 })
            .await?;
        return Ok(());
    }

    tracing::info!(session_id, pid, %ws_url, "Restoring ttyd session");

    let executors = state.executors.read().await;
    let executor = executors
        .get(&conductor_core::types::AgentKind::parse(&session.agent))
        .cloned()
        .ok_or_else(|| anyhow!("Executor '{}' is not available", session.agent))?;
    drop(executors);

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (input_tx, input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<PtyDimensions>(8);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    // Process monitor: poll for ttyd exit (we don't own the child handle)
    let otx = output_tx.clone();
    let sid = session_id.to_string();
    let st = state.clone();
    tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = kill_rx => {
                #[cfg(unix)]
                if pid > 0 {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                let _ = otx.send(ExecutorOutput::Completed { exit_code: 0 }).await;
            }
            _ = async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    #[cfg(unix)]
                    if unsafe { libc::kill(pid as i32, 0) } != 0 {
                        break;
                    }
                    #[cfg(not(unix))]
                    break;
                }
            } => {
                tracing::info!(session_id = %sid, "ttyd process exited (restored session)");
                let _ = otx.send(ExecutorOutput::Completed { exit_code: 0 }).await;
            }
        }
        st.detach_terminal_runtime(&sid).await;
    });

    let st2 = state.clone();
    let sid2 = session_id.to_string();
    let url2 = ws_url;
    let owner_executor = executor.clone();
    let (owner_ready_tx, owner_ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        if let Err(err) = run_ttyd_session_owner(
            &st2,
            &sid2,
            &url2,
            owner_executor,
            TtydSessionOwnerChannels {
                output_tx,
                input_rx,
                resize_rx,
                ready_tx: Some(owner_ready_tx),
            },
        )
        .await
        {
            tracing::warn!(
                session_id = %sid2,
                error = %err,
                "restored ttyd session owner exited"
            );
        }
    });
    tokio::time::timeout(TTYD_OWNER_ATTACH_TIMEOUT, owner_ready_rx)
        .await
        .context("Timed out waiting for restored ttyd session owner to attach")?
        .map_err(|_| anyhow!("restored ttyd session owner did not report readiness"))??;

    let handle = ExecutorHandle::new(pid, executor.kind(), output_rx, input_tx, kill_tx)
        .with_terminal_io(None, Some(resize_tx));
    let (_pid, _kind, output_rx, input_tx, terminal_rx, resize_tx, kill_tx) = handle.into_parts();

    state
        .attach_terminal_runtime(session_id, input_tx, resize_tx, kill_tx)
        .await;
    state.start_output_consumer(
        session_id.to_string(),
        executor,
        output_rx,
        crate::state::OutputConsumerConfig {
            terminal_rx,
            mirror_terminal_output: false,
            output_is_parsed: true,
            timeout: None,
        },
    );

    Ok(())
}

/// Own the single upstream ttyd websocket session used by Conductor.
async fn run_ttyd_session_owner(
    state: &Arc<AppState>,
    sid: &str,
    url: &str,
    executor: Arc<dyn Executor>,
    mut channels: TtydSessionOwnerChannels,
) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    let request = ttyd_protocol::connect_request(url).context("mirror request")?;
    let (ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(connection) => connection,
        Err(err) => {
            let error = anyhow!(err).context("ttyd session owner connect");
            if let Some(tx) = channels.ready_tx.take() {
                let _ = tx.send(Err(anyhow!(error.to_string())));
            }
            return Err(error);
        }
    };
    let (mut w, mut r) = ws.split();
    if let Err(err) = w
        .send(WsMessage::Binary(
            ttyd_protocol::encode_handshake(160, 48).into(),
        ))
        .await
    {
        let error = anyhow!(err).context("ttyd session owner handshake");
        if let Some(tx) = channels.ready_tx.take() {
            let _ = tx.send(Err(anyhow!(error.to_string())));
        }
        return Err(error);
    }
    if let Some(tx) = channels.ready_tx.take() {
        let _ = tx.send(Ok(()));
    }
    let mut buf = String::new();
    let mut input_closed = false;
    let mut resize_closed = false;
    loop {
        tokio::select! {
            message = r.next() => match message {
                Some(Ok(WsMessage::Binary(data))) if data.len() > 1 && data[0] == ttyd_protocol::CMD_OUTPUT => {
                    let payload = &data[1..];
                        state.emit_terminal_bytes(sid, payload).await;
                        buf.push_str(&String::from_utf8_lossy(payload));
                        while let Some(nl) = buf.find('\n') {
                            let line = buf[..nl].to_string();
                            buf = buf[nl + 1..].to_string();
                            if !line.trim().is_empty()
                            && channels.output_tx.send(executor.parse_output(&line)).await.is_err()
                        {
                            return Ok(());
                        }
                    }
                }
                Some(Ok(WsMessage::Binary(_))) | Some(Ok(WsMessage::Text(_))) | Some(Ok(WsMessage::Ping(_))) | Some(Ok(WsMessage::Pong(_))) | Some(Ok(WsMessage::Frame(_))) => {}
                Some(Ok(WsMessage::Close(_))) | None => break,
                Some(Err(err)) => return Err(err.into()),
            },
            input = channels.input_rx.recv(), if !input_closed => match input {
                Some(input) => {
                    send_input_frame(&mut w, &input)
                        .await
                        .context("ttyd session owner input send failed")?;
                }
                None => {
                    input_closed = true;
                }
            },
            resize = channels.resize_rx.recv(), if !resize_closed => match resize {
                Some(dimensions) => {
                    send_resize_frame(&mut w, dimensions)
                        .await
                        .context("ttyd session owner resize send failed")?;
                }
                None => {
                    resize_closed = true;
                }
            },
        }
    }
    if !buf.trim().is_empty() {
        let _ = channels.output_tx.send(executor.parse_output(&buf)).await;
    }
    let _ = channels
        .output_tx
        .send(ExecutorOutput::Completed { exit_code: 0 })
        .await;
    Ok(())
}

async fn send_input_frame<S>(
    sink: &mut S,
    input: &ExecutorInput,
) -> std::result::Result<(), tokio_tungstenite::tungstenite::Error>
where
    S: futures_util::Sink<WsMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let mut frame = vec![ttyd_protocol::CMD_INPUT];
    match input {
        ExecutorInput::Raw(text) => frame.extend_from_slice(text.as_bytes()),
        ExecutorInput::Text(text) => {
            frame.extend_from_slice(text.as_bytes());
            if !text.ends_with('\n') && !text.ends_with('\r') {
                frame.push(b'\r');
            }
        }
    }
    futures_util::SinkExt::send(sink, WsMessage::Binary(frame.into())).await
}

async fn send_resize_frame<S>(
    sink: &mut S,
    dimensions: PtyDimensions,
) -> std::result::Result<(), tokio_tungstenite::tungstenite::Error>
where
    S: futures_util::Sink<WsMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    futures_util::SinkExt::send(
        sink,
        WsMessage::Binary(ttyd_protocol::encode_resize(dimensions.cols, dimensions.rows).into()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{build_agent_launch_command, build_ttyd_shell_args, resolve_interactive_shell};
    use crate::routes::ttyd_protocol;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    #[test]
    fn build_agent_launch_command_quotes_special_arguments() {
        let command = build_agent_launch_command(
            Path::new("/opt/homebrew/bin/qwen"),
            &[
                "--prompt-interactive".to_string(),
                "review 'all' files".to_string(),
                "--model".to_string(),
                "qwen-max".to_string(),
            ],
        );

        assert_eq!(
            command,
            "/opt/homebrew/bin/qwen --prompt-interactive 'review '\\\"'\\\"'all'\\\"'\\\"' files' --model qwen-max"
        );
    }

    #[test]
    fn resolve_interactive_shell_prefers_explicit_shell_env() {
        let shell = resolve_interactive_shell(&HashMap::from([(
            "SHELL".to_string(),
            "/bin/sh".to_string(),
        )]));

        assert_eq!(shell, PathBuf::from("/bin/sh"));
    }

    #[test]
    fn build_ttyd_shell_args_runs_agent_then_falls_back_to_interactive_shell() {
        let args = build_ttyd_shell_args(
            Path::new("/bin/zsh"),
            Some(Path::new("/Users/test/.opencode/bin/opencode")),
            &["--prompt".to_string(), "review repo".to_string()],
        );

        assert_eq!(args[0], "/bin/zsh");
        assert_eq!(args[1], "-c");
        assert_eq!(args[2], "\"$@\"; exec /bin/zsh -i");
        assert_eq!(args[3], "ttyd-agent");
        assert_eq!(args[4], "/Users/test/.opencode/bin/opencode");
        assert_eq!(args[5], "--prompt");
        assert_eq!(args[6], "review repo");
    }

    #[test]
    fn build_ttyd_shell_args_keeps_plain_interactive_shell_without_launch_command() {
        let args = build_ttyd_shell_args(Path::new("/bin/sh"), None, &[]);
        assert_eq!(args, vec!["/bin/sh".to_string(), "-i".to_string()]);
    }

    #[test]
    fn ttyd_protocol_handshake_starts_with_json_data_prefix() {
        let frame = ttyd_protocol::encode_handshake(160, 48);
        assert_eq!(frame.first().copied(), Some(ttyd_protocol::CMD_JSON_DATA));
    }
}
