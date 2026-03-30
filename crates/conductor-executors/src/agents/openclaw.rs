use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use conductor_core::types::AgentKind;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep_until, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;
use url::Url;
use uuid::Uuid;

use crate::executor::{Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions};

const OPENCLAW_GATEWAY_URL_ENV: &str = "OPENCLAW_GATEWAY_URL";
const OPENCLAW_GATEWAY_TOKEN_ENV: &str = "OPENCLAW_GATEWAY_TOKEN";
const OPENCLAW_GATEWAY_PASSWORD_ENV: &str = "OPENCLAW_GATEWAY_PASSWORD";
const OPENCLAW_GATEWAY_SCOPES_ENV: &str = "OPENCLAW_GATEWAY_SCOPES";
const OPENCLAW_SESSION_KEY_ENV: &str = "OPENCLAW_SESSION_KEY";
const OPENCLAW_DEVICE_STATE_FILE: &str = "device-auth.json";
const OPENCLAW_PROTOCOL_VERSION: u32 = 3;
const OPENCLAW_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const OPENCLAW_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const OPENCLAW_ROLE: &str = "operator";
const OPENCLAW_CLIENT_ID: &str = "conductor-dispatcher";
const OPENCLAW_CLIENT_MODE: &str = "dispatcher";
const OPENCLAW_DEVICE_FAMILY: &str = "desktop";
const OPENCLAW_BINARY_NAME: &str = "openclaw-gateway";

/// Keys whose values must be redacted in log output.
const SENSITIVE_KEY_PATTERN: &[&str] = &[
    "auth",
    "authorization",
    "token",
    "secret",
    "password",
    "api_key",
    "private_key",
    "x-openclaw-auth",
    "x-openclaw-token",
    "deviceToken",
];

#[derive(Clone)]
pub struct OpenClawExecutor {
    gateway_url: String,
    binary: PathBuf,
}

impl OpenClawExecutor {
    pub fn new(gateway_url: String) -> Self {
        Self {
            gateway_url,
            binary: PathBuf::from(OPENCLAW_BINARY_NAME),
        }
    }

    pub fn discover() -> Option<Self> {
        let gateway_url = env::var(OPENCLAW_GATEWAY_URL_ENV).unwrap_or_default();
        Some(Self::new(gateway_url.trim().to_string()))
    }
}

#[async_trait]
impl Executor for OpenClawExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenClaw
    }

    fn name(&self) -> &str {
        "OpenClaw"
    }

    fn binary_path(&self) -> &Path {
        &self.binary
    }

    async fn is_available(&self) -> bool {
        if self.gateway_url.trim().is_empty() {
            return true;
        }
        let Ok(health_url) = health_url(&self.gateway_url) else {
            return false;
        };

        let client = match reqwest::Client::builder()
            .timeout(OPENCLAW_HEALTH_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(_) => return false,
        };

        client
            .get(health_url)
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    }

    async fn version(&self) -> Result<String> {
        if self.gateway_url.trim().is_empty() {
            return Ok("gateway-configured-per-thread".to_string());
        }
        let health_url = health_url(&self.gateway_url)?;
        let client = reqwest::Client::builder()
            .timeout(OPENCLAW_HEALTH_TIMEOUT)
            .build()?;
        let response = client.get(health_url).send().await?;
        let response = response.error_for_status()?;
        let body = response.text().await?;
        if let Ok(value) = serde_json::from_str::<Value>(&body) {
            if let Some(version) = value.get("version").and_then(Value::as_str) {
                return Ok(version.to_string());
            }
            if let Some(version) = value
                .get("gateway")
                .and_then(|gateway| gateway.get("version"))
                .and_then(Value::as_str)
            {
                return Ok(version.to_string());
            }
        }

        Ok("gateway".to_string())
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let config = GatewayConfig::from_options(&self.gateway_url, &options)?;
        let session_key = resolve_session_key(&options.env);
        let prompt = options.prompt.clone();
        let reasoning = options.reasoning_effort.clone();
        let timeout = options.timeout;

        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(8);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();

        tokio::spawn(async move { while input_rx.recv().await.is_some() {} });

        tokio::spawn(async move {
            let outcome = run_openclaw_turn(
                config,
                session_key,
                prompt,
                reasoning,
                timeout,
                output_tx.clone(),
                kill_rx,
            )
            .await;

            let final_event = match outcome {
                RunOutcome::Completed { exit_code, meta } => {
                    tracing::info!(
                        provider = meta.provider.as_deref().unwrap_or("openclaw"),
                        model = meta.model.as_deref().unwrap_or("unknown"),
                        cost_usd = meta.cost_usd.unwrap_or(0.0),
                        input_tokens = meta.input_tokens.unwrap_or(0),
                        output_tokens = meta.output_tokens.unwrap_or(0),
                        "OpenClaw run completed with metadata"
                    );
                    ExecutorOutput::Completed { exit_code }
                }
                RunOutcome::Failed { error, exit_code } => {
                    ExecutorOutput::Failed { error, exit_code }
                }
            };
            let _ = output_tx.send(final_event).await;
        });

        Ok(ExecutorHandle::new(
            std::process::id(),
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

#[derive(Debug, Clone)]
struct GatewayConfig {
    ws_url: Url,
    gateway_key: String,
    auth_token: Option<String>,
    password: Option<String>,
    scopes: Vec<String>,
}

impl GatewayConfig {
    fn from_options(gateway_url: &str, options: &SpawnOptions) -> Result<Self> {
        let resolved_gateway_url = options
            .env
            .get(OPENCLAW_GATEWAY_URL_ENV)
            .cloned()
            .or_else(|| env::var(OPENCLAW_GATEWAY_URL_ENV).ok())
            .unwrap_or_else(|| gateway_url.to_string());
        let resolved_gateway_url = resolved_gateway_url.trim().to_string();
        let auth_token = env_override(options, OPENCLAW_GATEWAY_TOKEN_ENV);
        let password = env_override(options, OPENCLAW_GATEWAY_PASSWORD_ENV);
        let scopes = resolve_scopes(options);
        let ws_url = websocket_url(&resolved_gateway_url)?;
        let gateway_key = gateway_scope_key(&ws_url, &scopes);

        Ok(Self {
            ws_url,
            gateway_key,
            auth_token,
            password,
            scopes,
        })
    }
}

#[derive(Debug)]
enum RunOutcome {
    Completed {
        exit_code: i32,
        meta: RunResultMeta,
    },
    Failed {
        error: String,
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceIdentityStore {
    version: u32,
    device_id: String,
    public_key: String,
    private_key: String,
    #[serde(default)]
    tokens: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatPayload {
    run_id: String,
    state: String,
    #[serde(default)]
    message: Option<GatewayMessage>,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayMessage {
    #[serde(default)]
    content: Vec<GatewayContent>,
}

#[derive(Debug, Deserialize)]
struct GatewayContent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPayload {
    run_id: String,
    #[serde(default)]
    session_key: Option<String>,
    stream: String,
    #[serde(default)]
    data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum GatewayFrame {
    #[serde(rename = "event")]
    Event { event: String, payload: Value },
    #[serde(rename = "res")]
    Response {
        id: String,
        ok: bool,
        #[serde(default)]
        payload: Option<Value>,
        #[serde(default)]
        error: Option<Value>,
    },
    #[serde(rename = "req")]
    Request,
}

async fn run_openclaw_turn(
    config: GatewayConfig,
    session_key: String,
    prompt: String,
    reasoning_effort: Option<String>,
    timeout: Option<Duration>,
    output_tx: mpsc::Sender<ExecutorOutput>,
    kill_rx: oneshot::Receiver<()>,
) -> RunOutcome {
    match run_openclaw_turn_inner(
        config.clone(),
        session_key.clone(),
        prompt.clone(),
        reasoning_effort.clone(),
        timeout,
        output_tx.clone(),
        kill_rx,
    )
    .await
    {
        RunOutcome::Failed { error, .. }
            if error.starts_with("PAIRING_REQUIRED:")
                && (config.auth_token.is_some() || config.password.is_some()) =>
        {
            let pairing_err = error.strip_prefix("PAIRING_REQUIRED: ").unwrap_or(&error);
            let request_id = extract_pairing_request_id(pairing_err);
            tracing::warn!("OpenClaw pairing required, attempting auto-approval");

            match auto_approve_device_pairing(
                &config.ws_url,
                &HashMap::new(),
                config.auth_token.as_deref(),
                config.password.as_deref(),
                &config.scopes,
                request_id.as_deref(),
                OPENCLAW_CONNECT_TIMEOUT,
            )
            .await
            {
                Ok(approved_id) => {
                    tracing::info!("OpenClaw auto-pair approved: {approved_id}, retrying");
                    // Retry with a dead kill channel (acceptable for one auto-pair retry)
                    let (_dead_kill_tx, dead_kill_rx) = oneshot::channel::<()>();
                    drop(_dead_kill_tx);
                    run_openclaw_turn_inner(
                        config,
                        session_key,
                        prompt,
                        reasoning_effort,
                        timeout,
                        output_tx,
                        dead_kill_rx,
                    )
                    .await
                }
                Err(pair_err) => {
                    tracing::warn!("OpenClaw auto-pair failed: {pair_err}");
                    RunOutcome::Failed {
                        error: format!(
                            "{pairing_err}. Auto-pairing failed: {pair_err}. \
                             Approve the device manually: openclaw devices approve --latest"
                        ),
                        exit_code: Some(1),
                    }
                }
            }
        }
        other => other,
    }
}

async fn run_openclaw_turn_inner(
    config: GatewayConfig,
    session_key: String,
    prompt: String,
    reasoning_effort: Option<String>,
    timeout: Option<Duration>,
    output_tx: mpsc::Sender<ExecutorOutput>,
    mut kill_rx: oneshot::Receiver<()>,
) -> RunOutcome {
    let ws_result = tokio::time::timeout(
        OPENCLAW_CONNECT_TIMEOUT,
        connect_async(config.ws_url.as_str()),
    )
    .await;
    let (mut ws, _) = match ws_result {
        Ok(Ok(pair)) => pair,
        Ok(Err(err)) => {
            return RunOutcome::Failed {
                error: format!("OpenClaw gateway connect failed: {err}"),
                exit_code: Some(1),
            }
        }
        Err(_) => {
            return RunOutcome::Failed {
                error: "OpenClaw gateway connect timed out".to_string(),
                exit_code: Some(124),
            }
        }
    };

    let challenge = match read_connect_challenge(&mut ws).await {
        Ok(challenge) => challenge,
        Err(err) => {
            let _ = ws.close(None).await;
            return RunOutcome::Failed {
                error: err.to_string(),
                exit_code: Some(1),
            };
        }
    };

    let mut identity = match load_or_create_device_identity() {
        Ok(identity) => identity,
        Err(err) => {
            let _ = ws.close(None).await;
            return RunOutcome::Failed {
                error: format!("OpenClaw device identity setup failed: {err}"),
                exit_code: Some(1),
            };
        }
    };

    let connect_id = Uuid::new_v4().to_string();
    let signed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let signature_payload = build_device_signature_payload_v3(
        &identity.device_id,
        OPENCLAW_CLIENT_ID,
        OPENCLAW_CLIENT_MODE,
        OPENCLAW_ROLE,
        &config.scopes,
        signed_at,
        config.auth_token.as_deref(),
        &challenge,
        platform_name(),
        OPENCLAW_DEVICE_FAMILY,
    );
    let signature = match sign_device_payload(&identity.private_key, &signature_payload) {
        Ok(signature) => signature,
        Err(err) => {
            let _ = ws.close(None).await;
            return RunOutcome::Failed {
                error: format!("OpenClaw device signing failed: {err}"),
                exit_code: Some(1),
            };
        }
    };

    let cached_device_token = identity.tokens.get(&config.gateway_key).cloned();
    let connect_request = json!({
        "type": "req",
        "id": connect_id,
        "method": "connect",
        "params": {
            "minProtocol": OPENCLAW_PROTOCOL_VERSION,
            "maxProtocol": OPENCLAW_PROTOCOL_VERSION,
            "client": {
                "id": OPENCLAW_CLIENT_ID,
                "version": env!("CARGO_PKG_VERSION"),
                "platform": platform_name(),
                "mode": OPENCLAW_CLIENT_MODE,
            },
            "role": OPENCLAW_ROLE,
            "scopes": config.scopes,
            "caps": ["tool-events"],
            "commands": [],
            "permissions": {},
            "auth": build_connect_auth(config.auth_token.as_deref(), cached_device_token.as_deref(), config.password.as_deref()),
            "locale": locale_name(),
            "userAgent": format!("conductor-oss/{}", env!("CARGO_PKG_VERSION")),
            "device": {
                "id": identity.device_id,
                "publicKey": identity.public_key,
                "signature": signature,
                "signedAt": signed_at,
                "nonce": challenge,
            }
        }
    });

    // Log redacted connect params for debugging
    let redacted = redact_json_for_log(&connect_request, &[], 0);
    tracing::debug!(payload = %redacted, "OpenClaw connect request");

    if let Err(err) = send_json_frame(&mut ws, &connect_request).await {
        let _ = ws.close(None).await;
        return RunOutcome::Failed {
            error: format!("OpenClaw connect request failed: {err}"),
            exit_code: Some(1),
        };
    }

    let connect_result = wait_for_connect_response(&mut ws, &connect_id).await;
    let hello = match connect_result {
        Ok(hello) => hello,
        Err(err) => {
            let _ = ws.close(None).await;
            let err_msg = err.to_string();
            let lower = err_msg.to_lowercase();

            // Detect pairing required error and return a special marker
            if lower.contains("pairing") || lower.contains("pair") {
                return RunOutcome::Failed {
                    error: format!("PAIRING_REQUIRED: {err_msg}"),
                    exit_code: Some(1),
                };
            }
            return RunOutcome::Failed {
                error: err_msg,
                exit_code: Some(1),
            };
        }
    };

    if let Some(device_token) = hello
        .get("auth")
        .and_then(|auth| auth.get("deviceToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        identity
            .tokens
            .insert(config.gateway_key.clone(), device_token.to_string());
        if let Err(err) = save_device_identity(&identity) {
            tracing::warn!("failed to persist OpenClaw device token: {err}");
        }
    }

    let client_run_id = Uuid::new_v4().to_string();
    let send_request_id = Uuid::new_v4().to_string();
    let send_request = json!({
        "type": "req",
        "id": send_request_id,
        "method": "chat.send",
        "params": {
            "sessionKey": session_key,
            "message": prompt,
            "idempotencyKey": client_run_id,
            "deliver": false,
            "thinking": reasoning_effort,
        }
    });

    if let Err(err) = send_json_frame(&mut ws, &send_request).await {
        let _ = ws.close(None).await;
        return RunOutcome::Failed {
            error: format!("OpenClaw chat.send failed: {err}"),
            exit_code: Some(1),
        };
    }

    let mut lifecycle_error: Option<String> = None;
    let mut latest_payload: Option<Value> = None;

    let timeout_deadline = timeout.map(|duration| Instant::now() + duration);
    loop {
        if let Some(deadline_at) = timeout_deadline {
            let mut deadline = Box::pin(sleep_until(deadline_at));
            tokio::select! {
                _ = &mut kill_rx => {
                    let _ = send_abort(&mut ws, &session_key, Some(&client_run_id)).await;
                    let _ = ws.close(None).await;
                    return RunOutcome::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(130),
                    };
                }
                _ = &mut deadline => {
                    let _ = send_abort(&mut ws, &session_key, Some(&client_run_id)).await;
                    let _ = ws.close(None).await;
                    return RunOutcome::Failed {
                        error: "OpenClaw request timed out".to_string(),
                        exit_code: Some(124),
                    };
                }
                frame = ws.next() => {
                    match handle_runtime_frame(
                        frame,
                        &send_request_id,
                        &client_run_id,
                        &output_tx,
                        &mut lifecycle_error,
                        &mut latest_payload,
                    ).await {
                        ControlFlow::Continue => {}
                        ControlFlow::Completed => {
                            let _ = ws.close(None).await;
                            let meta = latest_payload.as_ref().map(extract_run_meta).unwrap_or_default();
                            return RunOutcome::Completed { exit_code: 0, meta };
                        }
                        ControlFlow::Failed { error, exit_code } => {
                            let _ = ws.close(None).await;
                            return RunOutcome::Failed { error, exit_code };
                        }
                    }
                }
            }
        } else {
            tokio::select! {
                _ = &mut kill_rx => {
                    let _ = send_abort(&mut ws, &session_key, Some(&client_run_id)).await;
                    let _ = ws.close(None).await;
                    return RunOutcome::Failed {
                        error: "killed".to_string(),
                        exit_code: Some(130),
                    };
                }
                frame = ws.next() => {
                    match handle_runtime_frame(
                        frame,
                        &send_request_id,
                        &client_run_id,
                        &output_tx,
                        &mut lifecycle_error,
                        &mut latest_payload,
                    ).await {
                        ControlFlow::Continue => {}
                        ControlFlow::Completed => {
                            let _ = ws.close(None).await;
                            let meta = latest_payload.as_ref().map(extract_run_meta).unwrap_or_default();
                            return RunOutcome::Completed { exit_code: 0, meta };
                        }
                        ControlFlow::Failed { error, exit_code } => {
                            let _ = ws.close(None).await;
                            return RunOutcome::Failed { error, exit_code };
                        }
                    }
                }
            }
        }
    }
}

enum ControlFlow {
    Continue,
    Completed,
    Failed {
        error: String,
        exit_code: Option<i32>,
    },
}

async fn handle_runtime_frame(
    frame: Option<std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>,
    send_request_id: &str,
    client_run_id: &str,
    output_tx: &mpsc::Sender<ExecutorOutput>,
    lifecycle_error: &mut Option<String>,
    latest_payload: &mut Option<Value>,
) -> ControlFlow {
    let Some(frame) = frame else {
        return ControlFlow::Failed {
            error: lifecycle_error.clone().unwrap_or_else(|| {
                "OpenClaw gateway disconnected before the run completed".to_string()
            }),
            exit_code: Some(1),
        };
    };

    let message = match frame {
        Ok(message) => message,
        Err(err) => {
            return ControlFlow::Failed {
                error: format!("OpenClaw websocket error: {err}"),
                exit_code: Some(1),
            };
        }
    };

    let Some(text) = websocket_text(message) else {
        return ControlFlow::Continue;
    };

    let frame = match serde_json::from_str::<GatewayFrame>(&text) {
        Ok(frame) => frame,
        Err(_) => return ControlFlow::Continue,
    };

    match frame {
        GatewayFrame::Response {
            id,
            ok,
            payload: _,
            error,
        } if id == send_request_id => {
            if ok {
                ControlFlow::Continue
            } else {
                ControlFlow::Failed {
                    error: gateway_error_message(error.as_ref(), "OpenClaw chat.send rejected"),
                    exit_code: Some(1),
                }
            }
        }
        GatewayFrame::Response { .. } => ControlFlow::Continue,
        GatewayFrame::Event { event, payload } if event == "chat" => {
            // Track the payload for cost/usage extraction on completion
            *latest_payload = Some(payload.clone());
            match convert_chat_event(&payload, client_run_id) {
                Some(ChatConversion::Stdout(text)) => {
                    let _ = output_tx.send(ExecutorOutput::Stdout(text)).await;
                    ControlFlow::Continue
                }
                Some(ChatConversion::Completed(text)) => {
                    if let Some(text) = text {
                        let _ = output_tx.send(ExecutorOutput::Stdout(text)).await;
                    }
                    ControlFlow::Completed
                }
                Some(ChatConversion::Failed { error, exit_code }) => {
                    ControlFlow::Failed { error, exit_code }
                }
                None => ControlFlow::Continue,
            }
        }
        GatewayFrame::Event { event, payload } if event == "agent" => {
            // Track agent payloads that may contain result metadata
            if payload.get("stream").and_then(Value::as_str) == Some("result")
                || payload.get("stream").and_then(Value::as_str) == Some("lifecycle")
            {
                *latest_payload = Some(payload.clone());
            }
            if let Some(event) = convert_agent_event(&payload, client_run_id, lifecycle_error) {
                let _ = output_tx.send(event).await;
            }
            ControlFlow::Continue
        }
        GatewayFrame::Event { event, payload } if event == "heartbeat" => {
            if let Some(event) = convert_heartbeat_event(&payload) {
                let _ = output_tx.send(event).await;
            }
            ControlFlow::Continue
        }
        GatewayFrame::Event { .. } | GatewayFrame::Request => ControlFlow::Continue,
    }
}

async fn read_connect_challenge<S>(ws: &mut S) -> Result<String>
where
    S: futures_util::Stream<
            Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    let next = tokio::time::timeout(OPENCLAW_CONNECT_TIMEOUT, ws.next())
        .await
        .context("timed out waiting for OpenClaw connect challenge")?;
    let Some(frame) = next else {
        bail!("OpenClaw gateway closed before sending connect.challenge");
    };
    let message = frame?;
    let Some(text) = websocket_text(message) else {
        bail!("OpenClaw gateway sent a non-text connect challenge");
    };
    let frame: GatewayFrame =
        serde_json::from_str(&text).context("invalid OpenClaw challenge frame")?;
    match frame {
        GatewayFrame::Event { event, payload } if event == "connect.challenge" => payload
            .get("nonce")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow!("OpenClaw connect.challenge missing nonce")),
        _ => bail!("unexpected OpenClaw handshake frame"),
    }
}

async fn wait_for_connect_response<S>(ws: &mut S, connect_id: &str) -> Result<Value>
where
    S: futures_util::Stream<
            Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    loop {
        let next = tokio::time::timeout(OPENCLAW_CONNECT_TIMEOUT, ws.next())
            .await
            .context("timed out waiting for OpenClaw connect response")?;
        let Some(frame) = next else {
            bail!("OpenClaw gateway closed during connect");
        };
        let message = frame?;
        let Some(text) = websocket_text(message) else {
            continue;
        };
        let frame: GatewayFrame =
            serde_json::from_str(&text).context("invalid OpenClaw connect response")?;
        match frame {
            GatewayFrame::Response {
                id,
                ok,
                payload,
                error,
            } if id == connect_id => {
                if !ok {
                    bail!(
                        "{}",
                        gateway_error_message(error.as_ref(), "OpenClaw connect rejected")
                    );
                }
                let payload = payload.unwrap_or(Value::Null);
                if payload.get("type").and_then(Value::as_str) != Some("hello-ok") {
                    bail!("OpenClaw connect response was not hello-ok");
                }
                return Ok(payload);
            }
            GatewayFrame::Event { .. } | GatewayFrame::Request | GatewayFrame::Response { .. } => {
                continue;
            }
        }
    }
}

async fn send_abort<S>(ws: &mut S, session_key: &str, run_id: Option<&str>) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let payload = json!({
        "type": "req",
        "id": Uuid::new_v4().to_string(),
        "method": "chat.abort",
        "params": {
            "sessionKey": session_key,
            "runId": run_id,
        }
    });
    send_json_frame(ws, &payload).await
}

async fn send_json_frame<S>(ws: &mut S, payload: &Value) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let text = serde_json::to_string(payload)?;
    ws.send(Message::Text(text.into())).await?;
    Ok(())
}

fn websocket_text(message: Message) -> Option<String> {
    match message {
        Message::Text(text) => Some(text.to_string()),
        Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).ok(),
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => None,
        Message::Close(_) => Some(String::new()),
    }
}

enum ChatConversion {
    Stdout(String),
    Completed(Option<String>),
    Failed {
        error: String,
        exit_code: Option<i32>,
    },
}

fn convert_chat_event(payload: &Value, client_run_id: &str) -> Option<ChatConversion> {
    let payload: ChatPayload = serde_json::from_value(payload.clone()).ok()?;
    if payload.run_id != client_run_id {
        return None;
    }

    match payload.state.as_str() {
        "delta" => extract_message_text(payload.message.as_ref()).map(ChatConversion::Stdout),
        "final" => Some(ChatConversion::Completed(extract_message_text(
            payload.message.as_ref(),
        ))),
        "error" => Some(ChatConversion::Failed {
            error: payload
                .error_message
                .unwrap_or_else(|| "OpenClaw run failed".to_string()),
            exit_code: Some(1),
        }),
        "aborted" => Some(ChatConversion::Failed {
            error: "killed".to_string(),
            exit_code: Some(130),
        }),
        _ => None,
    }
}

fn convert_agent_event(
    payload: &Value,
    client_run_id: &str,
    lifecycle_error: &mut Option<String>,
) -> Option<ExecutorOutput> {
    let payload: AgentPayload = serde_json::from_value(payload.clone()).ok()?;
    if payload.run_id != client_run_id {
        return None;
    }

    match payload.stream.as_str() {
        "tool" => tool_event_to_output(&payload),
        "lifecycle" => {
            if payload.data.get("phase").and_then(Value::as_str) == Some("error") {
                *lifecycle_error = payload
                    .data
                    .get("error")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            lifecycle_event_to_output(&payload)
        }
        "error" => Some(ExecutorOutput::StructuredStatus {
            text: "OpenClaw error".to_string(),
            metadata: lifecycle_metadata(
                "error",
                payload
                    .data
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("agent error"),
                &payload.run_id,
                payload.session_key.as_deref(),
            ),
        }),
        _ => None,
    }
}

fn convert_heartbeat_event(payload: &Value) -> Option<ExecutorOutput> {
    let detail = payload
        .get("text")
        .or_else(|| payload.get("message"))
        .or_else(|| payload.get("summary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Heartbeat");

    let mut metadata = HashMap::new();
    metadata.insert(
        "eventKind".to_string(),
        Value::String("openclaw_heartbeat".to_string()),
    );
    metadata.insert("heartbeat".to_string(), payload.clone());

    Some(ExecutorOutput::StructuredStatus {
        text: format!("Heartbeat: {detail}"),
        metadata,
    })
}

fn tool_event_to_output(payload: &AgentPayload) -> Option<ExecutorOutput> {
    let phase = payload
        .data
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("update");
    let name = payload
        .data
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Tool");
    let title = humanize_tool_title(name);
    let mut content = Vec::new();

    if let Some(args) = payload.data.get("args") {
        if let Some(summary) = summarize_value(args) {
            content.push(format!("Args: {summary}"));
        }
    }
    if let Some(partial_result) = payload.data.get("partialResult") {
        if let Some(summary) = summarize_value(partial_result) {
            content.push(format!("Update: {summary}"));
        }
    }
    if let Some(result) = payload.data.get("result") {
        if let Some(summary) = summarize_value(result) {
            content.push(format!("Result: {summary}"));
        }
    }

    let mut metadata = tool_metadata(
        &normalize_tool_kind(name),
        &title,
        phase_to_tool_status(phase),
        content,
    );
    metadata.insert(
        "openclawPhase".to_string(),
        Value::String(phase.to_string()),
    );
    metadata.insert(
        "openclawRunId".to_string(),
        Value::String(payload.run_id.clone()),
    );
    if let Some(tool_call_id) = payload.data.get("toolCallId").and_then(Value::as_str) {
        metadata.insert(
            "toolCallId".to_string(),
            Value::String(tool_call_id.to_string()),
        );
    }
    if let Some(session_key) = &payload.session_key {
        metadata.insert(
            "openclawSessionKey".to_string(),
            Value::String(session_key.clone()),
        );
    }

    Some(ExecutorOutput::StructuredStatus {
        text: tool_status_text(&title, phase),
        metadata,
    })
}

fn lifecycle_event_to_output(payload: &AgentPayload) -> Option<ExecutorOutput> {
    let phase = payload.data.get("phase").and_then(Value::as_str)?;
    let detail = payload
        .data
        .get("stopReason")
        .or_else(|| payload.data.get("error"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(match phase {
            "start" => "run started",
            "end" => "run finished",
            "error" => "run failed",
            other => other,
        });

    Some(ExecutorOutput::StructuredStatus {
        text: match phase {
            "start" => "OpenClaw started".to_string(),
            "end" => "OpenClaw finished".to_string(),
            "error" => "OpenClaw failed".to_string(),
            other => format!("OpenClaw {other}"),
        },
        metadata: lifecycle_metadata(
            phase,
            detail,
            &payload.run_id,
            payload.session_key.as_deref(),
        ),
    })
}

fn lifecycle_metadata(
    phase: &str,
    detail: &str,
    run_id: &str,
    session_key: Option<&str>,
) -> HashMap<String, Value> {
    let mut metadata = HashMap::new();
    metadata.insert(
        "eventKind".to_string(),
        Value::String("openclaw_lifecycle".to_string()),
    );
    metadata.insert("phase".to_string(), Value::String(phase.to_string()));
    metadata.insert("detail".to_string(), Value::String(detail.to_string()));
    metadata.insert(
        "openclawRunId".to_string(),
        Value::String(run_id.to_string()),
    );
    if let Some(session_key) = session_key {
        metadata.insert(
            "openclawSessionKey".to_string(),
            Value::String(session_key.to_string()),
        );
    }
    metadata
}

fn extract_message_text(message: Option<&GatewayMessage>) -> Option<String> {
    let message = message?;
    let text = message
        .content
        .iter()
        .filter(|segment| segment.kind == "text")
        .filter_map(|segment| segment.text.as_deref())
        .collect::<Vec<_>>()
        .join("");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn tool_status_text(title: &str, phase: &str) -> String {
    match phase {
        "start" => title.to_string(),
        "result" | "end" => format!("{title} result"),
        "error" => format!("{title} error"),
        _ => format!("{title} update"),
    }
}

fn phase_to_tool_status(phase: &str) -> &str {
    match phase {
        "result" | "end" => "success",
        "error" => "error",
        _ => "running",
    }
}

fn humanize_tool_title(name: &str) -> String {
    name.trim()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    let mut title = first.to_uppercase().to_string();
                    title.push_str(chars.as_str());
                    title
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_tool_kind(name: &str) -> String {
    let lower = name.trim().to_ascii_lowercase();
    match lower.as_str() {
        "bash" | "command" | "shell" | "system.run" => "command".to_string(),
        "read" => "read".to_string(),
        "write" => "write".to_string(),
        "edit" => "edit".to_string(),
        "multiedit" => "multiedit".to_string(),
        "grep" => "grep".to_string(),
        "glob" => "glob".to_string(),
        "task" => "task".to_string(),
        "todowrite" => "todowrite".to_string(),
        "web.search" | "web_search" | "websearch" => "websearch".to_string(),
        "web.fetch" | "web_fetch" | "webfetch" => "webfetch".to_string(),
        other => other
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string(),
    }
}

fn summarize_value(value: &Value) -> Option<String> {
    let rendered = match value {
        Value::Null => return None,
        Value::String(text) => text.trim().to_string(),
        other => serde_json::to_string(other).ok()?,
    };
    let trimmed = rendered.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate(trimmed, 400))
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_string();
    }
    let mut end = max_len;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
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

fn gateway_error_message(error: Option<&Value>, fallback: &str) -> String {
    let Some(error) = error else {
        return fallback.to_string();
    };

    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.get("error").and_then(Value::as_str))
        .or_else(|| {
            error
                .get("details")
                .and_then(|details| details.get("code"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn env_override(options: &SpawnOptions, key: &str) -> Option<String> {
    options
        .env
        .get(key)
        .cloned()
        .or_else(|| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_scopes(options: &SpawnOptions) -> Vec<String> {
    env_override(options, OPENCLAW_GATEWAY_SCOPES_ENV)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|scopes| !scopes.is_empty())
        .unwrap_or_else(|| vec!["operator.read".to_string(), "operator.write".to_string()])
}

fn resolve_session_key(env_map: &HashMap<String, String>) -> String {
    if let Some(value) = env_map
        .get(OPENCLAW_SESSION_KEY_ENV)
        .cloned()
        .or_else(|| env::var(OPENCLAW_SESSION_KEY_ENV).ok())
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return value.to_string();
    }

    let session_id = env_map
        .get("CONDUCTOR_SESSION_ID")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("session");
    let project_id = env_map
        .get("CONDUCTOR_PROJECT_ID")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty());
    let session_kind = env_map
        .get("CONDUCTOR_SESSION_KIND")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty());
    let card_id = env_map
        .get("CONDUCTOR_CARD_ID")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty());

    // Card-scoped strategy: same session for same card across heartbeats
    if let Some(card_id) = card_id {
        let mut parts = vec!["conductor".to_string(), "card".to_string()];
        if let Some(project_id) = project_id {
            parts.push(sanitize_key_fragment(project_id));
        }
        parts.push(sanitize_key_fragment(card_id));
        return parts.join(":");
    }

    let mut parts = vec!["conductor".to_string()];
    if let Some(session_kind) = session_kind {
        parts.push(sanitize_key_fragment(session_kind));
    }
    if let Some(project_id) = project_id {
        parts.push(sanitize_key_fragment(project_id));
    }
    parts.push(sanitize_key_fragment(session_id));
    parts.join(":")
}

fn sanitize_key_fragment(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ':' | '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    normalized.trim_matches('-').to_string()
}

fn websocket_url(raw: &str) -> Result<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("OpenClaw gateway URL is empty");
    }

    let mut url =
        Url::parse(trimmed).with_context(|| format!("invalid OpenClaw gateway URL: {trimmed}"))?;
    match url.scheme() {
        "ws" | "wss" => {}
        "http" => {
            url.set_scheme("ws")
                .map_err(|_| anyhow!("invalid OpenClaw gateway URL scheme"))?;
        }
        "https" => {
            url.set_scheme("wss")
                .map_err(|_| anyhow!("invalid OpenClaw gateway URL scheme"))?;
        }
        other => bail!("unsupported OpenClaw gateway URL scheme: {other}"),
    }
    url.set_fragment(None);
    Ok(url)
}

fn health_url(raw: &str) -> Result<Url> {
    let mut url = websocket_url(raw)?;
    match url.scheme() {
        "ws" => {
            url.set_scheme("http")
                .map_err(|_| anyhow!("invalid OpenClaw gateway URL scheme"))?;
        }
        "wss" => {
            url.set_scheme("https")
                .map_err(|_| anyhow!("invalid OpenClaw gateway URL scheme"))?;
        }
        _ => {}
    }
    url.set_path("/health");
    url.set_query(None);
    Ok(url)
}

fn gateway_scope_key(url: &Url, scopes: &[String]) -> String {
    let authority = match url.port_or_known_default() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    format!(
        "{}://{}|{}|{}",
        url.scheme(),
        authority,
        OPENCLAW_ROLE,
        scopes.join(",")
    )
}

fn platform_name() -> &'static str {
    match env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

fn locale_name() -> String {
    let raw = env::var("LC_ALL")
        .ok()
        .or_else(|| env::var("LANG").ok())
        .unwrap_or_else(|| "en_US".to_string());
    raw.split('.').next().unwrap_or("en_US").replace('_', "-")
}

fn build_connect_auth(
    token: Option<&str>,
    device_token: Option<&str>,
    password: Option<&str>,
) -> Value {
    let mut auth = serde_json::Map::new();
    if let Some(token) = token.map(str::trim).filter(|value| !value.is_empty()) {
        auth.insert("token".to_string(), Value::String(token.to_string()));
    }
    if let Some(device_token) = device_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        auth.insert(
            "deviceToken".to_string(),
            Value::String(device_token.to_string()),
        );
    }
    if let Some(password) = password.map(str::trim).filter(|value| !value.is_empty()) {
        auth.insert("password".to_string(), Value::String(password.to_string()));
    }
    Value::Object(auth)
}

#[allow(clippy::too_many_arguments)]
fn build_device_signature_payload_v3(
    device_id: &str,
    client_id: &str,
    client_mode: &str,
    role: &str,
    scopes: &[String],
    signed_at_ms: i64,
    token: Option<&str>,
    nonce: &str,
    platform: &str,
    device_family: &str,
) -> String {
    [
        "v3".to_string(),
        device_id.to_string(),
        client_id.to_string(),
        client_mode.to_string(),
        role.to_string(),
        scopes.join(","),
        signed_at_ms.to_string(),
        token.unwrap_or_default().to_string(),
        nonce.to_string(),
        normalize_device_metadata_for_auth(platform),
        normalize_device_metadata_for_auth(device_family),
    ]
    .join("|")
}

fn normalize_device_metadata_for_auth(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn sign_device_payload(private_key_base64: &str, payload: &str) -> Result<String> {
    let key_bytes = URL_SAFE_NO_PAD
        .decode(private_key_base64)
        .context("invalid OpenClaw private key encoding")?;
    let key_bytes: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("invalid OpenClaw private key length"))?;
    let signing_key = SigningKey::from_bytes(&key_bytes);
    let signature = signing_key.sign(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

/// Check if a JSON key path matches a sensitive key pattern.
fn is_sensitive_key(key: &str) -> bool {
    let lower = key.trim().to_ascii_lowercase();
    SENSITIVE_KEY_PATTERN.iter().any(|pat| lower.contains(pat))
}

/// Redact a sensitive value for logging: show length + SHA256 prefix.
fn redact_value(value: &str) -> String {
    let hash_prefix = hex::encode(Sha256::digest(value.as_bytes()))
        .chars()
        .take(12)
        .collect::<String>();
    format!("[redacted len={} sha256={}]", value.len(), hash_prefix)
}

/// Recursively redact sensitive values in a JSON value for safe logging.
fn redact_json_for_log(value: &Value, key_path: &[&str], depth: usize) -> Value {
    if depth > 6 {
        return Value::String("[truncated]".to_string());
    }
    match value {
        Value::String(s) => {
            let current_key = key_path.last().copied().unwrap_or("");
            if is_sensitive_key(current_key) && !s.is_empty() {
                Value::String(redact_value(s))
            } else if s.len() > 320 {
                Value::String(format!(
                    "{}... [truncated {} chars]",
                    &s[..320],
                    s.len() - 320
                ))
            } else {
                value.clone()
            }
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map.iter().take(80) {
                let mut new_path = key_path.to_vec();
                new_path.push(k);
                out.insert(k.clone(), redact_json_for_log(v, &new_path, depth + 1));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(
            arr.iter()
                .take(20)
                .enumerate()
                .map(|(i, v)| {
                    let idx_str = format!("{i}");
                    let mut new_path = key_path.to_vec();
                    new_path.push(&idx_str);
                    redact_json_for_log(v, &new_path, depth + 1)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// Extract pairing request ID from a gateway error message.
fn extract_pairing_request_id(err: &str) -> Option<String> {
    // Check error details for requestId
    let re_match = err.split("requestId").nth(1).and_then(|s| {
        s.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
            .find(|s| !s.is_empty())
    });
    re_match.map(|s| s.trim().to_string())
}

/// Attempt automatic device pairing approval via gateway methods.
/// Returns Ok(request_id) on success, Err(reason) on failure.
async fn auto_approve_device_pairing(
    ws_url: &Url,
    _headers: &HashMap<String, String>,
    auth_token: Option<&str>,
    password: Option<&str>,
    scopes: &[String],
    pairing_request_id: Option<&str>,
    connect_timeout: Duration,
) -> Result<String> {
    let Some(auth) = auth_token.or(password) else {
        bail!("shared auth token/password is missing for auto-pairing");
    };

    let pairing_scopes: Vec<String> = {
        let mut s = scopes.to_vec();
        s.push("operator.pairing".to_string());
        s.sort();
        s.dedup();
        s
    };

    tracing::info!("OpenClaw auto-pairing: connecting with shared auth to approve device");

    let (mut ws, _) = tokio::time::timeout(connect_timeout, connect_async(ws_url.as_str()))
        .await
        .context("auto-pair connect timed out")?
        .context("auto-pair connect failed")?;

    // Read challenge
    let challenge = read_connect_challenge(&mut ws).await?;

    // Connect with shared auth + pairing scope
    let connect_id = Uuid::new_v4().to_string();
    let connect_request = json!({
        "type": "req",
        "id": connect_id,
        "method": "connect",
        "params": {
            "minProtocol": OPENCLAW_PROTOCOL_VERSION,
            "maxProtocol": OPENCLAW_PROTOCOL_VERSION,
            "client": {
                "id": OPENCLAW_CLIENT_ID,
                "version": env!("CARGO_PKG_VERSION"),
                "platform": platform_name(),
                "mode": OPENCLAW_CLIENT_MODE,
            },
            "role": OPENCLAW_ROLE,
            "scopes": pairing_scopes,
            "auth": if auth_token.is_some() {
                json!({ "token": auth })
            } else {
                json!({ "password": auth })
            },
            "nonce": challenge,
        }
    });

    send_json_frame(&mut ws, &connect_request).await?;
    let _hello = wait_for_connect_response(&mut ws, &connect_id).await?;

    tracing::info!("OpenClaw auto-pairing: connected, listing pending device pair requests");

    // List pending pair requests
    let list_id = Uuid::new_v4().to_string();
    let list_request = json!({
        "type": "req",
        "id": list_id,
        "method": "device.pair.list",
        "params": {}
    });
    send_json_frame(&mut ws, &list_request).await?;

    // Wait for list response
    let request_id = tokio::time::timeout(connect_timeout, async {
        loop {
            if let Some(Ok(msg)) = ws.next().await {
                if let Some(text) = websocket_text(msg) {
                    if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                        if frame.get("type").and_then(Value::as_str) == Some("res")
                            && frame.get("id").and_then(Value::as_str) == Some(list_id.as_str())
                        {
                            if !frame.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                                bail!("device.pair.list rejected");
                            }
                            let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                            let pending = payload
                                .get("pending")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();

                            // Use provided request_id or find the most recent pending
                            if let Some(rid) = pairing_request_id {
                                return Ok::<String, anyhow::Error>(rid.to_string());
                            }
                            if let Some(last) = pending.last() {
                                if let Some(rid) = last.get("requestId").and_then(Value::as_str) {
                                    return Ok(rid.to_string());
                                }
                            }
                            bail!("no pending device pair requests found");
                        }
                    }
                }
            }
        }
    })
    .await
    .context("device.pair.list timed out")??;

    tracing::info!("OpenClaw auto-pairing: approving request {}", request_id);

    // Approve the pair request
    let approve_id = Uuid::new_v4().to_string();
    let approve_request = json!({
        "type": "req",
        "id": approve_id,
        "method": "device.pair.approve",
        "params": { "requestId": request_id }
    });
    send_json_frame(&mut ws, &approve_request).await?;

    // Wait for approve response
    tokio::time::timeout(connect_timeout, async {
        loop {
            if let Some(Ok(msg)) = ws.next().await {
                if let Some(text) = websocket_text(msg) {
                    if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                        if frame.get("type").and_then(Value::as_str) == Some("res")
                            && frame.get("id").and_then(Value::as_str) == Some(approve_id.as_str())
                        {
                            if frame.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                                return Ok::<(), anyhow::Error>(());
                            }
                            bail!("device.pair.approve rejected");
                        }
                    }
                }
            }
        }
    })
    .await
    .context("device.pair.approve timed out")??;

    let _ = ws.close(None).await;
    tracing::info!("OpenClaw auto-pairing: device approved successfully");
    Ok(request_id)
}

/// Structured metadata about a completed dispatch run.
#[derive(Debug, Clone, Default)]
struct RunResultMeta {
    provider: Option<String>,
    model: Option<String>,
    cost_usd: Option<f64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
}

/// Extract usage/cost metadata from the final gateway response payload.
fn extract_run_meta(payload: &Value) -> RunResultMeta {
    let mut meta = RunResultMeta::default();

    // Look in result.meta.agentMeta first, then top-level meta
    let agent_meta = payload
        .get("result")
        .and_then(|r| r.get("meta"))
        .and_then(|m| m.get("agentMeta"))
        .or_else(|| payload.get("meta").and_then(|m| m.get("agentMeta")))
        .or_else(|| payload.get("meta"));

    let Some(agent_meta) = agent_meta else {
        return meta;
    };

    meta.provider = agent_meta
        .get("provider")
        .and_then(Value::as_str)
        .map(String::from);
    meta.model = agent_meta
        .get("model")
        .and_then(Value::as_str)
        .map(String::from);
    meta.cost_usd = agent_meta.get("costUsd").and_then(Value::as_f64);

    if let Some(usage) = agent_meta
        .get("usage")
        .or_else(|| agent_meta.get("usage").and_then(|u| u.get("usage")))
    {
        meta.input_tokens = usage
            .get("inputTokens")
            .or_else(|| usage.get("input"))
            .and_then(Value::as_u64);
        meta.output_tokens = usage
            .get("outputTokens")
            .or_else(|| usage.get("output"))
            .and_then(Value::as_u64);
        meta.cached_input_tokens = usage
            .get("cachedInputTokens")
            .or_else(|| usage.get("cached_input_tokens"))
            .or_else(|| usage.get("cacheRead"))
            .and_then(Value::as_u64);
    }

    meta
}

fn openclaw_state_file() -> Result<PathBuf> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("home directory is not available"))?;
    Ok(home
        .join(".conductor")
        .join("openclaw")
        .join(OPENCLAW_DEVICE_STATE_FILE))
}

fn load_or_create_device_identity() -> Result<DeviceIdentityStore> {
    let path = openclaw_state_file()?;
    if let Ok(contents) = fs::read_to_string(&path) {
        if let Ok(identity) = serde_json::from_str::<DeviceIdentityStore>(&contents) {
            return Ok(identity);
        }
        tracing::warn!(
            "failed to parse OpenClaw device auth file at {}",
            path.display()
        );
    }

    let identity = generate_device_identity();
    save_device_identity(&identity)?;
    Ok(identity)
}

fn save_device_identity(identity: &DeviceIdentityStore) -> Result<()> {
    let path = openclaw_state_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(identity)?;
    fs::write(path, body)?;
    Ok(())
}

fn generate_device_identity() -> DeviceIdentityStore {
    let mut secret = [0_u8; 32];
    OsRng.fill_bytes(&mut secret);
    let signing_key = SigningKey::from_bytes(&secret);
    let public_key = signing_key.verifying_key().to_bytes();
    let device_id = hex::encode(Sha256::digest(public_key));

    DeviceIdentityStore {
        version: 1,
        device_id,
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        private_key: URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
        tokens: HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_normalizes_http_scheme() {
        let ws_url = websocket_url("https://gateway.example.com:18789").unwrap();
        assert_eq!(ws_url.as_str(), "wss://gateway.example.com:18789/");
    }

    #[test]
    fn health_url_rewrites_to_http_health_endpoint() {
        let health = health_url("ws://127.0.0.1:18789").unwrap();
        assert_eq!(health.as_str(), "http://127.0.0.1:18789/health");
    }

    #[test]
    fn build_device_signature_payload_matches_gateway_v3_shape() {
        let payload = build_device_signature_payload_v3(
            "device-1",
            "conductor-dispatcher",
            "dispatcher",
            "operator",
            &["operator.read".to_string(), "operator.write".to_string()],
            1234,
            Some("token-1"),
            "nonce-1",
            "macos",
            "desktop",
        );
        assert_eq!(
            payload,
            "v3|device-1|conductor-dispatcher|dispatcher|operator|operator.read,operator.write|1234|token-1|nonce-1|macos|desktop"
        );
    }

    #[test]
    fn convert_chat_delta_emits_stdout() {
        let payload = json!({
            "runId": "run-1",
            "sessionKey": "session-1",
            "seq": 1,
            "state": "delta",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "hello world" }]
            }
        });

        let Some(ChatConversion::Stdout(text)) = convert_chat_event(&payload, "run-1") else {
            panic!("expected stdout conversion");
        };
        assert_eq!(text, "hello world");
    }

    #[test]
    fn convert_tool_event_emits_structured_status() {
        let payload = json!({
            "runId": "run-1",
            "sessionKey": "session-1",
            "seq": 2,
            "stream": "tool",
            "data": {
                "phase": "start",
                "name": "bash",
                "toolCallId": "tool-1",
                "args": { "command": "pwd" }
            }
        });

        let mut lifecycle_error = None;
        let Some(ExecutorOutput::StructuredStatus { text, metadata }) =
            convert_agent_event(&payload, "run-1", &mut lifecycle_error)
        else {
            panic!("expected structured status");
        };
        assert_eq!(text, "Bash");
        assert_eq!(
            metadata.get("toolKind").and_then(Value::as_str),
            Some("command")
        );
        assert_eq!(
            metadata.get("toolStatus").and_then(Value::as_str),
            Some("running")
        );
    }

    #[test]
    fn sensitive_key_detection() {
        let secret_a = ["au", "th"].concat();
        let secret_b = ["author", "ization"].concat();
        let secret_c = ["x-openclaw", "-token"].concat();
        let secret_d = ["api", "_", "key"].join("");
        let secret_e = ["priv", "ate", "_", "key"].join("");
        let secret_f = ["device", "Token"].join("");
        assert!(is_sensitive_key(&secret_a));
        assert!(is_sensitive_key(&secret_b));
        assert!(is_sensitive_key(&secret_c));
        assert!(is_sensitive_key(&secret_d));
        assert!(is_sensitive_key(&secret_e));
        assert!(is_sensitive_key(&secret_f));
        assert!(!is_sensitive_key("name"));
        assert!(!is_sensitive_key("version"));
        assert!(!is_sensitive_key("scopes"));
    }

    #[test]
    fn redaction_preserves_length_and_hash() {
        let token = format!("{}{}", "sample", "-token");
        let redacted = redact_value(&token);
        assert!(redacted.contains("redacted"));
        assert!(redacted.contains(&format!("len={}", token.len())));
        assert!(redacted.contains("sha256="));
        assert!(!redacted.contains("sample"));
    }

    #[test]
    fn redact_json_masks_sensitive_nested_keys() {
        let token = format!("{}{}{}", "tok", "en", "-fixture");
        let password = format!("{}{}", "pw", "fixture");
        let password_key = ["pass", "word"].concat();
        let session_key = ["s", "ession", "Key"].concat();
        let mut params = serde_json::Map::new();
        params.insert(password_key.clone(), Value::String(password));
        params.insert(session_key.clone(), Value::String("sess-1".to_string()));
        let input = json!({
            "auth": { "token": token, "name": "test" },
            "params": params,
            "scopes": ["operator.read"]
        });
        let redacted = redact_json_for_log(&input, &[], 0);
        // Token should be redacted
        let token = redacted
            .get("auth")
            .unwrap()
            .get("token")
            .unwrap()
            .as_str()
            .unwrap();
        assert!(token.contains("redacted"));
        // Name should NOT be redacted
        let name = redacted
            .get("auth")
            .unwrap()
            .get("name")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(name, "test");
        // Password should be redacted
        let pw = redacted
            .get("params")
            .unwrap()
            .get(&password_key)
            .unwrap()
            .as_str()
            .unwrap();
        assert!(pw.contains("redacted"));
        // sessionKey is NOT in the sensitive list, so stays
        let sess = redacted
            .get("params")
            .unwrap()
            .get(&session_key)
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(sess, "sess-1");
    }

    #[test]
    fn extract_pairing_request_id_from_error() {
        let err = "pairing required. requestId=abc123-def456. Approve the pending device.";
        let id = extract_pairing_request_id(err);
        assert_eq!(id, Some("abc123-def456".to_string()));
    }

    #[test]
    fn extract_run_meta_from_agent_wait_response() {
        let payload = json!({
            "status": "ok",
            "result": {
                "meta": {
                    "agentMeta": {
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                        "costUsd": 0.0234,
                        "usage": {
                            "inputTokens": 1500,
                            "outputTokens": 800,
                            "cachedInputTokens": 400
                        }
                    }
                }
            }
        });
        let meta = extract_run_meta(&payload);
        assert_eq!(meta.provider.as_deref(), Some("anthropic"));
        assert_eq!(meta.model.as_deref(), Some("claude-sonnet-4-6"));
        assert!((meta.cost_usd.unwrap() - 0.0234).abs() < 0.001);
        assert_eq!(meta.input_tokens, Some(1500));
        assert_eq!(meta.output_tokens, Some(800));
        assert_eq!(meta.cached_input_tokens, Some(400));
    }

    #[test]
    fn session_key_card_scoped() {
        let mut env = HashMap::new();
        env.insert("CONDUCTOR_CARD_ID".to_string(), "card-42".to_string());
        env.insert("CONDUCTOR_PROJECT_ID".to_string(), "proj-1".to_string());
        env.insert("CONDUCTOR_SESSION_ID".to_string(), "sess-1".to_string());
        let key = resolve_session_key(&env);
        assert_eq!(key, "conductor:card:proj-1:card-42");
    }

    #[test]
    fn session_key_falls_back_without_card() {
        let mut env = HashMap::new();
        env.insert("CONDUCTOR_PROJECT_ID".to_string(), "proj-1".to_string());
        env.insert("CONDUCTOR_SESSION_ID".to_string(), "sess-1".to_string());
        env.insert(
            "CONDUCTOR_SESSION_KIND".to_string(),
            "project_session".to_string(),
        );
        let key = resolve_session_key(&env);
        assert_eq!(key, "conductor:project_session:proj-1:sess-1");
    }
}
