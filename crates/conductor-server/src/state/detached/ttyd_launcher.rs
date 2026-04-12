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
const TTYD_OWNER_ATTACH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const TTYD_OWNER_CONNECT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);
const TTYD_OWNER_RECONNECT_BASE_DELAY: std::time::Duration = std::time::Duration::from_millis(500);
const TTYD_OWNER_RECONNECT_MAX_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
/// Maximum silence before considering the ttyd connection dead.
/// ttyd sends pings every 30s (via --ping-interval), so 5 minutes of silence
/// means ~10 missed pings, which is a clear sign the connection is gone.
/// This replaces the old 90s read timeout which caused false disconnects
/// during normal interactive idle periods.
const TTYD_OWNER_SILENCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// Maximum reconnect attempts before giving up permanently.
/// Prevents unbounded retry loops and output consumer task leaks.
const TTYD_OWNER_RECONNECT_MAX_ATTEMPTS: u32 = 20;
/// Maximum session lifetime.  After this duration the session is considered
/// stale and the ttyd process is terminated.  4 hours is long enough for most
/// workflows while still providing a safety net.
const TTYD_MAX_SESSION_DURATION: std::time::Duration = std::time::Duration::from_secs(4 * 60 * 60);
const TTYD_BINARY_ENV: &str = "CONDUCTOR_TTYD_BINARY";
const FALLBACK_INTERACTIVE_SHELLS: &[&str] = &["/bin/zsh", "/bin/bash", "/bin/sh"];

struct TtydSessionOwnerChannels {
    output_tx: mpsc::Sender<ExecutorOutput>,
    input_rx: mpsc::Receiver<ExecutorInput>,
    resize_rx: mpsc::Receiver<PtyDimensions>,
    ready_tx: Option<oneshot::Sender<Result<()>>>,
}

#[derive(Debug)]
struct SessionExceededMaxDurationError {
    max_duration_secs: u64,
}

impl std::fmt::Display for SessionExceededMaxDurationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "session exceeded maximum duration of {} seconds",
            self.max_duration_secs
        )
    }
}

impl std::error::Error for SessionExceededMaxDurationError {}

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

/// Pick an ephemeral loopback port for ttyd.
///
/// We bind a temporary listener only long enough to ask the OS for a free port,
/// then immediately close it before spawning ttyd. Keeping the placeholder
/// listener open prevents ttyd from binding the same address on Linux and makes
/// the startup probe connect to the placeholder instead of ttyd itself.
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
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                tracing::debug!(session_id = %session_id, stream = stream_name, ttyd = %line);
            }
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id,
                    stream = stream_name,
                    error = %err,
                    "ttyd log stream error, stopping drain"
                );
                break;
            }
        }
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

    // TODO(P3): Add ttyd -c credential flag to prevent unauthorized local
    // connections to the terminal port. Requires updating the session owner
    // WebSocket handshake to include Basic auth. Currently blocked by ttyd's
    // auth flow requiring a JSON handshake step after HTTP upgrade.
    // let ttyd_auth_token = hex::encode(uuid::Uuid::new_v4().as_bytes());

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

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8192);
    let (input_tx, input_rx) = mpsc::channel::<ExecutorInput>(64);
    let (resize_tx, resize_rx) = mpsc::channel::<PtyDimensions>(8);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    // Process monitor: wait for ttyd to exit, with panic recovery.
    // A separate health-check task ensures ttyd is still alive even if the
    // monitor task panics (e.g., due to a tokio runtime issue).
    let otx = output_tx.clone();
    let sid = session_id.to_string();
    let st = state.clone();
    let monitor_handle = tokio::spawn(async move {
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
        // Clean up cloudflared tunnel when the ttyd session ends.
        super::tunnel_launcher::kill_tunnel(&st, &sid).await;
        st.detach_terminal_runtime(&sid).await;
    });

    // Health-check supervisor: if the monitor task panics, detect ttyd exit
    // via periodic PID checks and clean up.
    {
        let st = state.clone();
        let sid = session_id.to_string();
        let otx = output_tx.clone();
        let monitor = monitor_handle;
        tokio::spawn(async move {
            // Wait for the monitor to finish normally first.
            if let Ok(()) = monitor.await {
                return; // Monitor exited cleanly, no need for health check.
            }
            // Monitor panicked. Poll ttyd PID until it dies.
            tracing::warn!(session_id = %sid, "ttyd process monitor panicked, starting PID health check");
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                #[cfg(unix)]
                let alive = unsafe { libc::kill(ttyd_pid as i32, 0) } == 0;
                #[cfg(not(unix))]
                let alive = false;
                if !alive {
                    tracing::info!(session_id = %sid, "ttyd process died (detected by health check)");
                    let _ = otx.send(ExecutorOutput::Completed { exit_code: -1 }).await;
                    st.detach_terminal_runtime(&sid).await;
                    return;
                }
            }
        });
    }

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
        if let Err(err) = run_ttyd_session_owner_with_retry(
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
            tracing::warn!(session_id = %sid2, error = %err, "ttyd session owner exited permanently");
        }
    });
    let owner_attach = tokio::time::timeout(TTYD_OWNER_ATTACH_TIMEOUT, owner_ready_rx).await;
    match owner_attach {
        Ok(Ok(Ok(()))) => {} // Success
        _ => {
            // Owner failed to attach: kill the ttyd process to prevent a leak.
            tracing::warn!(
                session_id,
                ttyd_pid,
                "ttyd session owner failed to attach, killing ttyd process to prevent leak"
            );
            // Use kill_tx to signal the process monitor to shut down ttyd.
            // This works cross-platform unlike direct signal sending.
            let _ = kill_tx.send(());
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            return Err(anyhow!(
                "Timed out waiting for ttyd session owner to attach"
            ));
        }
    }

    let handle = ExecutorHandle::new(ttyd_pid, executor.kind(), output_rx, input_tx, kill_tx)
        .with_terminal_io(None, Some(resize_tx));

    // Store the session start time as seconds since epoch so the 4-hour cap
    // survives backend restarts (CR-7).
    let session_start_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut metadata = HashMap::from([
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
        (
            "ttyd_session_start_time".to_string(),
            session_start_secs.to_string(),
        ),
    ]);

    // Try to establish a Cloudflare tunnel for direct browser access.
    // This is non-blocking: if cloudflared is not installed or the tunnel
    // fails, the session falls back to the existing backend proxy facade.
    let _tunnel_result = if super::tunnel_launcher::resolve_cloudflared_binary().is_some() {
        match super::tunnel_launcher::spawn_tunnel(port).await {
            Ok((mut tunnel_child, tunnel_url)) => {
                let Some(tunnel_pid) = tunnel_child.id().filter(|pid| *pid > 0) else {
                    tracing::warn!(
                        session_id,
                        port,
                        "Cloudflare tunnel started without exposing a non-zero PID, skipping tunnel metadata"
                    );
                    return Ok(RuntimeLaunch {
                        handle,
                        metadata,
                        streams_terminal_bytes: true,
                    });
                };
                tracing::info!(
                    session_id,
                    port,
                    %tunnel_url,
                    tunnel_pid,
                    "Cloudflare tunnel established for session"
                );
                metadata.insert(
                    super::types::TTYD_TUNNEL_URL_METADATA_KEY.to_string(),
                    tunnel_url.clone(),
                );
                metadata.insert(
                    super::types::TUNNEL_PID_METADATA_KEY.to_string(),
                    tunnel_pid.to_string(),
                );

                // Reap the cloudflared process when it exits to prevent zombies.
                // The tunnel lives until kill_tunnel() is called on session end.
                let reap_sid = session_id.to_string();
                let reap_state = state.clone();
                tokio::spawn(async move {
                    let _ = tunnel_child.wait().await;
                    tracing::info!(session_id = %reap_sid, "cloudflared tunnel process exited");
                    let mut sessions = reap_state.sessions.write().await;
                    if let Some(session) = sessions.get_mut(&reap_sid) {
                        session
                            .metadata
                            .remove(super::types::TTYD_TUNNEL_URL_METADATA_KEY);
                        session
                            .metadata
                            .remove(super::types::TUNNEL_PID_METADATA_KEY);
                    }
                });

                Some(tunnel_url)
            }
            Err(err) => {
                tracing::warn!(
                    session_id,
                    error = %err,
                    "Cloudflare tunnel failed, falling back to backend proxy"
                );
                None
            }
        }
    } else {
        tracing::debug!(session_id, "cloudflared not found, skipping tunnel");
        None
    };

    Ok(RuntimeLaunch {
        handle,
        metadata,
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
    let alive = if pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0 {
        // Verify it's actually a ttyd process (not a reused PID).
        let comm_path = format!("/proc/{}/comm", pid);
        if let Ok(comm) = std::fs::read_to_string(&comm_path) {
            comm.trim() == "ttyd"
        } else {
            // No /proc (macOS) — fall back to verifying the port is reachable
            if let Some(port_str) = session.metadata.get(TTYD_PORT_METADATA_KEY) {
                if let Ok(port_num) = port_str.parse::<u16>() {
                    TcpStream::connect(("127.0.0.1", port_num)).await.is_ok()
                } else {
                    false
                }
            } else {
                false
            }
        }
    } else {
        false
    };
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

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(8192);
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
        // Clean up cloudflared tunnel when the restored session ends.
        super::tunnel_launcher::kill_tunnel(&st, &sid).await;
        st.detach_terminal_runtime(&sid).await;
    });

    let st2 = state.clone();
    let sid2 = session_id.to_string();
    let url2 = ws_url;
    let owner_executor = executor.clone();
    let (owner_ready_tx, owner_ready_rx) = oneshot::channel();
    tokio::spawn(async move {
        if let Err(err) = run_ttyd_session_owner_with_retry(
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
                "restored ttyd session owner exited permanently"
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
            output_is_parsed: false,
            timeout: None,
        },
    );
    state.mark_session_runtime_restored(session_id).await?;

    Ok(())
}

/// Wrap `run_ttyd_session_owner` with automatic reconnection.
///
/// If the upstream ttyd WebSocket drops (network glitch, idle timeout, etc.),
/// the ttyd process itself keeps running. This wrapper reconnects to the same
/// ttyd process up to `TTYD_OWNER_RECONNECT_MAX_ATTEMPTS` times with
/// exponential backoff, creating fresh channels for each attempt.
async fn run_ttyd_session_owner_with_retry(
    state: &Arc<AppState>,
    sid: &str,
    url: &str,
    executor: Arc<dyn Executor>,
    initial_channels: TtydSessionOwnerChannels,
) -> Result<()> {
    let mut channels = initial_channels;
    let mut attempt: u32 = 0;
    // Track elapsed session time. On restore, try to use the original start time
    // from metadata so the 4-hour cap does not reset after backend restart.
    let session_start = state
        .get_session(sid)
        .await
        .and_then(|s| s.metadata.get("ttyd_session_start_time").cloned())
        .and_then(|v| v.parse::<u64>().ok())
        .map(|stored_epoch_secs| {
            let current_epoch_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let elapsed_secs = current_epoch_secs.saturating_sub(stored_epoch_secs);
            tokio::time::Instant::now() - std::time::Duration::from_secs(elapsed_secs)
        })
        .unwrap_or_else(tokio::time::Instant::now);

    loop {
        let result =
            run_ttyd_session_owner(state, sid, url, executor.clone(), channels, session_start)
                .await;

        match &result {
            Ok(()) => return Ok(()),
            Err(err) => {
                if session_exceeded_max_duration(err) {
                    tracing::info!(
                        session_id = %sid,
                        error = %err,
                        "ttyd session reached maximum duration, shutting down without reconnect"
                    );
                    state
                        .emit_terminal_stream_event(
                            sid,
                            crate::state::types::TerminalStreamEvent::Error(
                                "Terminal session reached its maximum lifetime and was closed."
                                    .to_string(),
                            ),
                        )
                        .await;
                    state.detach_terminal_runtime(sid).await;
                    return Ok(());
                }

                // Check if the ttyd process is still alive before reconnecting.
                // We verify not just that the PID exists but that it is actually a ttyd process.
                let session = state.get_session(sid).await;
                let ttyd_alive = session
                    .as_ref()
                    .and_then(|s| s.metadata.get(TTYD_PID_METADATA_KEY))
                    .and_then(|p| p.parse::<u32>().ok())
                    .map(|pid| {
                        #[cfg(unix)]
                        {
                            // First check if PID exists via kill(pid, 0)
                            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                                return false;
                            }
                            // Verify it is a ttyd process.
                            // On Linux, check /proc/<pid>/comm. On macOS (no /proc),
                            // use `ps -p <pid> -o comm=` to get the process name.
                            #[cfg(target_os = "linux")]
                            {
                                let comm_path = format!("/proc/{}/comm", pid);
                                if let Ok(comm) = std::fs::read_to_string(&comm_path) {
                                    return comm.trim() == "ttyd";
                                }
                            }
                            #[cfg(not(target_os = "linux"))]
                            {
                                if let Ok(output) = std::process::Command::new("ps")
                                    .args(["-p", &pid.to_string(), "-o", "comm="])
                                    .output()
                                {
                                    if let Ok(name) = String::from_utf8(output.stdout) {
                                        return name.trim() == "ttyd";
                                    }
                                }
                            }
                            // If neither check worked, verify PID still exists
                            unsafe { libc::kill(pid as i32, 0) == 0 }
                        }
                        #[cfg(not(unix))]
                        {
                            false
                        }
                    })
                    .unwrap_or(false);

                if !ttyd_alive {
                    tracing::info!(
                        session_id = %sid,
                        error = %err,
                        "ttyd process is dead, not reconnecting owner"
                    );
                    return Ok(());
                }

                attempt = attempt.saturating_add(1);
                if attempt > TTYD_OWNER_RECONNECT_MAX_ATTEMPTS {
                    tracing::warn!(
                        session_id = %sid,
                        attempts = attempt,
                        "ttyd session owner exceeded max reconnect attempts, giving up"
                    );
                    // Notify all connected frontend clients that the terminal backend
                    // has failed, instead of silently dying and leaving a frozen terminal.
                    state.emit_terminal_stream_event(
                        sid,
                        crate::state::types::TerminalStreamEvent::Error(
                            "Terminal backend exhausted all reconnection attempts. The session may need to be restarted.".to_string()
                        ),
                    ).await;
                    // Detach the terminal runtime so a subsequent restore_ttyd_runtime()
                    // can create a fresh owner instead of finding a stale attachment.
                    state.detach_terminal_runtime(sid).await;
                    return Ok(());
                }
                let delay = owner_reconnect_delay(attempt);
                tracing::info!(
                    session_id = %sid,
                    error = %err,
                    attempt,
                    delay_ms = delay.as_millis() as u64,
                    "ttyd session owner reconnecting"
                );
                tokio::time::sleep(delay).await;

                // Detach the old runtime first so the kill channel is properly closed.
                // This ensures the old process monitor exits before we create new channels.
                if let Some(handle) = state.terminal_hosts.get(sid).await {
                    state.terminal_hosts.detach_runtime(&handle).await;
                }

                // Create fresh channels for the reconnection.
                let (output_tx, output_rx) = tokio::sync::mpsc::channel::<ExecutorOutput>(8192);
                let (input_tx, input_rx) = tokio::sync::mpsc::channel::<ExecutorInput>(64);
                let (resize_tx, resize_rx) = tokio::sync::mpsc::channel::<PtyDimensions>(8);
                let (kill_tx, _kill_rx) = tokio::sync::oneshot::channel::<()>();
                state
                    .attach_terminal_runtime(sid, input_tx, Some(resize_tx), kill_tx)
                    .await;

                // Start consuming output from the new channel.
                if let Some(session) = state.get_session(sid).await {
                    let executors = state.executors.read().await;
                    if let Some(exec) = executors
                        .get(&conductor_core::types::AgentKind::parse(&session.agent))
                        .cloned()
                    {
                        drop(executors);
                        state.start_output_consumer(
                            sid.to_string(),
                            exec,
                            output_rx,
                            crate::state::OutputConsumerConfig {
                                terminal_rx: None,
                                mirror_terminal_output: false,
                                output_is_parsed: false,
                                timeout: None,
                            },
                        );
                    }
                }

                channels = TtydSessionOwnerChannels {
                    output_tx,
                    input_rx,
                    resize_rx,
                    ready_tx: None, // Only report readiness on first attempt
                };
            }
        }
    }
}

/// Own the single upstream ttyd websocket session used by Conductor.
async fn run_ttyd_session_owner(
    state: &Arc<AppState>,
    sid: &str,
    url: &str,
    _executor: Arc<dyn Executor>,
    mut channels: TtydSessionOwnerChannels,
    session_start: tokio::time::Instant,
) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    let connect_deadline = tokio::time::Instant::now() + TTYD_OWNER_ATTACH_TIMEOUT;
    let (ws, _) = loop {
        let request = ttyd_protocol::connect_request(url).context("mirror request")?;
        match tokio_tungstenite::connect_async(request).await {
            Ok(connection) => {
                tracing::info!(session_id = %sid, "ttyd session owner connected to ttyd");
                break connection;
            }
            Err(err) => {
                if tokio::time::Instant::now() >= connect_deadline {
                    let error = anyhow!(err).context("ttyd session owner connect");
                    if let Some(tx) = channels.ready_tx.take() {
                        let _ = tx.send(Err(anyhow!(error.to_string())));
                    }
                    return Err(error);
                }
                tokio::time::sleep(TTYD_OWNER_CONNECT_RETRY_DELAY).await;
            }
        }
    };
    let (mut w, mut r) = ws.split();
    // Use the last-known terminal dimensions from the state store instead of
    // hardcoded 160x48. This prevents a jarring resize flash on reconnect.
    let (init_cols, init_rows) = state
        .terminal_hosts
        .get(sid)
        .await
        .and_then(|handle| {
            handle
                .terminal_store
                .lock()
                .ok()
                .map(|store| store.dimensions())
        })
        .unwrap_or((160, 48));
    if let Err(err) = w
        .send(WsMessage::Binary(
            ttyd_protocol::encode_handshake(init_cols, init_rows).into(),
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

    // Batch terminal output lines before sending to the output consumer.
    // Draining line-by-line from ttyd generates many small sends under heavy
    // output (e.g. cargo build). Batching amortises channel send overhead
    // and reduces wakeups in the output consumer task.
    let mut output_batch: Vec<ExecutorOutput> = Vec::with_capacity(64);
    let mut batch_flush_interval = tokio::time::interval(std::time::Duration::from_millis(16));
    batch_flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut batch_dirty = false;
    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            biased;
            message = r.next() => match message {
                Some(Ok(WsMessage::Ping(payload))) => {
                    tracing::debug!(session_id = %sid, "ttyd session owner received ping");
                    w.send(WsMessage::Pong(payload))
                        .await
                        .context("ttyd session owner pong send failed")?;
                    tracing::debug!(session_id = %sid, "ttyd session owner sent pong");
                    last_activity = tokio::time::Instant::now();
                }
                Some(Ok(WsMessage::Binary(data))) if data.len() > 1 && data[0] == ttyd_protocol::CMD_OUTPUT => {
                    last_activity = tokio::time::Instant::now();
                    let payload = &data[1..];
                    state.emit_terminal_bytes(sid, payload).await;
                    match std::str::from_utf8(payload) {
                        Ok(s) => buf.push_str(s),
                        Err(_) => buf.push_str(&String::from_utf8_lossy(payload)),
                    }
                    while let Some(nl) = buf.find('\n') {
                        let line = buf[..nl].to_string();
                        buf = buf[nl + 1..].to_string();
                        if !line.trim().is_empty() {
                            output_batch.push(ExecutorOutput::Stdout(line));
                            batch_dirty = true;
                        }
                    }
                    // Flush immediately when batch is large to avoid memory pressure.
                    if output_batch.len() >= 64 {
                        for output in output_batch.drain(..) {
                            if channels.output_tx.send(output).await.is_err() {
                                return Ok(());
                            }
                        }
                        batch_dirty = false;
                    }
                }
                Some(Ok(WsMessage::Binary(_))) | Some(Ok(WsMessage::Text(_))) | Some(Ok(WsMessage::Pong(_))) | Some(Ok(WsMessage::Frame(_))) => {
                    last_activity = tokio::time::Instant::now();
                }
                Some(Ok(WsMessage::Close(_))) | None => break,
                Some(Err(err)) => return Err(err.into()),
            },
            _ = tokio::time::sleep_until(last_activity + TTYD_OWNER_SILENCE_TIMEOUT) => {
                tracing::warn!(
                    session_id = %sid,
                    silence_secs = TTYD_OWNER_SILENCE_TIMEOUT.as_secs(),
                    "ttyd session owner detected prolonged silence (no pings or data), connection likely dead"
                );
                return Err(anyhow!("ttyd session owner silence timeout"));
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
            _ = batch_flush_interval.tick(), if batch_dirty => {
                for output in output_batch.drain(..) {
                    if channels.output_tx.send(output).await.is_err() {
                        return Ok(());
                    }
                }
                batch_dirty = false;
            },
        }
        // Session duration check after each select iteration.
        if session_start.elapsed() >= TTYD_MAX_SESSION_DURATION {
            tracing::warn!(
                session_id = %sid,
                duration_secs = session_start.elapsed().as_secs(),
                max_duration_secs = TTYD_MAX_SESSION_DURATION.as_secs(),
                "session exceeded maximum duration during active connection"
            );
            return Err(SessionExceededMaxDurationError {
                max_duration_secs: TTYD_MAX_SESSION_DURATION.as_secs(),
            }
            .into());
        }
    }
    // Flush any remaining batched output before disconnecting.
    for output in output_batch.drain(..) {
        let _ = channels.output_tx.send(output).await;
    }
    // Send trailing partial line after the batch is fully drained.
    if !buf.trim().is_empty() {
        let _ = channels.output_tx.send(ExecutorOutput::Stdout(buf)).await;
    }
    Err(anyhow!("ttyd session owner disconnected"))
}

fn session_exceeded_max_duration(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<SessionExceededMaxDurationError>()
            .is_some()
    })
}

fn owner_reconnect_delay(attempt: u32) -> std::time::Duration {
    let multiplier = u32::max(attempt, 1);
    let delay = TTYD_OWNER_RECONNECT_BASE_DELAY.saturating_mul(multiplier);
    std::cmp::min(delay, TTYD_OWNER_RECONNECT_MAX_DELAY)
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
    use super::{
        build_agent_launch_command, build_ttyd_shell_args, owner_reconnect_delay,
        reserve_ttyd_port, resolve_interactive_shell,
    };
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

    #[test]
    fn reserve_ttyd_port_releases_port_before_returning() {
        let port = reserve_ttyd_port().expect("port reservation should succeed");
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port))
            .expect("reserved port should be reusable immediately");
        drop(rebound);
    }

    #[test]
    fn owner_reconnect_delay_caps_instead_of_exhausting() {
        assert_eq!(
            owner_reconnect_delay(0),
            std::time::Duration::from_millis(500)
        );
        assert_eq!(
            owner_reconnect_delay(1),
            std::time::Duration::from_millis(500)
        );
        assert_eq!(owner_reconnect_delay(4), std::time::Duration::from_secs(2));
        assert_eq!(
            owner_reconnect_delay(100),
            std::time::Duration::from_secs(5)
        );
    }
}
