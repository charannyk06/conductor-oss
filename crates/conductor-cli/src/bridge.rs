use anyhow::{Context, Result};
use base64::Engine;
use conductor_types::{
    BridgeToBrowserMessage, BrowserToBridgeMessage, FileEntry, FileEntryKind,
    API_STREAM_V1_CAPABILITY,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, Mutex};
use tokio::task::{AbortHandle, Id as TaskId, JoinSet};
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
const MAX_PREVIEW_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_PREVIEW_REQUEST_BODY_BYTES: usize = 5 * 1024 * 1024;
const PREVIEW_REQUEST_TIMEOUT_SECS: u64 = 30;
const BRIDGE_CONTROL_QUEUE_CAPACITY: usize = 128;
const BRIDGE_STREAM_QUEUE_CAPACITY: usize = 128;
const MAX_BRIDGE_CONTROL_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_PROXY_STREAM_CHUNK_BYTES: usize = 48 * 1024;

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

#[derive(Debug, Clone)]
struct PreviewProxyResponse {
    status: u16,
    headers: std::collections::BTreeMap<String, String>,
    body_base64: Option<String>,
}

#[derive(Debug)]
struct StreamTaskAbortEntry {
    task_id: TaskId,
    abort_handle: AbortHandle,
}

#[derive(Debug, Default)]
struct StreamTaskAbortRegistry {
    by_request_id: HashMap<String, StreamTaskAbortEntry>,
    by_task_id: HashMap<TaskId, String>,
}

impl StreamTaskAbortRegistry {
    fn register(&mut self, request_id: String, abort_handle: AbortHandle) {
        let task_id = abort_handle.id();
        if let Some(previous) = self.by_request_id.insert(
            request_id.clone(),
            StreamTaskAbortEntry {
                task_id,
                abort_handle,
            },
        ) {
            self.by_task_id.remove(&previous.task_id);
            previous.abort_handle.abort();
        }
        self.by_task_id.insert(task_id, request_id);
    }

    fn remove_by_request_id(&mut self, request_id: &str) -> Option<StreamTaskAbortEntry> {
        let entry = self.by_request_id.remove(request_id)?;
        self.by_task_id.remove(&entry.task_id);
        Some(entry)
    }

    fn remove_by_task_id(&mut self, task_id: TaskId) -> Option<StreamTaskAbortEntry> {
        let request_id = self.by_task_id.remove(&task_id)?;
        self.by_request_id.remove(&request_id)
    }

    fn drain_abort_handles(&mut self) -> Vec<AbortHandle> {
        self.by_task_id.clear();
        self.by_request_id
            .drain()
            .map(|(_, entry)| entry.abort_handle)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConnectionOutcome {
    Reconnect { error: Option<String> },
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
        version: Some(conductor_core::BUILD_VERSION.to_string()),
        capabilities: vec![API_STREAM_V1_CAPABILITY.to_string()],
    }
}

fn register_stream_task_abort(
    registry: &Arc<StdMutex<StreamTaskAbortRegistry>>,
    request_id: String,
    abort_handle: AbortHandle,
) {
    if let Ok(mut aborts) = registry.lock() {
        aborts.register(request_id, abort_handle);
    }
}

fn remove_completed_stream_task_abort(
    registry: &Arc<StdMutex<StreamTaskAbortRegistry>>,
    task_id: TaskId,
) {
    if let Ok(mut aborts) = registry.lock() {
        aborts.remove_by_task_id(task_id);
    }
}

fn cancel_stream_task_abort(registry: &Arc<StdMutex<StreamTaskAbortRegistry>>, request_id: &str) {
    if let Ok(mut aborts) = registry.lock() {
        if let Some(entry) = aborts.remove_by_request_id(request_id) {
            entry.abort_handle.abort();
        }
    }
}

fn abort_all_stream_tasks(registry: &Arc<StdMutex<StreamTaskAbortRegistry>>) {
    if let Ok(mut aborts) = registry.lock() {
        for abort_handle in aborts.drain_abort_handles() {
            abort_handle.abort();
        }
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

fn resolve_proxy_url(backend: &Url, path: &str) -> Result<Url> {
    if path.starts_with("http://") || path.starts_with("https://") {
        Url::parse(path).context("invalid proxied URL")
    } else {
        backend.join(path).context("failed to resolve backend URL")
    }
}

fn sanitize_proxy_request_headers(
    headers: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let mut sanitized = BTreeMap::new();
    for (name, value) in headers {
        let lower = name.trim().to_ascii_lowercase();
        if lower.is_empty()
            || matches!(
                lower.as_str(),
                "authorization"
                    | "cookie"
                    | "host"
                    | "connection"
                    | "content-length"
                    | "transfer-encoding"
                    | "x-forwarded-host"
                    | "x-forwarded-proto"
            )
        {
            continue;
        }
        if lower.contains('\r') || lower.contains('\n') {
            anyhow::bail!("invalid proxy request header name");
        }
        let clean_value = sanitize_header_value(value);
        sanitized.insert(lower, clean_value);
    }
    Ok(sanitized)
}

fn sanitize_proxy_response_headers(
    headers: &reqwest::header::HeaderMap,
) -> BTreeMap<String, String> {
    let mut sanitized = BTreeMap::new();
    for (name, value) in headers.iter() {
        let name = name.as_str().to_ascii_lowercase();
        match name.as_str() {
            "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "content-length"
            | "content-encoding"
            | "upgrade"
            | "proxy-authenticate"
            | "proxy-authentication-info"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "set-cookie"
            | "set-cookie2" => {
                continue;
            }
            _ => {}
        }

        let value = match value.to_str() {
            Ok(value) => sanitize_header_value(value),
            Err(_) => continue,
        };
        if value.contains('\r') || value.contains('\n') {
            continue;
        }
        sanitized.insert(name, value);
    }
    sanitized
}

fn build_proxy_request(
    client: &reqwest::Client,
    backend: &Url,
    method: &str,
    path: &str,
    headers: &BTreeMap<String, String>,
    body: Option<Value>,
) -> Result<reqwest::RequestBuilder> {
    let method = method
        .parse::<reqwest::Method>()
        .context("invalid HTTP method")?;
    let url = resolve_proxy_url(backend, path)?;
    let mut request = client.request(method, url);
    for (name, value) in sanitize_proxy_request_headers(headers)? {
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .context("invalid proxy request header name")?;
        let header_value = reqwest::header::HeaderValue::from_str(&value)
            .context("invalid proxy request header value")?;
        request = request.header(header_name, header_value);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    Ok(request)
}

async fn proxy_request(
    client: &reqwest::Client,
    backend: &Url,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<BackendProxyResponse> {
    let response = build_proxy_request(client, backend, method, path, &BTreeMap::new(), body)?
        .send()
        .await?;
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

fn bridge_message_to_text(payload: &BridgeToBrowserMessage) -> Result<String> {
    let encoded = serde_json::to_string(payload)?;
    if encoded.len() > MAX_BRIDGE_CONTROL_MESSAGE_BYTES {
        anyhow::bail!("bridge control payload exceeded the websocket message size limit");
    }
    Ok(encoded)
}

fn try_send_bridge_payload(
    tx: &mpsc::Sender<Message>,
    payload: &BridgeToBrowserMessage,
) -> Result<()> {
    let text = bridge_message_to_text(payload)?;
    tx.try_send(Message::Text(text.into()))
        .map_err(|err| anyhow::anyhow!("bridge outbound queue is unavailable: {err}"))
}

async fn send_bridge_payload(
    tx: &mpsc::Sender<Message>,
    payload: &BridgeToBrowserMessage,
) -> Result<()> {
    let text = bridge_message_to_text(payload)?;
    tx.send(Message::Text(text.into()))
        .await
        .map_err(|_| anyhow::anyhow!("bridge outbound queue is closed"))
}

async fn send_stream_failure_response(
    tx: &mpsc::Sender<Message>,
    id: &str,
    status: u16,
    message: &str,
) -> Result<()> {
    send_bridge_payload(
        tx,
        &BridgeToBrowserMessage::ApiStreamStart {
            id: id.to_string(),
            status,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
        },
    )
    .await?;
    send_bridge_payload(
        tx,
        &BridgeToBrowserMessage::ApiStreamChunk {
            id: id.to_string(),
            chunk_base64: base64::engine::general_purpose::STANDARD
                .encode(json!({ "error": message }).to_string().as_bytes()),
        },
    )
    .await?;
    send_bridge_payload(
        tx,
        &BridgeToBrowserMessage::ApiStreamEnd {
            id: id.to_string(),
            error: None,
        },
    )
    .await
}

struct ProxyStreamRequest {
    id: String,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Option<Value>,
}

struct ProxyStreamContext {
    client: reqwest::Client,
    backend: Url,
    stream_tx: mpsc::Sender<Message>,
}

async fn proxy_stream_request(
    context: ProxyStreamContext,
    request: ProxyStreamRequest,
) -> Result<()> {
    let ProxyStreamContext {
        client,
        backend,
        stream_tx,
    } = context;
    let ProxyStreamRequest {
        id,
        method,
        path,
        headers,
        body,
    } = request;

    let response = match build_proxy_request(&client, &backend, &method, &path, &headers, body)?
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            send_stream_failure_response(
                &stream_tx,
                &id,
                StatusCode::BAD_GATEWAY.as_u16(),
                &err.to_string(),
            )
            .await?;
            return Ok(());
        }
    };

    let status = response.status().as_u16();
    let response_headers = sanitize_proxy_response_headers(response.headers());
    let chunk_stream = Box::pin(futures_util::stream::unfold(
        response,
        |mut response| async move {
            match response.chunk().await {
                Ok(Some(chunk)) => Some((Ok(chunk.to_vec()), response)),
                Ok(None) => None,
                Err(err) => Some((Err(err.to_string()), response)),
            }
        },
    ));

    forward_proxy_stream_response(id, status, response_headers, stream_tx, chunk_stream).await
}

async fn forward_proxy_stream_response(
    id: String,
    status: u16,
    headers: BTreeMap<String, String>,
    tx: mpsc::Sender<Message>,
    mut chunks: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = std::result::Result<Vec<u8>, String>> + Send>,
    >,
) -> Result<()> {
    send_bridge_payload(
        &tx,
        &BridgeToBrowserMessage::ApiStreamStart {
            id: id.clone(),
            status,
            headers,
        },
    )
    .await?;

    while let Some(chunk) = chunks.next().await {
        match chunk {
            Ok(chunk) => {
                for part in chunk.chunks(MAX_PROXY_STREAM_CHUNK_BYTES) {
                    send_bridge_payload(
                        &tx,
                        &BridgeToBrowserMessage::ApiStreamChunk {
                            id: id.clone(),
                            chunk_base64: base64::engine::general_purpose::STANDARD.encode(part),
                        },
                    )
                    .await?;
                }
            }
            Err(err) => {
                send_bridge_payload(
                    &tx,
                    &BridgeToBrowserMessage::ApiStreamEnd {
                        id,
                        error: Some(err),
                    },
                )
                .await?;
                return Ok(());
            }
        }
    }

    send_bridge_payload(
        &tx,
        &BridgeToBrowserMessage::ApiStreamEnd { id, error: None },
    )
    .await
}

async fn proxy_preview_request(
    client: &reqwest::Client,
    session_id: &str,
    method: &str,
    url: &str,
    headers: &std::collections::BTreeMap<String, String>,
    body_base64: Option<&str>,
) -> Result<PreviewProxyResponse> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        anyhow::bail!("preview session id is required");
    }

    let method_str = method.trim().to_uppercase();
    // Cloudflare allowlist: only safe methods, block CONNECT/TRACE/TRACK
    match method_str.as_str() {
        "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" => {}
        _ => anyhow::bail!("forbidden HTTP method: {method_str}"),
    }
    let method = method_str
        .parse::<reqwest::Method>()
        .context("invalid HTTP method")?;

    let url_str = url.trim();
    let parsed_url = Url::parse(url_str).context("invalid preview URL")?;

    // Scheme allowlist — block data:, javascript:, file:, etc.
    match parsed_url.scheme() {
        "http" | "https" => {}
        _ => anyhow::bail!(
            "forbidden URL scheme: {}. only http/https are allowed",
            parsed_url.scheme()
        ),
    }

    // Preview requests intentionally target the paired machine's own dev server.
    // Keep the bridge path loopback-only, but do not block localhost itself.
    let host = parsed_url.host_str().unwrap_or("");
    if let Some(blocked) = check_preview_host_allowed(host, parsed_url.port()) {
        tracing::warn!(target: "conductor-bridge", "preview host blocked: {}", blocked);
        anyhow::bail!("request to {} is not allowed", host);
    }

    // Block URLs with userinfo (e.g., http://user:pass@evil.com/)
    if !parsed_url.username().is_empty() {
        anyhow::bail!("URLs with userinfo are not allowed");
    }

    // Decode and size-check request body before sending
    let body_bytes: Option<Vec<u8>> = if let Some(raw_body) = body_base64 {
        if !raw_body.trim().is_empty() {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(raw_body.as_bytes())
                .context("decode preview request body")?;
            if decoded.len() > MAX_PREVIEW_REQUEST_BODY_BYTES {
                anyhow::bail!(
                    "preview request body exceeded {MAX_PREVIEW_REQUEST_BODY_BYTES} bytes"
                );
            }
            Some(decoded)
        } else {
            None
        }
    } else {
        None
    };

    // Sanitize request headers — strip CR/LF to prevent header injection
    let sanitized_headers = sanitize_preview_request_headers(headers)
        .map_err(|e| anyhow::anyhow!("header sanitization failed: {e}"))?;

    let timeout = Duration::from_secs(PREVIEW_REQUEST_TIMEOUT_SECS);
    let mut request = client.request(method, parsed_url).timeout(timeout);

    for (name, value) in &sanitized_headers {
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .context(format!("invalid header name: {name}"))?;
        let header_value = reqwest::header::HeaderValue::from_str(value)
            .context(format!("invalid header value for {name}"))?;
        request = request.header(header_name, header_value);
    }

    if let Some(body) = body_bytes {
        request = request.body(body);
    }

    let response = request.send().await?;
    let status = response.status().as_u16();
    let response_headers = sanitize_preview_response_headers(response.headers());
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_PREVIEW_RESPONSE_BYTES {
        anyhow::bail!("preview response exceeded {MAX_PREVIEW_RESPONSE_BYTES} bytes");
    }

    Ok(PreviewProxyResponse {
        status,
        headers: response_headers,
        body_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
    })
}

fn is_allowed_preview_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Resolve a hostname and allow only paired-device loopback preview targets.
/// Returns the block reason, if any.
fn check_preview_host_allowed(host: &str, _port: Option<u16>) -> Option<String> {
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost"
        || host_lower == "ip6-localhost"
        || host_lower == "ip6-loopback"
        || host_lower == "::1"
        || host_lower == "[::1]"
        || host_lower == "0.0.0.0"
    {
        return None;
    }

    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_allowed_preview_ip(&ip) {
            return None;
        }
        return Some(format!("non-loopback preview IP: {host}"));
    }

    Some(format!("non-loopback preview hostname: {host}"))
}

/// Strips CR/LF characters from header names and values to prevent response splitting attacks.
fn sanitize_header_value(value: &str) -> String {
    value.chars().filter(|&c| c != '\r' && c != '\n').collect()
}

fn sanitize_preview_request_headers(
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut sanitized = std::collections::BTreeMap::new();
    for (name, value) in headers {
        // Reject headers containing CR/LF (header injection)
        if name.contains('\r') || name.contains('\n') {
            return Err(format!(
                "invalid header name with control character: {name}"
            ));
        }
        let clean_value = sanitize_header_value(value);
        sanitized.insert(name.clone(), clean_value);
    }
    Ok(sanitized)
}

fn sanitize_preview_response_headers(
    headers: &reqwest::header::HeaderMap,
) -> std::collections::BTreeMap<String, String> {
    let mut sanitized = std::collections::BTreeMap::new();
    for (name, value) in headers.iter() {
        let name = name.as_str().to_ascii_lowercase();
        match name.as_str() {
            // Strip all hop-by-hop headers (RFC 7230 §6.1)
            "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "content-length"
            | "content-encoding"
            | "upgrade"
            | "proxy-authenticate"
            | "proxy-authentication-info"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "upgrade-insecure-requests"
            | "x-served-by"
            | "x-cache" => {
                continue;
            }
            _ => {}
        }

        let value = match value.to_str() {
            Ok(value) => sanitize_header_value(value),
            Err(_) => continue,
        };

        // Don't let through any header that could be used for response splitting
        if value.contains('\r') || value.contains('\n') {
            continue;
        }

        sanitized.insert(name, value);
    }

    // Inject defense-in-depth security headers (Cloudflare pattern)
    sanitized.insert("x-content-type-options".to_string(), "nosniff".to_string());
    sanitized.insert("x-frame-options".to_string(), "DENY".to_string());
    sanitized.insert("x-xss-protection".to_string(), "1; mode=block".to_string());
    sanitized.insert(
        "referrer-policy".to_string(),
        "strict-origin-when-cross-origin".to_string(),
    );
    sanitized.insert(
        "content-security-policy".to_string(),
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
            .to_string(),
    );

    sanitized
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
    bridge_tx: mpsc::Sender<Message>,
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
            if let Ok(text) = bridge_message_to_text(&message) {
                if bridge_tx.try_send(Message::Text(text.into())).is_err() {
                    break;
                }
            }
        }

        last_output = output.to_string();
    }
}

async fn recv_prioritized_bridge_message(
    control_rx: &mut mpsc::Receiver<Message>,
    stream_rx: &mut mpsc::Receiver<Message>,
) -> Option<Message> {
    loop {
        match control_rx.try_recv() {
            Ok(message) => return Some(message),
            Err(mpsc::error::TryRecvError::Disconnected) if stream_rx.is_closed() => return None,
            Err(mpsc::error::TryRecvError::Disconnected | mpsc::error::TryRecvError::Empty) => {}
        }

        tokio::select! {
            biased;
            control = control_rx.recv() => match control {
                Some(message) => return Some(message),
                None if stream_rx.is_closed() => return None,
                None => {}
            },
            stream = stream_rx.recv(), if !stream_rx.is_closed() => match stream {
                Some(message) => return Some(message),
                None if control_rx.is_closed() => return None,
                None => {}
            },
        }
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
    let (control_tx, mut control_rx) = mpsc::channel::<Message>(BRIDGE_CONTROL_QUEUE_CAPACITY);
    let (stream_tx, mut stream_rx) = mpsc::channel::<Message>(BRIDGE_STREAM_QUEUE_CAPACITY);
    let stop = Arc::new(AtomicBool::new(false));
    let active_session = Arc::new(Mutex::new(None::<String>));
    let mut stream_tasks = JoinSet::new();
    let stream_task_aborts = Arc::new(StdMutex::new(StreamTaskAbortRegistry::default()));

    let writer = tokio::spawn(async move {
        while let Some(message) =
            recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx).await
        {
            if outbound.send(message).await.is_err() {
                break;
            }
        }
    });

    let heartbeat_tx = control_tx.clone();
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
            if let Ok(payload) = bridge_message_to_text(&status_payload(true)) {
                if heartbeat_tx
                    .try_send(Message::Text(payload.into()))
                    .is_err()
                {
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
        control_tx.clone(),
    ));

    if let Ok(payload) = bridge_message_to_text(&status_payload(true)) {
        let _ = control_tx.try_send(Message::Text(payload.into()));
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
            Some(joined) = stream_tasks.join_next_with_id(), if !stream_tasks.is_empty() => {
                let completed_task_id = match &joined {
                    Ok((task_id, _)) => *task_id,
                    Err(err) => err.id(),
                };
                remove_completed_stream_task_abort(&stream_task_aborts, completed_task_id);
                if let Err(err) = joined {
                    if err.is_cancelled() {
                        continue;
                    }
                    tracing::warn!(error = %err, "bridge API stream task failed");
                }
            }
            _ = disconnect_check.tick() => {
                if load_token()?.is_none() {
                    break ConnectionOutcome::Exit;
                }
            }
            message = inbound.next() => {
                let Some(message) = message else {
                    break ConnectionOutcome::Reconnect { error: None };
                };
                match message {
                    Ok(Message::Text(text)) => {
                        let text = text.to_string();
                        match serde_json::from_str::<BrowserToBridgeMessage>(&text) {
                            Ok(event) => {
                                match event {
                                    BrowserToBridgeMessage::Ping => {
                                        let _ = try_send_bridge_payload(&control_tx, &BridgeToBrowserMessage::Pong);
                                    }
                                    BrowserToBridgeMessage::FileBrowse { path } => {
                                        let entries = browse_path(&path);
                                        let _ = try_send_bridge_payload(
                                            &control_tx,
                                            &BridgeToBrowserMessage::FileTree { path, entries },
                                        );
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
                                                let _ = try_send_bridge_payload(&control_tx, &BridgeToBrowserMessage::ApiResponse {
                                                    id,
                                                    status: response.status,
                                                    body: response.body,
                                                });
                                            }
                                            Err(err) => {
                                                let _ = try_send_bridge_payload(&control_tx, &BridgeToBrowserMessage::ApiResponse {
                                                    id,
                                                    status: StatusCode::BAD_GATEWAY.as_u16(),
                                                    body: json!({ "error": err.to_string() }),
                                                });
                                            }
                                        }
                                    }
                                    BrowserToBridgeMessage::ApiStreamRequest {
                                        id,
                                        method,
                                        path,
                                        headers,
                                        body,
                                    } => {
                                        let context = ProxyStreamContext {
                                            stream_tx: stream_tx.clone(),
                                            client: client.clone(),
                                            backend: backend.clone(),
                                        };
                                        let request = ProxyStreamRequest {
                                            id,
                                            method,
                                            path,
                                            headers,
                                            body,
                                        };
                                        let failure_tx = context.stream_tx.clone();
                                        let stream_id = request.id.clone();
                                        let abort_handle = stream_tasks.spawn(async move {
                                            let fallback_id = request.id.clone();
                                            if let Err(err) =
                                                proxy_stream_request(context, request).await
                                            {
                                                let _ = send_stream_failure_response(
                                                    &failure_tx,
                                                    &fallback_id,
                                                    StatusCode::BAD_GATEWAY.as_u16(),
                                                    &err.to_string(),
                                                )
                                                .await;
                                            }
                                        });
                                        register_stream_task_abort(
                                            &stream_task_aborts,
                                            stream_id,
                                            abort_handle,
                                        );
                                    }
                                    BrowserToBridgeMessage::ApiStreamCancel { id } => {
                                        cancel_stream_task_abort(&stream_task_aborts, &id);
                                    }
                                    BrowserToBridgeMessage::PreviewRequest {
                                        id,
                                        session_id,
                                        method,
                                        url,
                                        headers,
                                        body_base64,
                                    } => {
                                        let payload = match proxy_preview_request(
                                            &client,
                                            &session_id,
                                            &method,
                                            &url,
                                            &headers,
                                            body_base64.as_deref(),
                                        )
                                        .await
                                        {
                                            Ok(response) => BridgeToBrowserMessage::PreviewResponse {
                                                id,
                                                status: response.status,
                                                headers: response.headers,
                                                body_base64: response.body_base64,
                                            },
                                            Err(err) => {
                                                let status = StatusCode::BAD_GATEWAY.as_u16();
                                                BridgeToBrowserMessage::PreviewResponse {
                                                    id,
                                                    status,
                                                    headers: std::collections::BTreeMap::from([(
                                                        "content-type".to_string(),
                                                        "text/plain; charset=utf-8".to_string(),
                                                    )]),
                                                    body_base64: Some(
                                                        base64::engine::general_purpose::STANDARD
                                                            .encode(err.to_string()),
                                                    ),
                                                }
                                            }
                                        };
                                        let _ = try_send_bridge_payload(&control_tx, &payload);
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
                        let _ = control_tx.try_send(Message::Pong(data));
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(Message::Binary(_)) => {}
                    Ok(Message::Frame(_)) => {}
                    Ok(Message::Close(_)) => {
                        break ConnectionOutcome::Reconnect { error: None };
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "bridge relay connection dropped");
                        break ConnectionOutcome::Reconnect {
                            error: Some(err.to_string()),
                        };
                    }
                }
            }
        }
    };

    abort_all_stream_tasks(&stream_task_aborts);
    stream_tasks.abort_all();
    while let Some(joined) = stream_tasks.join_next().await {
        if let Err(err) = joined {
            if !err.is_cancelled() {
                tracing::warn!(error = %err, "bridge API stream task failed during shutdown");
            }
        }
    }
    drop(control_tx);
    drop(stream_tx);
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
            Ok(ConnectionOutcome::Reconnect { error }) => {
                // A reconnect outcome means the websocket handshake completed.
                // Do not carry dial-failure backoff across a healthy session.
                backoff = Duration::from_secs(1);
                save_state(&BridgeRuntimeState {
                    relay_url: relay_url.to_string(),
                    connected: false,
                    last_error: error,
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

    #[test]
    fn preview_host_allows_loopback_dev_servers() {
        assert_eq!(check_preview_host_allowed("localhost", Some(3000)), None);
        assert_eq!(check_preview_host_allowed("127.0.0.1", Some(3000)), None);
        assert_eq!(check_preview_host_allowed("[::1]", Some(3000)), None);
        assert_eq!(check_preview_host_allowed("0.0.0.0", Some(3000)), None);
    }

    #[test]
    fn preview_host_blocks_non_loopback_targets() {
        assert!(check_preview_host_allowed("192.168.1.1", Some(80)).is_some());
        assert!(check_preview_host_allowed("example.com", Some(443)).is_some());
        assert!(check_preview_host_allowed("metadata.google.internal", Some(80)).is_some());
    }

    #[tokio::test]
    async fn bridge_writer_prioritizes_control_queue_over_stream_backlog() {
        let (control_tx, mut control_rx) = mpsc::channel::<Message>(1);
        let (stream_tx, mut stream_rx) = mpsc::channel::<Message>(1);

        stream_tx
            .try_send(Message::Text("stream".into()))
            .expect("stream backlog should fit in its own queue");
        control_tx
            .try_send(Message::Text("control".into()))
            .expect("control queue should stay available even when stream queue is full");

        let first = recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("prioritized reader should return a message");
        assert_eq!(first, Message::Text("control".into()));

        let second = recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("prioritized reader should return the queued stream message");
        assert_eq!(second, Message::Text("stream".into()));
    }

    #[tokio::test]
    async fn proxy_stream_request_emits_start_chunk_end_without_blocking_other_control_messages() {
        let (upstream_tx, upstream_rx) = mpsc::channel::<std::result::Result<Vec<u8>, String>>(4);
        let (control_tx, mut control_rx) = mpsc::channel::<Message>(BRIDGE_CONTROL_QUEUE_CAPACITY);
        let (stream_tx, mut stream_rx) = mpsc::channel::<Message>(BRIDGE_STREAM_QUEUE_CAPACITY);
        let chunk_stream = Box::pin(futures_util::stream::unfold(
            upstream_rx,
            |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
        ));
        let stream_task = tokio::spawn(forward_proxy_stream_response(
            "stream-1".to_string(),
            200,
            BTreeMap::from([
                ("content-type".to_string(), "text/event-stream".to_string()),
                (
                    "cache-control".to_string(),
                    "no-cache, no-transform".to_string(),
                ),
                ("x-accel-buffering".to_string(), "no".to_string()),
            ]),
            stream_tx.clone(),
            chunk_stream,
        ));

        let start = match recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("stream should emit start")
        {
            Message::Text(text) => {
                serde_json::from_str::<BridgeToBrowserMessage>(&text).expect("decode start")
            }
            other => panic!("expected text message, got {other:?}"),
        };
        assert_eq!(
            start,
            BridgeToBrowserMessage::ApiStreamStart {
                id: "stream-1".to_string(),
                status: 200,
                headers: BTreeMap::from([
                    (
                        "cache-control".to_string(),
                        "no-cache, no-transform".to_string()
                    ),
                    ("content-type".to_string(), "text/event-stream".to_string()),
                    ("x-accel-buffering".to_string(), "no".to_string()),
                ]),
            }
        );

        upstream_tx
            .send(Ok(b"chunk-1".to_vec()))
            .await
            .expect("send first chunk");
        try_send_bridge_payload(&control_tx, &BridgeToBrowserMessage::Pong).expect("queue pong");
        let pong = recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("pong should be forwarded before the stream finishes");
        assert!(matches!(pong, Message::Text(_)));
        if let Message::Text(text) = pong {
            assert_eq!(
                serde_json::from_str::<BridgeToBrowserMessage>(&text).expect("decode pong"),
                BridgeToBrowserMessage::Pong
            );
        }

        let first_chunk = match recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("first chunk should arrive")
        {
            Message::Text(text) => {
                serde_json::from_str::<BridgeToBrowserMessage>(&text).expect("decode first chunk")
            }
            other => panic!("expected text message, got {other:?}"),
        };
        assert_eq!(
            first_chunk,
            BridgeToBrowserMessage::ApiStreamChunk {
                id: "stream-1".to_string(),
                chunk_base64: base64::engine::general_purpose::STANDARD.encode(b"chunk-1"),
            }
        );

        assert!(
            tokio::time::timeout(
                Duration::from_millis(25),
                recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx),
            )
            .await
            .is_err(),
            "the stream should stay open until the second chunk is released"
        );

        upstream_tx
            .send(Ok(b"chunk-2".to_vec()))
            .await
            .expect("send second chunk");
        drop(upstream_tx);
        let second_chunk = match recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("second chunk should arrive")
        {
            Message::Text(text) => {
                serde_json::from_str::<BridgeToBrowserMessage>(&text).expect("decode second chunk")
            }
            other => panic!("expected text message, got {other:?}"),
        };
        assert_eq!(
            second_chunk,
            BridgeToBrowserMessage::ApiStreamChunk {
                id: "stream-1".to_string(),
                chunk_base64: base64::engine::general_purpose::STANDARD.encode(b"chunk-2"),
            }
        );
        let end = match recv_prioritized_bridge_message(&mut control_rx, &mut stream_rx)
            .await
            .expect("stream should end cleanly")
        {
            Message::Text(text) => {
                serde_json::from_str::<BridgeToBrowserMessage>(&text).expect("decode end")
            }
            other => panic!("expected text message, got {other:?}"),
        };
        assert_eq!(
            end,
            BridgeToBrowserMessage::ApiStreamEnd {
                id: "stream-1".to_string(),
                error: None,
            }
        );

        stream_task
            .await
            .expect("stream task join")
            .expect("stream task");
    }

    #[tokio::test]
    async fn stream_task_registry_cleans_up_fast_completed_streams_after_registration() {
        let registry = Arc::new(StdMutex::new(StreamTaskAbortRegistry::default()));
        let mut stream_tasks = JoinSet::new();
        let abort_handle = stream_tasks.spawn(async {});

        tokio::task::yield_now().await;
        register_stream_task_abort(&registry, "stream-fast".to_string(), abort_handle);

        let joined = stream_tasks
            .join_next_with_id()
            .await
            .expect("fast stream should complete");
        let completed_task_id = match joined {
            Ok((task_id, ())) => task_id,
            Err(err) => panic!("fast stream should not fail: {err}"),
        };
        remove_completed_stream_task_abort(&registry, completed_task_id);

        let aborts = registry.lock().expect("registry lock");
        assert!(aborts.by_request_id.is_empty());
        assert!(aborts.by_task_id.is_empty());
    }

    #[tokio::test]
    async fn api_stream_cancel_aborts_only_the_matching_stream_task() {
        let registry = Arc::new(StdMutex::new(StreamTaskAbortRegistry::default()));
        let mut stream_tasks = JoinSet::new();
        let (survivor_tx, survivor_rx) = tokio::sync::oneshot::channel::<()>();

        let cancelled_handle = stream_tasks.spawn(async {
            std::future::pending::<()>().await;
            false
        });
        let cancelled_task_id = cancelled_handle.id();
        register_stream_task_abort(&registry, "stream-cancelled".to_string(), cancelled_handle);

        let survivor_handle = stream_tasks.spawn(async move {
            survivor_rx
                .await
                .expect("survivor should receive completion");
            true
        });
        let survivor_task_id = survivor_handle.id();
        register_stream_task_abort(&registry, "stream-survivor".to_string(), survivor_handle);

        cancel_stream_task_abort(&registry, "stream-cancelled");

        {
            let aborts = registry.lock().expect("registry lock");
            assert!(!aborts.by_request_id.contains_key("stream-cancelled"));
            assert!(aborts.by_request_id.contains_key("stream-survivor"));
        }

        survivor_tx.send(()).expect("send completion");

        let mut cancelled_joined = false;
        let mut survivor_joined = false;
        while let Some(joined) = stream_tasks.join_next_with_id().await {
            let completed_task_id = match &joined {
                Ok((task_id, _)) => *task_id,
                Err(err) => err.id(),
            };
            remove_completed_stream_task_abort(&registry, completed_task_id);
            match joined {
                Ok((task_id, result)) => {
                    if task_id == survivor_task_id {
                        assert!(result, "survivor stream should complete normally");
                        survivor_joined = true;
                    } else {
                        panic!("unexpected successful stream task: {task_id}");
                    }
                }
                Err(err) => {
                    assert!(err.is_cancelled(), "unexpected join error: {err}");
                    assert_eq!(err.id(), cancelled_task_id);
                    cancelled_joined = true;
                }
            }
            if cancelled_joined && survivor_joined {
                break;
            }
        }

        assert!(cancelled_joined, "matching stream should be cancelled");
        assert!(survivor_joined, "non-matching stream should keep running");

        let aborts = registry.lock().expect("registry lock");
        assert!(aborts.by_request_id.is_empty());
        assert!(aborts.by_task_id.is_empty());
    }
}
