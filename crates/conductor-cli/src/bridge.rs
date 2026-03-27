use anyhow::{Context, Result};
use base64::Engine;
use conductor_types::{BridgeToBrowserMessage, BrowserToBridgeMessage, FileEntry, FileEntryKind};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Mutex};
use tokio::time::sleep;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderValue, Request},
        Message,
    },
};
use url::Url;
use uuid::Uuid;

const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:4749";
const BRIDGE_STATE_FILENAME: &str = "bridge-state.json";
const BRIDGE_TOKEN_FILENAME: &str = "bridge-token";
const CONTROL_SCOPE: &str = "conductor-bridge-control";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BridgeRuntimeState {
    relay_url: String,
    connected: bool,
    last_error: Option<String>,
    active_session_id: Option<String>,
    updated_at_unix: u64,
}

#[derive(Debug, Clone)]
struct BackendProxyResponse {
    status: u16,
    body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionOutcome {
    Reconnect,
    Exit,
}

pub fn token_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".conductor")
            .join(BRIDGE_TOKEN_FILENAME)
    })
}

fn state_path() -> Option<PathBuf> {
    token_path().and_then(|path| {
        path.parent()
            .map(|parent| parent.join(BRIDGE_STATE_FILENAME))
    })
}

pub fn save_token(token: &str) -> Result<()> {
    let path = token_path().context("home directory unavailable")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(&path)?;
    file.write_all(token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn load_token() -> Result<Option<String>> {
    let Some(path) = token_path() else {
        return Ok(None);
    };
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value.trim().to_string())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn clear_token() -> Result<()> {
    if let Some(path) = token_path() {
        match fs::remove_file(path) {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    clear_state()?;
    Ok(())
}

fn save_state(state: &BridgeRuntimeState) -> Result<()> {
    let Some(path) = state_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(state)?;
    fs::write(path, json)?;
    Ok(())
}

fn load_state() -> Result<Option<BridgeRuntimeState>> {
    let Some(path) = state_path() else {
        return Ok(None);
    };
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(serde_json::from_str(&value)?)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn clear_state() -> Result<()> {
    if let Some(path) = state_path() {
        match fs::remove_file(path) {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn status_payload(connected: bool) -> BridgeToBrowserMessage {
    BridgeToBrowserMessage::BridgeStatus {
        hostname: hostname(),
        os: std::env::consts::OS.to_string(),
        connected,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
    }
}

fn default_backend_url() -> Result<Url> {
    resolve_backend_url(None)
}

fn resolve_backend_url(explicit: Option<&str>) -> Result<Url> {
    if let Some(value) = explicit {
        let parsed = Url::parse(value).context("invalid backend URL")?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            anyhow::bail!("backend URL must use http or https");
        }
        return Ok(parsed);
    }

    if let Ok(value) = std::env::var("CONDUCTOR_BACKEND_URL") {
        if !value.trim().is_empty() {
            return resolve_backend_url(Some(value.trim()));
        }
    }

    if let Ok(value) = std::env::var("CONDUCTOR_BACKEND_PORT") {
        let port = value.trim();
        if !port.is_empty() {
            let parsed = port
                .parse::<u16>()
                .context("invalid CONDUCTOR_BACKEND_PORT")?;
            return Url::parse(&format!("http://127.0.0.1:{parsed}"))
                .context("invalid backend URL");
        }
    }

    Url::parse(DEFAULT_BACKEND_URL).context("invalid default backend URL")
}

fn normalize_relay_ws_url(relay: &str) -> Result<Url> {
    let mut url = Url::parse(relay).context("invalid relay URL")?;
    match url.scheme() {
        "http" => {
            if url.set_scheme("ws").is_err() {
                anyhow::bail!("failed to convert relay URL to ws");
            }
        }
        "https" => {
            if url.set_scheme("wss").is_err() {
                anyhow::bail!("failed to convert relay URL to wss");
            }
        }
        "ws" | "wss" => {}
        other => anyhow::bail!("unsupported relay scheme: {other}"),
    }
    Ok(url)
}

fn bridge_websocket_url(relay: &str, token: &str) -> Result<String> {
    let mut url = normalize_relay_ws_url(relay)?;
    url.set_path(&format!("/bridge/{CONTROL_SCOPE}"));
    url.query_pairs_mut().clear().append_pair("token", token);
    Ok(url.to_string())
}

fn relay_terminal_bridge_websocket_url(
    relay: &str,
    terminal_id: &str,
    token: &str,
) -> Result<String> {
    let mut url = normalize_relay_ws_url(relay)?;
    url.set_path(&format!("/terminal/{terminal_id}/bridge"));
    url.query_pairs_mut().clear().append_pair("token", token);
    Ok(url.to_string())
}

fn resolve_backend_terminal_websocket_url(backend: &Url, candidate: &str) -> Result<Url> {
    let mut url = if candidate.starts_with("ws://") || candidate.starts_with("wss://") {
        Url::parse(candidate).context("invalid ttyd websocket URL")?
    } else {
        backend
            .join(candidate)
            .context("failed to resolve ttyd websocket URL")?
    };

    match url.scheme() {
        "http" => {
            let _ = url.set_scheme("ws");
        }
        "https" => {
            let _ = url.set_scheme("wss");
        }
        "ws" | "wss" => {}
        other => anyhow::bail!("unsupported ttyd websocket scheme: {other}"),
    }

    Ok(url)
}

async fn proxy_request(
    client: &reqwest::Client,
    backend: &Url,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<BackendProxyResponse> {
    let method = method
        .parse::<reqwest::Method>()
        .context("invalid HTTP method")?;
    let url = if path.starts_with("http://") || path.starts_with("https://") {
        Url::parse(path).context("invalid proxied URL")?
    } else {
        backend
            .join(path)
            .context("failed to resolve backend URL")?
    };

    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request.send().await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let bytes = response.bytes().await?;

    let body = if bytes.is_empty() {
        Value::Null
    } else if content_type.contains("application/json") {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()))
    } else if content_type.starts_with("text/")
        || content_type.contains("html")
        || content_type.contains("javascript")
        || content_type.contains("xml")
    {
        Value::String(String::from_utf8_lossy(&bytes).to_string())
    } else {
        json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes.as_ref()),
            "contentType": content_type,
        })
    };

    Ok(BackendProxyResponse { status, body })
}

fn extract_session_id(path: &str) -> Option<String> {
    let path = path.split('?').next().unwrap_or(path).trim();
    let mut segments = path.trim_start_matches('/').split('/');
    match (segments.next(), segments.next(), segments.next()) {
        (Some("api"), Some("sessions"), Some(session_id)) if !session_id.is_empty() => {
            Some(session_id.to_string())
        }
        _ => None,
    }
}

fn session_output_path(session_id: &str) -> String {
    format!("/api/sessions/{session_id}/output?lines=500")
}

async fn fetch_local_ttyd_ws_url(
    client: &reqwest::Client,
    backend: &Url,
    session_id: &str,
) -> Result<Url> {
    let path = format!("/api/sessions/{session_id}/terminal/token");
    let response = proxy_request(client, backend, "GET", &path, None).await?;
    if response.status != StatusCode::OK.as_u16() {
        let message = response
            .body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("failed to resolve ttyd token");
        anyhow::bail!("{message}");
    }

    let ttyd_ws_url = response
        .body
        .get("ttydWsUrl")
        .and_then(Value::as_str)
        .context("missing ttyd websocket URL")?;
    resolve_backend_terminal_websocket_url(backend, ttyd_ws_url)
}

fn ttyd_frontend_websocket_request(url: &Url) -> Result<Request<()>> {
    let mut request = url
        .as_str()
        .into_client_request()
        .context("failed to build local ttyd websocket request")?;
    request
        .headers_mut()
        .insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("tty"));
    Ok(request)
}

async fn run_terminal_proxy_session(
    relay: String,
    token: String,
    client: reqwest::Client,
    backend: Url,
    terminal_id: String,
    session_id: String,
) -> Result<()> {
    let relay_ws_url = relay_terminal_bridge_websocket_url(&relay, &terminal_id, &token)?;
    let local_ttyd_ws_url = fetch_local_ttyd_ws_url(&client, &backend, &session_id).await?;
    let local_ttyd_ws_request = ttyd_frontend_websocket_request(&local_ttyd_ws_url)?;

    let (relay_ws, _) = connect_async(relay_ws_url.as_str()).await?;
    let (local_ttyd_ws, _) = connect_async(local_ttyd_ws_request).await?;
    let (mut relay_write, mut relay_read) = relay_ws.split();
    let (mut local_write, mut local_read) = local_ttyd_ws.split();

    loop {
        tokio::select! {
            relay_message = relay_read.next() => {
                match relay_message {
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(message)) => {
                        let should_close = matches!(message, Message::Close(_));
                        local_write.send(message).await?;
                        if should_close {
                            break;
                        }
                    }
                    Some(Err(err)) => return Err(err.into()),
                    None => break,
                }
            }
            local_message = local_read.next() => {
                match local_message {
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(message)) => {
                        let should_close = matches!(message, Message::Close(_));
                        relay_write.send(message).await?;
                        if should_close {
                            break;
                        }
                    }
                    Some(Err(err)) => return Err(err.into()),
                    None => break,
                }
            }
        }
    }

    Ok(())
}

async fn update_active_session(
    active_session: &Arc<Mutex<Option<String>>>,
    session_id: Option<String>,
) {
    let mut current = active_session.lock().await;
    *current = session_id;
}

async fn current_active_session(active_session: &Arc<Mutex<Option<String>>>) -> Option<String> {
    active_session.lock().await.clone()
}

async fn poll_session_output(
    stop: Arc<AtomicBool>,
    active_session: Arc<Mutex<Option<String>>>,
    client: reqwest::Client,
    backend: Url,
    bridge_tx: mpsc::UnboundedSender<Message>,
) {
    let mut current_session = String::new();
    let mut last_output = String::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tick.tick().await;
        if stop.load(Ordering::Relaxed) {
            break;
        }

        let Some(session_id) = current_active_session(&active_session).await else {
            current_session.clear();
            last_output.clear();
            continue;
        };

        if session_id != current_session {
            current_session = session_id.clone();
            last_output.clear();
        }

        let path = session_output_path(&session_id);
        let Ok(response) = proxy_request(&client, &backend, "GET", &path, None).await else {
            continue;
        };

        if response.status != 200 {
            continue;
        }

        let Some(output) = response.body.get("output").and_then(Value::as_str) else {
            continue;
        };

        let delta = if output.starts_with(&last_output) {
            output[last_output.len()..].to_string()
        } else {
            format!("\u{000c}{output}")
        };

        if !delta.is_empty() {
            let message = BridgeToBrowserMessage::TerminalOutput { data: delta };
            if let Ok(text) = serde_json::to_string(&message) {
                if bridge_tx.send(Message::Text(text.into())).is_err() {
                    break;
                }
            }
        }

        last_output = output.to_string();
    }
}

async fn run_bridge_connection_once(
    relay: &str,
    token: &str,
    client: reqwest::Client,
    backend: Url,
) -> Result<ConnectionOutcome> {
    let ws_url = bridge_websocket_url(relay, token)?;
    let (ws, _) = connect_async(ws_url.as_str()).await?;
    let (mut outbound, mut inbound) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let stop = Arc::new(AtomicBool::new(false));
    let active_session = Arc::new(Mutex::new(None::<String>));

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if outbound.send(message).await.is_err() {
                break;
            }
        }
    });

    let heartbeat_tx = tx.clone();
    let heartbeat_stop = stop.clone();
    let heartbeat_task = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        loop {
            heartbeat.tick().await;
            if heartbeat_stop.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(payload) = serde_json::to_string(&status_payload(true)) {
                if heartbeat_tx.send(Message::Text(payload.into())).is_err() {
                    break;
                }
            }
        }
    });

    let poller_stop = stop.clone();
    let poller_task = tokio::spawn(poll_session_output(
        poller_stop,
        active_session.clone(),
        client.clone(),
        backend.clone(),
        tx.clone(),
    ));

    if let Ok(payload) = serde_json::to_string(&status_payload(true)) {
        let _ = tx.send(Message::Text(payload.into()));
    }
    save_state(&BridgeRuntimeState {
        relay_url: relay.to_string(),
        connected: true,
        last_error: None,
        active_session_id: None,
        updated_at_unix: unix_timestamp(),
    })?;

    let mut disconnect_check = tokio::time::interval(Duration::from_secs(5));
    disconnect_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    disconnect_check.tick().await;

    let outcome = loop {
        tokio::select! {
            _ = disconnect_check.tick() => {
                if load_token()?.is_none() {
                    break ConnectionOutcome::Exit;
                }
            }
            message = inbound.next() => {
                let Some(message) = message else {
                    break ConnectionOutcome::Reconnect;
                };
                match message {
                    Ok(Message::Text(text)) => {
                        let text = text.to_string();
                        match serde_json::from_str::<BrowserToBridgeMessage>(&text) {
                            Ok(event) => {
                                match event {
                                    BrowserToBridgeMessage::Ping => {
                                        let payload = serde_json::to_string(&BridgeToBrowserMessage::Pong)?;
                                        let _ = tx.send(Message::Text(payload.into()));
                                    }
                                    BrowserToBridgeMessage::FileBrowse { path } => {
                                        let entries = browse_path(&path);
                                        let payload = serde_json::to_string(&BridgeToBrowserMessage::FileTree { path, entries })?;
                                        let _ = tx.send(Message::Text(payload.into()));
                                    }
                                    BrowserToBridgeMessage::ApiRequest { id, method, path, body } => {
                                        if let Some(session_id) = extract_session_id(&path) {
                                            update_active_session(&active_session, Some(session_id.clone())).await;
                                            save_state(&BridgeRuntimeState {
                                                relay_url: relay.to_string(),
                                                connected: true,
                                                last_error: None,
                                                active_session_id: Some(session_id),
                                                updated_at_unix: unix_timestamp(),
                                            })?;
                                        }

                                        match proxy_request(&client, &backend, &method, &path, body).await {
                                            Ok(response) => {
                                                let payload = BridgeToBrowserMessage::ApiResponse {
                                                    id,
                                                    status: response.status,
                                                    body: response.body,
                                                };
                                                let _ = tx.send(Message::Text(serde_json::to_string(&payload)?.into()));
                                            }
                                            Err(err) => {
                                                let payload = BridgeToBrowserMessage::ApiResponse {
                                                    id,
                                                    status: StatusCode::BAD_GATEWAY.as_u16(),
                                                    body: json!({ "error": err.to_string() }),
                                                };
                                                let _ = tx.send(Message::Text(serde_json::to_string(&payload)?.into()));
                                            }
                                        }
                                    }
                                    BrowserToBridgeMessage::PreviewRequest { id, .. } => {
                                        let payload = BridgeToBrowserMessage::PreviewResponse {
                                            id,
                                            status: StatusCode::NOT_IMPLEMENTED.as_u16(),
                                            headers: std::collections::BTreeMap::from([(
                                                "content-type".to_string(),
                                                "text/plain; charset=utf-8".to_string(),
                                            )]),
                                            body_base64: Some(
                                                base64::engine::general_purpose::STANDARD
                                                    .encode("Preview proxy is not implemented in this bridge runtime."),
                                            ),
                                        };
                                        let _ = tx.send(Message::Text(serde_json::to_string(&payload)?.into()));
                                    }
                                    BrowserToBridgeMessage::TerminalInput { data } => {
                                        if let Some(session_id) = current_active_session(&active_session).await {
                                            let path = format!("/api/sessions/{session_id}/keys");
                                            let _ = proxy_request(
                                                &client,
                                                &backend,
                                                "POST",
                                                &path,
                                                Some(json!({ "keys": data })),
                                            )
                                            .await;
                                        }
                                    }
                                    BrowserToBridgeMessage::TerminalResize { .. } => {}
                                    BrowserToBridgeMessage::TerminalProxyStart { terminal_id, session_id } => {
                                        let relay = relay.to_string();
                                        let token = token.to_string();
                                        let client = client.clone();
                                        let backend = backend.clone();
                                        tokio::spawn(async move {
                                            if let Err(err) = run_terminal_proxy_session(
                                                relay,
                                                token,
                                                client,
                                                backend,
                                                terminal_id,
                                                session_id,
                                            ).await {
                                                tracing::warn!(error = %err, "bridge ttyd proxy session closed");
                                            }
                                        });
                                    }
                                }
                            }
                            Err(err) => {
                                tracing::warn!(error = %err, "bridge websocket received invalid browser payload");
                            }
                        }
                    }
                    Ok(Message::Ping(data)) => {
                        let _ = tx.send(Message::Pong(data));
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(Message::Binary(_)) => {}
                    Ok(Message::Frame(_)) => {}
                    Ok(Message::Close(_)) => {
                        break ConnectionOutcome::Reconnect;
                    }
                    Err(err) => return Err(err.into()),
                }
            }
        }
    };

    drop(tx);
    stop.store(true, Ordering::Relaxed);
    let _ = heartbeat_task.await;
    let _ = poller_task.await;
    let _ = writer.await;

    save_state(&BridgeRuntimeState {
        relay_url: relay.to_string(),
        connected: false,
        last_error: None,
        active_session_id: load_state()?.and_then(|state| state.active_session_id),
        updated_at_unix: unix_timestamp(),
    })?;

    Ok(outcome)
}

pub async fn connect(relay: String, token: Option<String>) -> Result<()> {
    let token = match token.or_else(|| load_token().ok().flatten()) {
        Some(token) => token,
        None => {
            let generated = Uuid::new_v4().simple().to_string();
            save_token(&generated)?;
            println!("Bridge token: {generated}");
            generated
        }
    };

    let backend = default_backend_url()?;
    let relay_url = normalize_relay_ws_url(&relay)?;
    save_state(&BridgeRuntimeState {
        relay_url: relay_url.to_string(),
        connected: false,
        last_error: None,
        active_session_id: None,
        updated_at_unix: unix_timestamp(),
    })?;

    let mut backoff = Duration::from_secs(1);
    loop {
        if load_token()?.is_none() {
            clear_state()?;
            return Ok(());
        }

        match run_bridge_connection_once(
            relay_url.as_ref(),
            &token,
            reqwest::Client::new(),
            backend.clone(),
        )
        .await
        {
            Ok(ConnectionOutcome::Exit) => {
                clear_state()?;
                return Ok(());
            }
            Ok(ConnectionOutcome::Reconnect) => {
                save_state(&BridgeRuntimeState {
                    relay_url: relay_url.to_string(),
                    connected: false,
                    last_error: None,
                    active_session_id: load_state()?.and_then(|state| state.active_session_id),
                    updated_at_unix: unix_timestamp(),
                })?;
            }
            Err(err) => {
                save_state(&BridgeRuntimeState {
                    relay_url: relay_url.to_string(),
                    connected: false,
                    last_error: Some(err.to_string()),
                    active_session_id: load_state()?.and_then(|state| state.active_session_id),
                    updated_at_unix: unix_timestamp(),
                })?;
            }
        }

        if load_token()?.is_none() {
            clear_state()?;
            return Ok(());
        }

        sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

pub fn status() -> Result<String> {
    let token_present = load_token()?.is_some();
    let state = load_state()?;
    if let Some(state) = state {
        if state.connected && token_present {
            let session = state
                .active_session_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("none");
            return Ok(format!(
                "connected\nrelay: {}\nactive session: {session}\nlast updated: {}",
                state.relay_url, state.updated_at_unix
            ));
        }

        return Ok(format!(
            "disconnected\nrelay: {}\nreason: {}",
            state.relay_url,
            state
                .last_error
                .unwrap_or_else(|| "not connected".to_string())
        ));
    }

    if token_present {
        Ok("disconnected\nbridge token saved".to_string())
    } else {
        Ok("disconnected".to_string())
    }
}

pub fn disconnect() -> Result<()> {
    clear_token()
}

pub fn browse_path(path: &str) -> Vec<FileEntry> {
    let workspace_root = std::env::current_dir()
        .ok()
        .and_then(|path| fs::canonicalize(path).ok())
        .unwrap_or_else(|| PathBuf::from("."));

    let requested = if path.trim().is_empty() {
        workspace_root.clone()
    } else {
        let candidate = Path::new(path);
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            workspace_root.join(candidate)
        }
    };

    let canonical = match fs::canonicalize(&requested) {
        Ok(value) => value,
        Err(_) => requested,
    };

    if !canonical.starts_with(&workspace_root) {
        return Vec::new();
    }

    let directory = match fs::metadata(&canonical) {
        Ok(metadata) if metadata.is_dir() => canonical,
        Ok(_) => canonical
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| workspace_root.clone()),
        Err(_) => canonical,
    };

    let mut entries = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&directory) {
        for entry in read_dir.flatten() {
            let kind = if entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
            {
                FileEntryKind::Dir
            } else {
                FileEntryKind::File
            };
            entries.push(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                kind,
            });
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttyd_frontend_websocket_request_adds_tty_subprotocol() {
        let url =
            Url::parse("ws://127.0.0.1:4749/api/sessions/session-1/terminal/ttyd/ws?token=test")
                .expect("valid url");
        let request = ttyd_frontend_websocket_request(&url).expect("request should build");
        assert_eq!(
            request
                .headers()
                .get(SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok()),
            Some("tty")
        );
    }
}
