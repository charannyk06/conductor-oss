//! Launch real ttyd binary per session for reliable terminal streaming.
//!
//! Instead of our custom PTY host + Unix socket + stream forwarder stack,
//! this module spawns the battle-tested ttyd binary which handles PTY
//! creation and WebSocket serving natively. The browser connects directly
//! to the ttyd WebSocket — zero intermediate layers.
//!
//! Architecture:
//!   Browser  <-->  ttyd (WebSocket)  <-->  PTY  <-->  agent process
//!   Backend "mirror" client  <-->  ttyd (WebSocket)  -->  session output tracking
//!   Backend "input" client   <-->  ttyd (WebSocket)  -->  API input forwarding

use anyhow::{anyhow, Context, Result};
use conductor_executors::executor::{Executor, ExecutorHandle, ExecutorInput, ExecutorOutput};
use conductor_executors::process::PtyDimensions;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::helpers::prepare_detached_runtime_env;
use super::types::{
    RUNTIME_MODE_METADATA_KEY, TTYD_PID_METADATA_KEY, TTYD_PORT_METADATA_KEY, TTYD_RUNTIME_MODE,
    TTYD_WS_URL_METADATA_KEY,
};
use super::RuntimeLaunch;
use crate::state::AppState;
use conductor_executors::executor::SpawnOptions;

/// How long to wait for ttyd to report its listening port.
const TTYD_STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Backoff interval for mirror reconnection
const TTYD_MIRROR_RECONNECT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
/// Initial delay before first mirror connection
const TTYD_MIRROR_INITIAL_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

/// Check if ttyd binary is available and should be used.
pub fn ttyd_available() -> bool {
    if std::env::var("CONDUCTOR_DISABLE_TTYD").is_ok() {
        return false;
    }
    if cfg!(test) {
        return false;
    }
    which::which("ttyd").is_ok()
}

/// Spawn a session through real ttyd binary for native WebSocket terminal streaming.
pub async fn spawn_ttyd_runtime(
    state: &Arc<AppState>,
    executor: Arc<dyn Executor>,
    session_id: &str,
    mut options: SpawnOptions,
) -> Result<RuntimeLaunch> {
    options.interactive = executor.supports_direct_terminal_ui();
    options.structured_output = false;
    prepare_detached_runtime_env(executor.kind(), options.interactive, &mut options.env);

    let binary = executor.binary_path().to_path_buf();
    let args = executor.build_args(&options);

    let mut cmd = tokio::process::Command::new("ttyd");
    cmd.arg("-p")
        .arg("0")
        .arg("-W")
        .arg("-w")
        .arg(&options.cwd)
        .arg("-t")
        .arg("disableReconnect=true")
        .arg("-t")
        .arg("enableSixel=true")
        .arg("--ping-interval")
        .arg("30")
        .arg(&binary);
    for arg in &args {
        cmd.arg(arg);
    }
    for (key, value) in &options.env {
        cmd.env(key, value);
    }
    cmd.current_dir(&options.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
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
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("No ttyd stderr"))?;
    let port = parse_ttyd_port(stderr).await?;
    let ttyd_ws_url = format!("ws://127.0.0.1:{port}/ws");
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

    // Mirror client: connect to ttyd WebSocket and emit terminal bytes
    let st2 = state.clone();
    let sid2 = session_id.to_string();
    let url2 = ttyd_ws_url.clone();
    let otx2 = output_tx;
    tokio::spawn(async move {
        mirror_retry(&st2, &sid2, &url2, otx2).await;
    });

    // Input forwarder: relay user input to ttyd
    let url3 = ttyd_ws_url.clone();
    tokio::spawn(async move {
        input_fwd(&url3, input_rx, resize_rx).await;
    });

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
            ("detachedPid".to_string(), ttyd_pid.to_string()),
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

    // Mirror client
    let st2 = state.clone();
    let sid2 = session_id.to_string();
    let url2 = ws_url.clone();
    let otx2 = output_tx;
    tokio::spawn(async move {
        mirror_retry(&st2, &sid2, &url2, otx2).await;
    });

    // Input forwarder
    let url3 = ws_url;
    tokio::spawn(async move {
        input_fwd(&url3, input_rx, resize_rx).await;
    });

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

/// Parse ttyd's listening port from stderr.
async fn parse_ttyd_port(stderr: tokio::process::ChildStderr) -> Result<u16> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stderr).lines();
    tokio::time::timeout(TTYD_STARTUP_TIMEOUT, async {
        while let Some(line) = lines.next_line().await? {
            tracing::debug!(ttyd_stderr = %line);
            if let Some(p) = line
                .strip_prefix("Listening on port: ")
                .or_else(|| line.find("Listening on port: ").map(|i| &line[i + 19..]))
            {
                return Ok(p.trim().parse::<u16>().context("bad port")?);
            }
        }
        Err(anyhow!("ttyd exited without port"))
    })
    .await
    .map_err(|_| anyhow!("ttyd startup timeout"))?
}

/// Retry loop for mirror client connection.
async fn mirror_retry(
    state: &Arc<AppState>,
    sid: &str,
    url: &str,
    tx: mpsc::Sender<ExecutorOutput>,
) {
    tokio::time::sleep(TTYD_MIRROR_INITIAL_DELAY).await;
    loop {
        if tx.is_closed() {
            break;
        }
        match mirror_once(state, sid, url, &tx).await {
            Ok(()) => break,
            Err(_) if tx.is_closed() => break,
            Err(e) => {
                tracing::debug!(sid, error = %e, "mirror retry");
                tokio::time::sleep(TTYD_MIRROR_RECONNECT_INTERVAL).await;
            }
        }
    }
}

/// Single mirror connection to ttyd WebSocket for output capture.
async fn mirror_once(
    state: &Arc<AppState>,
    sid: &str,
    url: &str,
    tx: &mpsc::Sender<ExecutorOutput>,
) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .context("mirror connect")?;
    let (mut w, mut r) = ws.split();
    let handshake = serde_json::json!({"AuthToken":"","columns":120,"rows":40}).to_string();
    w.send(WsMessage::Text(handshake.into()))
        .await?;
    let mut buf = String::new();
    while let Some(msg) = r.next().await {
        let msg = msg?;
        if let WsMessage::Binary(data) = msg {
            if data.len() > 1 && data[0] == 0x30 {
                state.emit_terminal_bytes(sid, &data[1..]).await;
                buf.push_str(&String::from_utf8_lossy(&data[1..]));
                while let Some(nl) = buf.find('\n') {
                    let line = buf[..nl].to_string();
                    buf = buf[nl + 1..].to_string();
                    if !line.trim().is_empty() {
                        if tx.send(ExecutorOutput::Stdout(line)).await.is_err() {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    if !buf.trim().is_empty() {
        let _ = tx.send(ExecutorOutput::Stdout(buf)).await;
    }
    Ok(())
}

/// Input forwarder: relay user input and terminal resizes to ttyd.
async fn input_fwd(
    url: &str,
    mut irx: mpsc::Receiver<ExecutorInput>,
    mut rrx: mpsc::Receiver<PtyDimensions>,
) {
    use futures_util::{SinkExt, StreamExt};
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let ws = match tokio_tungstenite::connect_async(url).await {
        Ok((w, _)) => w,
        Err(_) => return,
    };
    let (mut w, _) = ws.split();
    let handshake = serde_json::json!({"AuthToken":"","columns":120,"rows":40}).to_string();
    if w.send(WsMessage::Text(handshake.into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            biased;
            i = irx.recv() => match i {
                Some(ei) => {
                    let t = match ei {
                        ExecutorInput::Raw(s) | ExecutorInput::Text(s) => s,
                    };
                    let mut f = vec![0x30u8];
                    f.extend_from_slice(t.as_bytes());
                    if w
                        .send(WsMessage::Binary(f.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                None => break,
            },
            r = rrx.recv() => match r {
                Some(d) => {
                    let j = serde_json::json!({"columns":d.cols,"rows":d.rows});
                    let mut f = vec![0x31u8];
                    f.extend_from_slice(j.to_string().as_bytes());
                    if w
                        .send(WsMessage::Binary(f.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                None => break,
            },
        }
    }
    let _ = w.close().await;
}

