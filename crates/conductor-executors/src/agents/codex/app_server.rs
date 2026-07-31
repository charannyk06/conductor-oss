//! Structured Codex transport backed by `codex app-server --stdio`.
//!
//! App-server exposes byte-exact assistant deltas and stable item lifecycle IDs,
//! which the legacy `codex exec --json` stream does not consistently provide.
//! This module stays behind the Codex executor boundary so callers can probe
//! support and fall back to the legacy transport without changing the executor
//! trait surface.

use anyhow::{anyhow, Context, Result};
use conductor_core::types::AgentKind;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};

use crate::executor::{ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions};

const INITIALIZE_REQUEST_ID: u64 = 1;
const THREAD_REQUEST_ID: u64 = 2;
const TURN_REQUEST_ID: u64 = 3;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const SUPPORT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PRE_TURN_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

static SUPPORT_CACHE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();

/// Return whether this Codex binary exposes the stdio app-server transport.
///
/// Results are cached per binary path because probing on every dispatcher turn
/// would add visible process startup latency.
pub async fn is_supported(binary: &Path) -> bool {
    let key = binary.to_path_buf();
    if let Some(supported) = support_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).copied())
    {
        return supported;
    }

    let mut command = Command::new(binary);
    command
        .args(["app-server", "--help"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let supported = match tokio::time::timeout(SUPPORT_PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).contains("--stdio")
        }
        _ => false,
    };

    if supported {
        if let Ok(mut cache) = support_cache().lock() {
            cache.insert(key, true);
        }
    }
    supported
}

/// Spawn one structured Codex turn over app-server JSON-RPC.
///
/// `clean_env` must already contain the caller's isolated Codex home and the
/// small allow-list of environment variables that Codex needs. The child starts
/// from an empty environment so unrelated parent credentials/config do not leak
/// back into the headless runtime.
pub async fn spawn(
    binary: &Path,
    options: SpawnOptions,
    clean_env: HashMap<String, String>,
) -> Result<ExecutorHandle> {
    let args = app_server_args(&options);
    let mut command = Command::new(binary);
    command
        .args(&args)
        .current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .kill_on_drop(true);

    for (key, value) in &clean_env {
        if !value.is_empty() {
            command.env(key, value);
        }
    }

    // Put the app-server and any descendants it starts in a dedicated process
    // group. External cancellation can then terminate the whole tree.
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if nix::libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn Codex app-server at {}", binary.display()))?;
    let pid = child.id().unwrap_or(0);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Codex app-server stdin was not piped"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Codex app-server stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Codex app-server stderr was not piped"))?;

    let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
    let (input_tx, input_rx) = mpsc::channel::<ExecutorInput>(8);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let (handshake_tx, handshake_rx) = oneshot::channel::<std::result::Result<(), String>>();

    let handshake_timeout = options
        .timeout
        .map(|timeout| timeout.min(PRE_TURN_HANDSHAKE_TIMEOUT))
        .unwrap_or(PRE_TURN_HANDSHAKE_TIMEOUT);

    tokio::spawn(run_app_server(
        AppServerProcess {
            child,
            stdin,
            stdout,
            stderr,
        },
        options,
        output_tx,
        input_rx,
        kill_rx,
        Some(handshake_tx),
    ));
    match tokio::time::timeout(handshake_timeout, handshake_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            let _ = kill_tx.send(());
            return Err(anyhow!(
                "Codex app-server pre-turn handshake failed: {error}"
            ));
        }
        Ok(Err(_)) => {
            let _ = kill_tx.send(());
            return Err(anyhow!(
                "Codex app-server exited before the pre-turn handshake completed"
            ));
        }
        Err(_) => {
            let _ = kill_tx.send(());
            return Err(anyhow!(
                "Codex app-server pre-turn handshake timed out after {}s",
                handshake_timeout.as_secs_f32()
            ));
        }
    }

    Ok(ExecutorHandle::new(
        pid,
        AgentKind::Codex,
        output_rx,
        input_tx,
        kill_tx,
    ))
}

fn support_cache() -> &'static Mutex<HashMap<PathBuf, bool>> {
    SUPPORT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_server_args(options: &SpawnOptions) -> Vec<String> {
    let mut args = vec!["app-server".to_string(), "--stdio".to_string()];
    let extra_args = options.sanitized_extra_args();
    let mut index = 0;

    // App-server does not understand exec/TUI flags, but Codex configuration
    // overrides remain valid and are important for project-specific routing.
    while index < extra_args.len() {
        let arg = &extra_args[index];
        if matches!(arg.as_str(), "-c" | "--config") {
            if let Some(value) = extra_args.get(index + 1) {
                args.push(arg.clone());
                args.push(value.clone());
                index += 2;
                continue;
            }
        } else if arg.starts_with("--config=") || (arg.starts_with("-c") && arg.len() > 2) {
            args.push(arg.clone());
        }
        index += 1;
    }

    args
}

fn normalize_reasoning_effort(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    let normalized = match normalized.as_str() {
        "minimal" | "min" | "low" => "low",
        "medium" | "med" => "medium",
        "high" => "high",
        "max" | "xhigh" | "extra-high" | "extra_high" | "extra high" => "xhigh",
        "ultra" => "ultra",
        _ => return None,
    };
    Some(normalized.to_string())
}

struct ProtocolState {
    options: SpawnOptions,
    thread_id: Option<String>,
    terminal_emitted: bool,
    delta_message_ids: HashSet<String>,
    anonymous_agent_message_delta_received: bool,
}

struct AppServerProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
}

impl ProtocolState {
    fn new(options: SpawnOptions) -> Self {
        Self {
            options,
            thread_id: None,
            terminal_emitted: false,
            delta_message_ids: HashSet::new(),
            anonymous_agent_message_delta_received: false,
        }
    }

    fn approval_policy(&self) -> &'static str {
        if self.options.skip_permissions {
            "never"
        } else {
            "on-request"
        }
    }

    fn sandbox(&self) -> &'static str {
        if self.options.skip_permissions {
            "danger-full-access"
        } else {
            "workspace-write"
        }
    }

    fn thread_request(&self) -> Value {
        let cwd = self.options.cwd.to_string_lossy();
        let model = normalized_nonempty(self.options.model.as_deref());
        if let Some(resume_target) = normalized_nonempty(self.options.resume_target.as_deref()) {
            json!({
                "id": THREAD_REQUEST_ID,
                "method": "thread/resume",
                "params": {
                    "threadId": resume_target,
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": self.approval_policy(),
                    "sandbox": self.sandbox(),
                },
            })
        } else {
            json!({
                "id": THREAD_REQUEST_ID,
                "method": "thread/start",
                "params": {
                    "cwd": cwd,
                    "model": model,
                    "approvalPolicy": self.approval_policy(),
                    "sandbox": self.sandbox(),
                    "ephemeral": false,
                    "environments": [],
                    "dynamicTools": [],
                },
            })
        }
    }

    fn turn_request(&self, thread_id: &str) -> Value {
        json!({
            "id": TURN_REQUEST_ID,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{
                    "type": "text",
                    "text": self.options.prompt,
                }],
                "cwd": self.options.cwd.to_string_lossy(),
                "model": normalized_nonempty(self.options.model.as_deref()),
                "effort": normalize_reasoning_effort(self.options.reasoning_effort.as_deref()),
                "approvalPolicy": self.approval_policy(),
            },
        })
    }
}

fn normalized_nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

async fn run_app_server(
    process: AppServerProcess,
    options: SpawnOptions,
    output_tx: mpsc::Sender<ExecutorOutput>,
    mut input_rx: mpsc::Receiver<ExecutorInput>,
    mut kill_rx: oneshot::Receiver<()>,
    mut handshake_tx: Option<oneshot::Sender<std::result::Result<(), String>>>,
) {
    let AppServerProcess {
        mut child,
        stdin,
        stdout,
        stderr,
    } = process;
    let pid = child.id().unwrap_or(0);
    let timeout_at = options.timeout.map(|duration| Instant::now() + duration);
    let mut state = ProtocolState::new(options);
    let mut stdin = Some(stdin);
    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut input_open = true;
    let mut kill_open = true;
    let mut shutdown_at = None;
    let mut poll = tokio::time::interval(Duration::from_millis(25));
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);

    if let Err(error) = write_message(
        &mut stdin,
        &json!({
            "id": INITIALIZE_REQUEST_ID,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "conductor-oss",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            },
        }),
    )
    .await
    {
        signal_handshake_failure(&mut handshake_tx, error.to_string());
        emit_failed(&output_tx, &mut state, error.to_string(), None).await;
        terminate_process_tree(&mut child, pid).await;
        return;
    }

    loop {
        tokio::select! {
            line = stdout_lines.next_line(), if stdout_open => {
                match line {
                    Ok(Some(line)) => {
                        let message = match serde_json::from_str::<Value>(&line) {
                            Ok(message) => message,
                            Err(error) => {
                                signal_handshake_failure(
                                    &mut handshake_tx,
                                    format!("invalid JSON from Codex app-server: {error}"),
                                );
                                emit_failed(
                                    &output_tx,
                                    &mut state,
                                    format!("invalid JSON from Codex app-server: {error}"),
                                    None,
                                ).await;
                                close_stdin(&mut stdin).await;
                                terminate_process_tree(&mut child, pid).await;
                                break;
                            }
                        };

                        match handle_message(
                            &mut state,
                            &mut stdin,
                            &output_tx,
                            &mut handshake_tx,
                            message,
                        )
                        .await
                        {
                            Ok(MessageAction::Continue) => {}
                            Ok(MessageAction::TurnFinished) => {
                                close_stdin(&mut stdin).await;
                                shutdown_at = Some(Instant::now() + SHUTDOWN_GRACE);
                            }
                            Err(error) => {
                                signal_handshake_failure(&mut handshake_tx, error.to_string());
                                emit_failed(&output_tx, &mut state, error.to_string(), None).await;
                                close_stdin(&mut stdin).await;
                                terminate_process_tree(&mut child, pid).await;
                                break;
                            }
                        }
                    }
                    Ok(None) => stdout_open = false,
                    Err(error) => {
                        signal_handshake_failure(
                            &mut handshake_tx,
                            format!("failed reading Codex app-server stdout: {error}"),
                        );
                        emit_failed(
                            &output_tx,
                            &mut state,
                            format!("failed reading Codex app-server stdout: {error}"),
                            None,
                        ).await;
                        close_stdin(&mut stdin).await;
                        terminate_process_tree(&mut child, pid).await;
                        break;
                    }
                }
            }
            line = stderr_lines.next_line(), if stderr_open => {
                match line {
                    Ok(Some(line)) if !line.trim().is_empty() => {
                        let _ = output_tx.send(ExecutorOutput::Stderr(line)).await;
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => stderr_open = false,
                    Err(_) => stderr_open = false,
                }
            }
            input = input_rx.recv(), if input_open => {
                match input {
                    Some(ExecutorInput::Text(text)) | Some(ExecutorInput::Raw(text)) => {
                        if !text.is_empty() {
                            let _ = output_tx.send(ExecutorOutput::Stderr(
                                "[conductor] Codex app-server turns are single-prompt sessions; additional input was ignored".to_string()
                            )).await;
                        }
                    }
                    None => input_open = false,
                }
            }
            signal = &mut kill_rx, if kill_open => {
                match signal {
                    Ok(()) => {
                        signal_handshake_failure(
                            &mut handshake_tx,
                            "Codex app-server was killed before the pre-turn handshake completed"
                                .to_string(),
                        );
                        close_stdin(&mut stdin).await;
                        terminate_process_tree(&mut child, pid).await;
                        emit_failed(
                            &output_tx,
                            &mut state,
                            "killed".to_string(),
                            Some(-15),
                        ).await;
                        break;
                    }
                    Err(_) => kill_open = false,
                }
            }
            _ = wait_until(timeout_at), if timeout_at.is_some() && !state.terminal_emitted => {
                signal_handshake_failure(
                    &mut handshake_tx,
                    "Codex app-server turn timed out before the pre-turn handshake completed"
                        .to_string(),
                );
                close_stdin(&mut stdin).await;
                terminate_process_tree(&mut child, pid).await;
                emit_failed(
                    &output_tx,
                    &mut state,
                    "Codex app-server turn timed out".to_string(),
                    None,
                ).await;
                break;
            }
            _ = wait_until(shutdown_at), if shutdown_at.is_some() => {
                terminate_process_tree(&mut child, pid).await;
                break;
            }
            _ = poll.tick() => {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if !state.terminal_emitted {
                            signal_handshake_failure(
                                &mut handshake_tx,
                                "Codex app-server exited before the pre-turn handshake completed"
                                    .to_string(),
                            );
                            let code = status.code();
                            emit_failed(
                                &output_tx,
                                &mut state,
                                "Codex app-server exited before turn/completed".to_string(),
                                code,
                            ).await;
                        }
                        terminate_process_tree(&mut child, pid).await;
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        signal_handshake_failure(
                            &mut handshake_tx,
                            format!("failed to poll Codex app-server: {error}"),
                        );
                        emit_failed(
                            &output_tx,
                            &mut state,
                            format!("failed to poll Codex app-server: {error}"),
                            None,
                        ).await;
                        break;
                    }
                }
            }
        }
    }
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}

enum MessageAction {
    Continue,
    TurnFinished,
}

async fn handle_message(
    state: &mut ProtocolState,
    stdin: &mut Option<ChildStdin>,
    output_tx: &mpsc::Sender<ExecutorOutput>,
    handshake_tx: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    message: Value,
) -> Result<MessageAction> {
    // App-server requests (approval, elicitation, dynamic tool calls) carry
    // both a method and an id. Conductor does not yet have a response bridge
    // for them, so fail closed instead of leaving Codex hanging forever.
    if let (Some(method), Some(request_id)) = (
        message.get("method").and_then(Value::as_str),
        message.get("id"),
    ) {
        write_message(
            stdin,
            &json!({
                "id": request_id,
                "error": {
                    "code": -32000,
                    "message": format!("Conductor cannot answer app-server request {method}"),
                },
            }),
        )
        .await?;
        return Err(anyhow!("Codex requested unsupported interaction: {method}"));
    }

    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(error) = message.get("error") {
            return Err(anyhow!(
                "Codex app-server request {id} failed: {}",
                compact_json(error)
            ));
        }

        match id {
            INITIALIZE_REQUEST_ID => {
                require_result(&message, id)?;
                write_message(stdin, &json!({ "method": "initialized" })).await?;
                write_message(stdin, &state.thread_request()).await?;
            }
            THREAD_REQUEST_ID => {
                let result = require_result(&message, id)?;
                let thread_id = result
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| anyhow!("Codex app-server thread response omitted thread.id"))?
                    .to_string();
                state.thread_id = Some(thread_id.clone());
                output_tx
                    .send(thread_started_output(&thread_id))
                    .await
                    .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
                write_message(stdin, &state.turn_request(&thread_id)).await?;
            }
            TURN_REQUEST_ID => {
                require_result(&message, id)?;
                signal_handshake_success(handshake_tx);
            }
            _ => {}
        }
        return Ok(MessageAction::Continue);
    }

    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Ok(MessageAction::Continue);
    };

    match method {
        "item/agentMessage/delta" => {
            if let Some(delta) = message
                .get("params")
                .and_then(|params| params.get("delta"))
                .and_then(Value::as_str)
                .filter(|delta| !delta.is_empty())
            {
                if let Some(item_id) = message
                    .get("params")
                    .and_then(|params| params.get("itemId"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    state.delta_message_ids.insert(item_id.to_string());
                } else {
                    state.anonymous_agent_message_delta_received = true;
                }
                output_tx
                    .send(ExecutorOutput::AssistantDelta(delta.to_string()))
                    .await
                    .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
            }
        }
        "item/started" => {
            if let Some(output) = item_lifecycle_output(&message, false) {
                output_tx
                    .send(output)
                    .await
                    .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
            }
        }
        "item/completed" => {
            if let Some(item) = message.get("params").and_then(|params| params.get("item")) {
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    let saw_deltas = item
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .is_some_and(|item_id| state.delta_message_ids.remove(item_id))
                        || std::mem::take(&mut state.anonymous_agent_message_delta_received);
                    if saw_deltas {
                        return Ok(MessageAction::Continue);
                    }
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            output_tx
                                .send(ExecutorOutput::Stdout(text.to_string()))
                                .await
                                .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
                        }
                    }
                } else if let Some(output) = item_lifecycle_output(&message, true) {
                    output_tx
                        .send(output)
                        .await
                        .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
                }
            }
        }
        "turn/completed" => {
            if state.terminal_emitted {
                return Ok(MessageAction::TurnFinished);
            }
            let turn = message
                .get("params")
                .and_then(|params| params.get("turn"))
                .ok_or_else(|| anyhow!("Codex turn/completed omitted turn"))?;
            let status = turn
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            if status == "completed" {
                output_tx
                    .send(ExecutorOutput::Completed { exit_code: 0 })
                    .await
                    .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
            } else {
                let error = turn
                    .get("error")
                    .and_then(extract_error_message)
                    .unwrap_or_else(|| format!("Codex turn ended with status {status}"));
                output_tx
                    .send(ExecutorOutput::Failed {
                        error,
                        exit_code: Some(1),
                    })
                    .await
                    .map_err(|_| anyhow!("Codex app-server output receiver closed"))?;
            }
            state.terminal_emitted = true;
            return Ok(MessageAction::TurnFinished);
        }
        "error" => {
            let error = message
                .get("params")
                .and_then(extract_error_message)
                .unwrap_or_else(|| "Codex app-server reported an error".to_string());
            return Err(anyhow!(error));
        }
        _ => {}
    }

    Ok(MessageAction::Continue)
}

fn signal_handshake_success(
    handshake_tx: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
) {
    if let Some(handshake_tx) = handshake_tx.take() {
        let _ = handshake_tx.send(Ok(()));
    }
}

fn signal_handshake_failure(
    handshake_tx: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    error: String,
) {
    if let Some(handshake_tx) = handshake_tx.take() {
        let _ = handshake_tx.send(Err(error));
    }
}

fn require_result(message: &Value, id: u64) -> Result<&Value> {
    message
        .get("result")
        .ok_or_else(|| anyhow!("Codex app-server response {id} omitted result"))
}

fn thread_started_output(thread_id: &str) -> ExecutorOutput {
    let mut metadata = HashMap::new();
    metadata.insert(
        "eventKind".to_string(),
        Value::String("thread_started".to_string()),
    );
    metadata.insert(
        "codexThreadId".to_string(),
        Value::String(thread_id.to_string()),
    );
    ExecutorOutput::StructuredStatus {
        text: String::new(),
        metadata,
    }
}

fn item_lifecycle_output(message: &Value, completed: bool) -> Option<ExecutorOutput> {
    let item = message.get("params")?.get("item")?;
    let item_type = item.get("type")?.as_str()?;
    if matches!(
        item_type,
        "userMessage"
            | "agentMessage"
            | "hookPrompt"
            | "plan"
            | "enteredReviewMode"
            | "exitedReviewMode"
    ) {
        return None;
    }
    let item_id = item.get("id")?.as_str()?.trim();
    if item_id.is_empty() {
        return None;
    }

    let (kind, title) = tool_identity(item_type, item);
    let status = if completed {
        completed_tool_status(item)
    } else {
        "running"
    };
    let mut metadata = tool_metadata(&kind, &title, status, tool_content(item));
    metadata.insert(
        "eventKind".to_string(),
        Value::String("tool_lifecycle".to_string()),
    );
    metadata.insert("itemId".to_string(), Value::String(item_id.to_string()));
    metadata.insert("toolCallId".to_string(), Value::String(item_id.to_string()));

    Some(ExecutorOutput::StructuredStatus {
        text: title,
        metadata,
    })
}

fn tool_identity(item_type: &str, item: &Value) -> (String, String) {
    match item_type {
        "reasoning" => ("thinking".to_string(), "Thinking".to_string()),
        "commandExecution" => ("command".to_string(), "Command".to_string()),
        "fileChange" => ("edit".to_string(), "Edit files".to_string()),
        "mcpToolCall" | "dynamicToolCall" => {
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("tool");
            (normalize_tool_kind(tool), humanize(tool))
        }
        "collabAgentToolCall" | "subAgentActivity" => {
            ("task".to_string(), "Agent task".to_string())
        }
        "webSearch" => ("websearch".to_string(), "Web search".to_string()),
        "imageView" => ("image".to_string(), "View image".to_string()),
        "imageGeneration" => ("image".to_string(), "Generate image".to_string()),
        "sleep" => ("wait".to_string(), "Waiting".to_string()),
        "contextCompaction" => ("compaction".to_string(), "Compacting".to_string()),
        other => (normalize_tool_kind(other), humanize(other)),
    }
}

fn completed_tool_status(item: &Value) -> &'static str {
    match item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed")
        .to_ascii_lowercase()
        .as_str()
    {
        "failed" | "error" | "declined" | "cancelled" | "canceled" => "failed",
        _ => "completed",
    }
}

fn tool_content(item: &Value) -> Vec<String> {
    let mut content = Vec::new();
    for key in [
        "command",
        "cwd",
        "query",
        "path",
        "prompt",
        "aggregatedOutput",
        "error",
        "result",
        "arguments",
        "changes",
        "summary",
        "content",
    ] {
        let Some(value) = item.get(key) else {
            continue;
        };
        if let Some(summary) = summarize_value(value) {
            content.push(if matches!(key, "command" | "query" | "path" | "prompt") {
                summary
            } else {
                format!("{}: {summary}", humanize(key))
            });
        }
        if content.len() == 4 {
            break;
        }
    }
    content
}

fn summarize_value(value: &Value) -> Option<String> {
    let raw = match value {
        Value::Null => return None,
        Value::String(text) => text.to_string(),
        other => serde_json::to_string(other).ok()?,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "[]" || trimmed == "{}" {
        return None;
    }
    const MAX_CHARS: usize = 2_000;
    if trimmed.chars().count() <= MAX_CHARS {
        Some(trimmed.to_string())
    } else {
        Some(format!(
            "{}…",
            trimmed.chars().take(MAX_CHARS).collect::<String>()
        ))
    }
}

fn tool_metadata(
    tool_kind: &str,
    tool_title: &str,
    tool_status: &str,
    tool_content: Vec<String>,
) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert("toolKind".to_string(), Value::String(tool_kind.to_string()));
    metadata.insert(
        "toolTitle".to_string(),
        Value::String(tool_title.to_string()),
    );
    metadata.insert(
        "toolStatus".to_string(),
        Value::String(tool_status.to_string()),
    );
    metadata.insert(
        "toolContent".to_string(),
        Value::Array(tool_content.into_iter().map(Value::String).collect()),
    );
    metadata
}

fn normalize_tool_kind(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            'A'..='Z' => character.to_ascii_lowercase(),
            ' ' | '/' | '_' => '-',
            other => other,
        })
        .collect()
}

fn humanize(value: &str) -> String {
    let mut words = Vec::new();
    let mut word = String::new();
    for character in value.chars() {
        if matches!(character, '-' | '_' | '/' | ' ') {
            if !word.is_empty() {
                words.push(word);
                word = String::new();
            }
            continue;
        }
        if character.is_ascii_uppercase() && !word.is_empty() {
            words.push(word);
            word = String::new();
        }
        word.push(character);
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
        .into_iter()
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_error_message(value: &Value) -> Option<String> {
    value
        .get("message")
        .or_else(|| value.get("error"))
        .or_else(|| value.get("additionalDetails"))
        .and_then(|value| match value {
            Value::String(text) => Some(text.to_string()),
            other => serde_json::to_string(other).ok(),
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

async fn write_message(stdin: &mut Option<ChildStdin>, message: &Value) -> Result<()> {
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| anyhow!("Codex app-server stdin is closed"))?;
    let mut encoded = serde_json::to_vec(message)?;
    encoded.push(b'\n');
    stdin.write_all(&encoded).await?;
    stdin.flush().await?;
    Ok(())
}

async fn close_stdin(stdin: &mut Option<ChildStdin>) {
    if let Some(mut stdin) = stdin.take() {
        let _ = stdin.shutdown().await;
    }
}

async fn emit_failed(
    output_tx: &mpsc::Sender<ExecutorOutput>,
    state: &mut ProtocolState,
    error: String,
    exit_code: Option<i32>,
) {
    if state.terminal_emitted {
        return;
    }
    state.terminal_emitted = true;
    let _ = output_tx
        .send(ExecutorOutput::Failed { error, exit_code })
        .await;
}

async fn terminate_process_tree(child: &mut Child, pid: u32) {
    let leader_already_reaped = child.try_wait().ok().flatten().is_some();

    #[cfg(unix)]
    {
        let valid_pgid = pid > 0 && pid <= i32::MAX as u32;
        if valid_pgid {
            // Negative pid targets the process group established in pre_exec.
            // Always signal it, even if the app-server leader has already
            // exited: command and MCP descendants can still own the group.
            let _ = unsafe { nix::libc::kill(-(pid as i32), nix::libc::SIGTERM) };
        }

        if !leader_already_reaped
            && tokio::time::timeout(SHUTDOWN_GRACE, child.wait())
                .await
                .is_err()
        {
            if valid_pgid {
                let _ = unsafe { nix::libc::kill(-(pid as i32), nix::libc::SIGKILL) };
            }
            let _ = child.wait().await;
        }

        if valid_pgid {
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                let group_exists = unsafe { nix::libc::kill(-(pid as i32), 0) } == 0
                    || std::io::Error::last_os_error().raw_os_error() == Some(nix::libc::EPERM);
                if !group_exists {
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = unsafe { nix::libc::kill(-(pid as i32), nix::libc::SIGKILL) };
                    let reap_deadline = Instant::now() + SHUTDOWN_GRACE;
                    loop {
                        let group_exists = unsafe { nix::libc::kill(-(pid as i32), 0) } == 0
                            || std::io::Error::last_os_error().raw_os_error()
                                == Some(nix::libc::EPERM);
                        if !group_exists || Instant::now() >= reap_deadline {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    #[cfg(not(unix))]
    {
        if !leader_already_reaped {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::time::timeout;

    const FAKE_SERVER: &str = r#"#!/bin/sh
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then
  printf '%s\n' 'Options: --stdio'
  exit 0
fi

: > "$FAKE_ARGS"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$FAKE_ARGS"
done

if [ "$FAKE_MODE" = "orphan" ]; then
  (trap '' HUP TERM; sleep 30) &
  printf '%s\n' "$!" > "$FAKE_CHILD_PID"
  exit 23
fi

while IFS= read -r line; do
  printf '%s\n' "$line" >> "$FAKE_LOG"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"id":1,"result":{"userAgent":"fake/1"}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      if [ "$FAKE_MODE" = "thread_error" ]; then
        printf '%s\n' '{"id":2,"error":{"message":"fake thread start failed"}}'
      else
        printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-new"}}}'
      fi
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-existing"}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
      if [ "$FAKE_MODE" = "fail" ]; then
        printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-new","turn":{"id":"turn-1","status":"failed","error":{"message":"fake turn failed"}}}}'
      elif [ "$FAKE_MODE" = "final_only" ]; then
        printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-new","turnId":"turn-1","completedAtMs":4,"item":{"id":"msg-1","type":"agentMessage","text":"hello world\nnext"}}}'
        printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-new","turn":{"id":"turn-1","status":"completed","error":null}}}'
      else
        printf '%s\n' '{"method":"item/started","params":{"threadId":"thread-new","turnId":"turn-1","startedAtMs":1,"item":{"id":"tool-1","type":"commandExecution","command":"printf hi","commandActions":[],"cwd":"/tmp","status":"inProgress"}}}'
        printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-new","turnId":"turn-1","completedAtMs":2,"item":{"id":"tool-1","type":"commandExecution","command":"printf hi","commandActions":[],"cwd":"/tmp","status":"completed","aggregatedOutput":"hi","exitCode":0}}}'
        printf '%s\n' '{"method":"item/started","params":{"threadId":"thread-new","turnId":"turn-1","startedAtMs":3,"item":{"id":"msg-1","type":"agentMessage","text":""}}}'
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-new","turnId":"turn-1","itemId":"msg-1","delta":"hello"}}'
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-new","turnId":"turn-1","itemId":"msg-1","delta":" "}}'
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-new","turnId":"turn-1","itemId":"msg-1","delta":"world"}}'
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-new","turnId":"turn-1","itemId":"msg-1","delta":"\nnext"}}'
        printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-new","turnId":"turn-1","completedAtMs":4,"item":{"id":"msg-1","type":"agentMessage","text":"hello world\nnext"}}}'
        printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-new","turn":{"id":"turn-1","status":"completed","error":null}}}'
      fi
      ;;
  esac
done
printf '%s\n' EOF >> "$FAKE_LOG"
"#;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "conductor-codex-app-server-{prefix}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn fake_server(prefix: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let root = unique_temp_dir(prefix);
        fs::create_dir_all(&root).expect("create temp dir");
        let binary = root.join("fake-codex");
        let log = root.join("protocol.log");
        let args = root.join("args.log");
        fs::write(&binary, FAKE_SERVER).expect("write fake server");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
            .expect("make fake server executable");
        (root, binary, log, args)
    }

    fn options(cwd: &Path) -> SpawnOptions {
        SpawnOptions {
            cwd: cwd.to_path_buf(),
            prompt: "preserve  whitespace".to_string(),
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("max".to_string()),
            skip_permissions: true,
            extra_args: vec![
                "-c".to_string(),
                "features.fake=true".to_string(),
                "--ignored".to_string(),
                "ignored-value".to_string(),
                "--config=model_verbosity=\"low\"".to_string(),
            ],
            env: HashMap::new(),
            branch: None,
            timeout: Some(Duration::from_secs(5)),
            interactive: false,
            structured_output: true,
            resume_target: None,
        }
    }

    fn clean_env(log: &Path, args: &Path, mode: &str) -> HashMap<String, String> {
        HashMap::from([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("FAKE_LOG".to_string(), log.display().to_string()),
            ("FAKE_ARGS".to_string(), args.display().to_string()),
            ("FAKE_MODE".to_string(), mode.to_string()),
        ])
    }

    async fn collect_outputs(mut handle: ExecutorHandle) -> Vec<ExecutorOutput> {
        timeout(Duration::from_secs(5), async move {
            let mut outputs = Vec::new();
            while let Some(output) = handle.output_rx.recv().await {
                outputs.push(output);
            }
            outputs
        })
        .await
        .expect("app-server output should close")
    }

    fn protocol_messages(log: &Path) -> Vec<Value> {
        fs::read_to_string(log)
            .expect("read protocol log")
            .lines()
            .filter(|line| *line != "EOF")
            .map(|line| serde_json::from_str(line).expect("protocol line should be JSON"))
            .collect()
    }

    #[tokio::test]
    async fn support_probe_detects_stdio_app_server() {
        let (root, binary, _, _) = fake_server("support");
        assert!(is_supported(&binary).await);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn support_probe_does_not_cache_timeout_or_command_failures() {
        let root = unique_temp_dir("support-probe-retry");
        fs::create_dir_all(&root).expect("create temp dir");
        let binary = root.join("fake-codex");
        let mode_path = root.join("help-mode");
        fs::write(&mode_path, "error").expect("write initial mode");
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then
  mode=$(cat "{}")
  case "$mode" in
    support)
      printf '%s\n' 'Options: --stdio'
      exit 0
      ;;
    timeout)
      sleep 4
      exit 0
      ;;
    *)
      printf '%s\n' 'probe failed' >&2
      exit 1
      ;;
  esac
fi
exit 0
"#,
            mode_path.display()
        );
        fs::write(&binary, script).expect("write fake server");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
            .expect("make fake server executable");

        assert!(!is_supported(&binary).await);
        fs::write(&mode_path, "timeout").expect("write timeout mode");
        assert!(!is_supported(&binary).await);
        fs::write(&mode_path, "support").expect("write success mode");
        assert!(is_supported(&binary).await);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn spawn_streams_exact_deltas_tool_lifecycle_and_clean_completion() {
        let (root, binary, log, args_log) = fake_server("stream");
        let handle = spawn(
            &binary,
            options(&root),
            clean_env(&log, &args_log, "stream"),
        )
        .await
        .expect("spawn fake app-server");
        let outputs = collect_outputs(handle).await;

        let deltas = outputs
            .iter()
            .filter_map(|output| match output {
                ExecutorOutput::AssistantDelta(delta) => Some(delta.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(deltas, vec!["hello", " ", "world", "\nnext"]);
        assert!(!outputs.iter().any(
            |output| matches!(output, ExecutorOutput::Stdout(text) if text == "hello world\nnext")
        ));
        assert!(outputs
            .iter()
            .any(|output| matches!(output, ExecutorOutput::Completed { exit_code: 0 })));
        let thread_started = outputs.iter().find_map(|output| match output {
            ExecutorOutput::StructuredStatus { metadata, .. }
                if metadata.get("eventKind").and_then(Value::as_str) == Some("thread_started") =>
            {
                Some(metadata)
            }
            _ => None,
        });
        let thread_started = thread_started.expect("thread started metadata should be emitted");
        assert_eq!(
            thread_started.get("codexThreadId").and_then(Value::as_str),
            Some("thread-new")
        );
        assert!(thread_started.get("nativeResumeTarget").is_none());

        let tool_events = outputs
            .iter()
            .filter_map(|output| match output {
                ExecutorOutput::StructuredStatus { metadata, .. }
                    if metadata.get("toolCallId").is_some() =>
                {
                    Some(metadata)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(tool_events.len(), 2);
        assert!(tool_events.iter().all(|metadata| {
            metadata.get("toolCallId").and_then(Value::as_str) == Some("tool-1")
                && metadata.get("itemId").and_then(Value::as_str) == Some("tool-1")
        }));
        assert_eq!(
            tool_events[0].get("toolStatus").and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            tool_events[1].get("toolStatus").and_then(Value::as_str),
            Some("completed")
        );

        let messages = protocol_messages(&log);
        assert_eq!(messages[0]["method"], "initialize");
        assert_eq!(messages[0]["params"]["clientInfo"]["name"], "conductor-oss");
        assert_eq!(messages[1], json!({ "method": "initialized" }));
        assert_eq!(messages[2]["method"], "thread/start");
        assert_eq!(messages[2]["params"]["ephemeral"], false);
        assert_eq!(messages[2]["params"]["model"], "gpt-test");
        assert_eq!(messages[2]["params"]["approvalPolicy"], "never");
        assert_eq!(messages[2]["params"]["sandbox"], "danger-full-access");
        assert_eq!(messages[3]["method"], "turn/start");
        assert_eq!(messages[3]["params"]["effort"], "xhigh");
        assert_eq!(
            messages[3]["params"]["input"][0]["text"],
            "preserve  whitespace"
        );

        let args = fs::read_to_string(&args_log).expect("read args log");
        assert_eq!(
            args.lines().collect::<Vec<_>>(),
            vec![
                "app-server",
                "--stdio",
                "-c",
                "features.fake=true",
                "--config=model_verbosity=\"low\"",
            ]
        );
        assert!(fs::read_to_string(&log)
            .expect("read protocol eof")
            .lines()
            .any(|line| line == "EOF"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn spawn_uses_final_text_when_no_deltas_arrive() {
        let (root, binary, log, args_log) = fake_server("final-only");
        let handle = spawn(
            &binary,
            options(&root),
            clean_env(&log, &args_log, "final_only"),
        )
        .await
        .expect("spawn fake app-server");
        let outputs = collect_outputs(handle).await;

        let stdout = outputs
            .iter()
            .filter_map(|output| match output {
                ExecutorOutput::Stdout(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(stdout, vec!["hello world\nnext"]);
        assert!(!outputs
            .iter()
            .any(|output| matches!(output, ExecutorOutput::AssistantDelta(_))));
        assert!(outputs
            .iter()
            .any(|output| matches!(output, ExecutorOutput::Completed { exit_code: 0 })));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn spawn_resumes_persisted_thread_before_starting_turn() {
        let (root, binary, log, args_log) = fake_server("resume");
        let mut spawn_options = options(&root);
        spawn_options.resume_target = Some("thread-existing".to_string());
        let handle = spawn(&binary, spawn_options, clean_env(&log, &args_log, "stream"))
            .await
            .expect("spawn fake app-server");
        let outputs = collect_outputs(handle).await;
        assert!(outputs
            .iter()
            .any(|output| matches!(output, ExecutorOutput::Completed { exit_code: 0 })));

        let messages = protocol_messages(&log);
        assert_eq!(messages[2]["method"], "thread/resume");
        assert_eq!(messages[2]["params"]["threadId"], "thread-existing");
        assert_eq!(messages[3]["params"]["threadId"], "thread-existing");
        assert!(!messages
            .iter()
            .any(|message| message["method"] == "thread/start"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failed_turn_emits_failed_and_still_closes_stdin() {
        let (root, binary, log, args_log) = fake_server("failure");
        let handle = spawn(&binary, options(&root), clean_env(&log, &args_log, "fail"))
            .await
            .expect("spawn fake app-server");
        let outputs = collect_outputs(handle).await;
        assert!(outputs.iter().any(|output| matches!(
            output,
            ExecutorOutput::Failed { error, exit_code: Some(1) }
                if error == "fake turn failed"
        )));
        assert!(!outputs
            .iter()
            .any(|output| matches!(output, ExecutorOutput::Completed { .. })));
        assert!(fs::read_to_string(&log)
            .expect("read protocol eof")
            .lines()
            .any(|line| line == "EOF"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn leader_exit_still_terminates_process_group_descendants() {
        let (root, binary, log, args_log) = fake_server("orphan");
        let child_pid_path = root.join("child.pid");
        let mut env = clean_env(&log, &args_log, "orphan");
        env.insert(
            "FAKE_CHILD_PID".to_string(),
            child_pid_path.display().to_string(),
        );

        let error = match spawn(&binary, options(&root), env).await {
            Ok(_) => panic!("orphaned leader should fail the pre-turn handshake"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("pre-turn handshake failed")
                || error.to_string().contains("pre-turn handshake completed")
        );

        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("read fake descendant pid")
            .trim()
            .parse::<i32>()
            .expect("descendant pid should be numeric");
        timeout(Duration::from_secs(3), async {
            loop {
                let descendant_exists = unsafe { nix::libc::kill(child_pid, 0) } == 0
                    || std::io::Error::last_os_error().raw_os_error() == Some(nix::libc::EPERM);
                if !descendant_exists {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("app-server descendant leaked after leader exit");
        let _ = fs::remove_dir_all(root);
    }
}
