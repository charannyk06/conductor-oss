use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header::AUTHORIZATION, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use conductor_types::{BrowserToBridgeMessage, BridgeStatus, BridgeToBrowserMessage};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct RelayState {
    inner: Arc<Mutex<RelayInner>>,
}

#[derive(Debug, Default)]
struct RelayInner {
    channels: HashMap<String, BridgeChannel>,
    shares: HashMap<String, ShareRecord>,
    pairing_codes: HashMap<String, PendingPairing>,
    devices: HashMap<String, DeviceRecord>,
    refresh_tokens: HashMap<String, String>,
    rate_limits: HashMap<String, RateBucket>,
    next_connection_id: u64,
}

#[derive(Debug, Default)]
struct BridgeChannel {
    bridge: Option<ConnectionRecord>,
    browsers: HashMap<u64, ConnectionRecord>,
    last_status: Option<BridgeStatus>,
}

#[derive(Debug, Clone)]
struct ConnectionRecord {
    id: u64,
    user_id: String,
    tx: mpsc::UnboundedSender<Message>,
}

#[derive(Debug, Clone)]
struct ShareRecord {
    bridge_token: String,
    session_scope: String,
    read_only: bool,
    created_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingPairing {
    owner_user_id: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    device_id: String,
    owner_user_id: String,
    name: String,
    hostname: String,
    os: String,
    arch: String,
    refresh_token: String,
}

#[derive(Debug)]
struct RateBucket {
    tokens: f64,
    last_refill: Instant,
}

impl RateBucket {
    fn new(now: Instant) -> Self {
        Self {
            tokens: 120.0,
            last_refill: now,
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        const MAX_TOKENS: f64 = 120.0;
        const REFILL_PER_SECOND: f64 = 2.0;

        let elapsed = now.saturating_duration_since(self.last_refill).as_secs_f64();
        self.last_refill = now;
        self.tokens = (self.tokens + elapsed * REFILL_PER_SECOND).min(MAX_TOKENS);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WsQuery {
    token: Option<String>,
    jwt: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ShareCreateRequest {
    session_id: Option<String>,
    session_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ShareListItem {
    share_id: String,
    session_scope: String,
    browser_url: String,
    read_only: bool,
    created_at_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
struct BridgeListItem {
    bridge_id: String,
    browser_count: usize,
    connected: bool,
    last_status: Option<BridgeStatus>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceCodeCreateRequest {
    suggested_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceCodeCreateResponse {
    code: String,
    expires_in: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct DevicePairRequest {
    code: String,
    device_id: String,
    hostname: String,
    os: String,
    arch: String,
}

#[derive(Debug, Clone, Serialize)]
struct DevicePairResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    device_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceListItem {
    device_id: String,
    device_name: String,
    hostname: String,
    os: String,
    arch: String,
    connected: bool,
    last_status: Option<BridgeStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct RelayHealth {
    ok: bool,
    bridge_channels: usize,
    browser_connections: usize,
    share_links: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerKind {
    Bridge,
    Browser,
}

const DEFAULT_BIND_ADDR: &str = "0.0.0.0:8080";
const DEFAULT_JWT_SECRET_ENV: &str = "RELAY_JWT_SECRET";
const SHARE_PREFIX: &str = "share-";
const PAIRING_CODE_TTL: Duration = Duration::from_secs(10 * 60);
const DEVICE_ACCESS_TOKEN_TTL_SECS: u64 = 3600;
const PROXY_AUTHORIZED_HEADER: &str = "x-conductor-proxy-authorized";
const PROXY_EMAIL_HEADER: &str = "x-conductor-access-email";
const PROXY_LOCAL_USER_HEADER: &str = "x-bridge-user-id";

pub async fn serve() -> Result<()> {
    let bind_addr = env::var("RELAY_BIND_ADDR").unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_string());
    let state = RelayState::default();
    let app = build_router(state);
    let listener = TcpListener::bind(&bind_addr).await?;
    info!(%bind_addr, "relay listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_router(state: RelayState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/bridges", get(list_bridges))
        .route("/api/bridges/:bridge_id", delete(delete_bridge))
        .route("/api/devices/code", post(create_pairing_code))
        .route("/api/devices/pair", post(pair_device))
        .route("/api/devices/list", get(list_devices))
        .route("/api/devices/:device_id", delete(delete_device))
        .route("/api/shares", get(list_shares).post(create_share))
        .route("/api/shares/:share_id", delete(delete_share))
        .route("/bridge/:scope", get(bridge_ws))
        .route("/browser/:scope", get(browser_ws))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
                .allow_headers([
                    AUTHORIZATION,
                    axum::http::header::ACCEPT,
                    axum::http::header::CONTENT_TYPE,
                ])
                .allow_credentials(true),
        )
        .with_state(state)
}

async fn health(State(state): State<RelayState>) -> Json<RelayHealth> {
    let inner = state.inner.lock().await;
    let bridge_channels = inner.channels.values().filter(|channel| channel.bridge.is_some()).count();
    let browser_connections = inner
        .channels
        .values()
        .map(|channel| channel.browsers.len())
        .sum();
    Json(RelayHealth {
        ok: true,
        bridge_channels,
        browser_connections,
        share_links: inner.shares.len(),
    })
}

async fn list_bridges(State(state): State<RelayState>) -> Json<Value> {
    let inner = state.inner.lock().await;
    let mut bridges: HashMap<String, BridgeListItem> = HashMap::new();

    for channel in inner.channels.values() {
        let Some(bridge) = channel.bridge.as_ref() else {
            continue;
        };

        let entry = bridges.entry(bridge.user_id.clone()).or_insert_with(|| BridgeListItem {
            bridge_id: bridge.user_id.clone(),
            browser_count: 0,
            connected: true,
            last_status: channel.last_status.clone(),
        });
        entry.browser_count += channel.browsers.len();
        entry.connected = true;
        if channel.last_status.is_some() {
            entry.last_status = channel.last_status.clone();
        }
    }

    Json(json!({ "bridges": bridges.into_values().collect::<Vec<_>>() }))
}

async fn create_pairing_code(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<DeviceCodeCreateRequest>,
) -> Response {
    let Some(user_id) = resolve_proxy_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing proxied dashboard user." })),
        )
            .into_response();
    };

    let code = state
        .create_pairing_code(user_id, body.suggested_name.unwrap_or_default())
        .await;

    (
        StatusCode::CREATED,
        Json(DeviceCodeCreateResponse {
            code,
            expires_in: PAIRING_CODE_TTL.as_secs(),
        }),
    )
        .into_response()
}

async fn pair_device(
    State(state): State<RelayState>,
    Json(body): Json<DevicePairRequest>,
) -> Response {
    match state.pair_device(body).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn list_devices(State(state): State<RelayState>, headers: HeaderMap) -> Response {
    let Some(user_id) = resolve_proxy_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing proxied dashboard user." })),
        )
            .into_response();
    };

    let devices = state.list_devices_for_user(&user_id).await;
    (StatusCode::OK, Json(json!({ "devices": devices }))).into_response()
}

async fn delete_device(
    State(state): State<RelayState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(user_id) = resolve_proxy_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing proxied dashboard user." })),
        )
            .into_response();
    };

    match state.delete_device(&user_id, &device_id).await {
        Ok(removed) => {
            if removed {
                (
                    StatusCode::OK,
                    Json(json!({ "device_id": device_id, "deleted": true })),
                )
                    .into_response()
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Device not found." })),
                )
                    .into_response()
            }
        }
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn delete_bridge(
    State(state): State<RelayState>,
    Path(bridge_id): Path<String>,
) -> Response {
    let (bridge_closes, browser_closes, removed) = state.disconnect_bridge(&bridge_id).await;
    close_senders(bridge_closes).await;
    close_senders(browser_closes).await;

    if removed {
        (
            StatusCode::OK,
            Json(json!({ "bridgeId": bridge_id, "deleted": true })),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Bridge not found." })),
        )
            .into_response()
    }
}

async fn list_shares(State(state): State<RelayState>) -> Json<Value> {
    let inner = state.inner.lock().await;
    let shares: Vec<ShareListItem> = inner
        .shares
        .iter()
        .map(|(share_id, share)| ShareListItem {
            share_id: share_id.clone(),
            session_scope: share.session_scope.clone(),
            browser_url: format!("/browser/{}{}", SHARE_PREFIX, share_id),
            read_only: share.read_only,
            created_at_secs: share.created_at.elapsed().as_secs(),
        })
        .collect();
    Json(json!({ "shares": shares }))
}

async fn create_share(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    Json(body): Json<ShareCreateRequest>,
) -> Response {
    let bridge_token = match resolve_token(&headers, query.token.as_deref()) {
        Some(token) => token,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Missing bridge token." })),
            )
                .into_response();
        }
    };

    let session_scope = match body
        .session_scope
        .or(body.session_id)
        .map(|value| value.trim().to_string())
    {
        Some(scope) if !scope.is_empty() => scope,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Missing session id." })),
            )
                .into_response();
        }
    };

    let share_id = Uuid::new_v4().to_string();
    let browser_url = format!("/browser/{}{}", SHARE_PREFIX, share_id);
    let mut inner = state.inner.lock().await;
    inner.shares.insert(
        share_id.clone(),
        ShareRecord {
            bridge_token,
            session_scope: session_scope.clone(),
            read_only: true,
            created_at: Instant::now(),
        },
    );

    (
        StatusCode::CREATED,
        Json(json!({
            "shareId": share_id,
            "sessionScope": session_scope,
            "browserUrl": browser_url,
            "readOnly": true,
        })),
    )
        .into_response()
}

async fn delete_share(
    State(state): State<RelayState>,
    Path(share_id): Path<String>,
) -> Response {
    let mut inner = state.inner.lock().await;
    if inner.shares.remove(&share_id).is_some() {
        (
            StatusCode::OK,
            Json(json!({ "shareId": share_id, "deleted": true })),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Share link not found." })),
        )
            .into_response()
    }
}

async fn browser_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(scope): Path<String>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    let scope = scope.trim().to_string();
    if scope.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing scope." })),
        )
            .into_response();
    }

    let (bridge_key, read_only, user_id) = match resolve_browser_connection(&state, &scope, &headers, query.token.as_deref()).await {
        Ok(value) => value,
        Err(response) => return response,
    };

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_connection(state, bridge_key, PeerKind::Browser, read_only, user_id, socket, None).await {
            warn!(error = %err, "browser websocket closed");
        }
    })
    .into_response()
}

async fn bridge_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(scope): Path<String>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    let Some(token) = resolve_token(&headers, query.token.as_deref()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing bridge token." })),
        )
            .into_response();
    };

    let (channel_key, user_id, initial_status) = if let Some(device) = state.resolve_device_auth(&token).await {
        (
            device.device_id.clone(),
            device.owner_user_id.clone(),
            Some(BridgeStatus {
                hostname: device.name.clone(),
                os: format_device_os(&device.os, &device.arch),
                connected: true,
            }),
        )
    } else {
        (
            scope.trim().to_string(),
            resolve_user_id(query.jwt.as_deref(), Some(&token)),
            None,
        )
    };

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_connection(
            state,
            channel_key,
            PeerKind::Bridge,
            false,
            user_id,
            socket,
            initial_status,
        )
        .await
        {
            warn!(error = %err, "bridge websocket closed");
        }
    })
    .into_response()
}

async fn resolve_browser_connection(
    state: &RelayState,
    scope: &str,
    headers: &HeaderMap,
    token: Option<&str>,
) -> Result<(String, bool, String), Response> {
    if let Some(share_id) = scope.strip_prefix(SHARE_PREFIX) {
        let inner = state.inner.lock().await;
        let Some(share) = inner.shares.get(share_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Share link not found." })),
            )
                .into_response());
        };
        let user_id = resolve_user_id(None, Some(&share.bridge_token));
        return Ok((share.bridge_token.clone(), share.read_only, user_id));
    }

    let Some(bridge_token) = resolve_token(headers, token) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing bridge token." })),
        )
            .into_response());
    };

    let user_id = resolve_user_id(None, Some(&bridge_token));
    Ok((bridge_token, false, user_id))
}

async fn handle_connection(
    state: RelayState,
    key: String,
    peer_kind: PeerKind,
    read_only: bool,
    user_id: String,
    socket: WebSocket,
    initial_status: Option<BridgeStatus>,
) -> Result<()> {
    let (mut outbound, mut inbound) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let connection_id = state
        .register_connection(&key, peer_kind, user_id.clone(), tx.clone(), initial_status)
        .await;

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if outbound.send(message).await.is_err() {
                break;
            }
        }
    });

    match peer_kind {
        PeerKind::Bridge => state.broadcast_bridge_status(&key, true).await,
        PeerKind::Browser => state.send_browser_status_snapshot(&key, &tx).await,
    }

    while let Some(message) = inbound.next().await {
        let message = match message {
            Ok(message) => message,
            Err(err) => {
                drop(tx);
                let _ = writer.await;
                state.unregister_connection(&key, peer_kind, connection_id).await;
                return Err(err.into());
            }
        };

        match message {
            Message::Text(text) => {
                let raw_text = text.to_string();
                match peer_kind {
                    PeerKind::Bridge => match serde_json::from_str::<BridgeToBrowserMessage>(&raw_text) {
                        Ok(parsed) => state.route_bridge_message(&key, parsed, raw_text).await,
                        Err(err) => warn!(error = %err, "bridge message decode failed"),
                    },
                    PeerKind::Browser => match serde_json::from_str::<BrowserToBridgeMessage>(&raw_text) {
                        Ok(parsed) => {
                            if let Err(err) = state
                                .route_browser_message(&key, &user_id, read_only, parsed, raw_text, &tx)
                                .await
                            {
                                warn!(error = %err, "browser message routing failed");
                            }
                        }
                        Err(err) => warn!(error = %err, "browser message decode failed"),
                    },
                }
            }
            Message::Ping(data) => {
                let _ = tx.send(Message::Pong(data));
            }
            Message::Pong(_) => {}
            Message::Binary(_) => {}
            Message::Close(_) => {
                break;
            }
        }
    }

    drop(tx);
    state.unregister_connection(&key, peer_kind, connection_id).await;
    let _ = writer.await;
    Ok(())
}

impl RelayState {
    async fn register_connection(
        &self,
        key: &str,
        peer_kind: PeerKind,
        user_id: String,
        tx: mpsc::UnboundedSender<Message>,
        initial_status: Option<BridgeStatus>,
    ) -> u64 {
        let mut inner = self.inner.lock().await;
        let connection_id = inner.next_connection_id;
        inner.next_connection_id = inner.next_connection_id.saturating_add(1);
        let channel = inner.channels.entry(key.to_string()).or_default();
        let record = ConnectionRecord {
            id: connection_id,
            user_id,
            tx,
        };

        match peer_kind {
            PeerKind::Bridge => {
                channel.bridge = Some(record);
                channel.last_status = Some(initial_status.unwrap_or_else(|| BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected: true,
                }));
            }
            PeerKind::Browser => {
                channel.browsers.insert(connection_id, record);
            }
        }

        connection_id
    }

    async fn unregister_connection(&self, key: &str, peer_kind: PeerKind, connection_id: u64) {
        let mut browsers_to_notify = Vec::new();
        let mut remove_channel = false;
        let mut status_to_broadcast = None;

        {
            let mut inner = self.inner.lock().await;
            if let Some(channel) = inner.channels.get_mut(key) {
                match peer_kind {
                    PeerKind::Bridge => {
                        if channel
                            .bridge
                            .as_ref()
                            .is_some_and(|record| record.id == connection_id)
                        {
                            channel.bridge = None;
                            let status = channel
                                .last_status
                                .clone()
                                .map(|last| BridgeStatus {
                                    hostname: last.hostname,
                                    os: last.os,
                                    connected: false,
                                })
                                .unwrap_or(BridgeStatus {
                                    hostname: host_name(),
                                    os: env::consts::OS.to_string(),
                                    connected: false,
                                });
                            channel.last_status = Some(status.clone());
                            status_to_broadcast = Some(status);
                            browsers_to_notify = channel
                                .browsers
                                .values()
                                .map(|record| record.tx.clone())
                                .collect();
                        }
                    }
                    PeerKind::Browser => {
                        channel.browsers.remove(&connection_id);
                    }
                }

                if channel.bridge.is_none() && channel.browsers.is_empty() {
                    remove_channel = true;
                }
            }

            if remove_channel {
                inner.channels.remove(key);
            }
        }

        if let Some(status) = status_to_broadcast {
            if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
                hostname: status.hostname,
                os: status.os,
                connected: status.connected,
            }) {
                for browser in browsers_to_notify {
                    let _ = browser.send(Message::Text(text.clone().into()));
                }
            }
        }
    }

    async fn route_browser_message(
        &self,
        key: &str,
        user_id: &str,
        read_only: bool,
        message: BrowserToBridgeMessage,
        raw_text: String,
        browser_tx: &mpsc::UnboundedSender<Message>,
    ) -> Result<()> {
        if read_only {
            match &message {
                BrowserToBridgeMessage::Ping | BrowserToBridgeMessage::FileBrowse { .. } => {}
                BrowserToBridgeMessage::ApiRequest { id, method, .. } => {
                    if !is_safe_method(method) {
                        send_bridge_error(
                            browser_tx,
                            id,
                            StatusCode::FORBIDDEN,
                            "Read-only share links cannot send mutating requests.",
                        )
                        .await;
                        return Ok(());
                    }
                }
                BrowserToBridgeMessage::TerminalResize { .. }
                | BrowserToBridgeMessage::TerminalInput { .. } => {
                    return Ok(());
                }
            }
        }

        let now = Instant::now();
        if !self.consume_rate_limit(user_id, now).await {
            if let BrowserToBridgeMessage::ApiRequest { id, .. } = &message {
                send_bridge_error(
                    browser_tx,
                    id,
                    StatusCode::TOO_MANY_REQUESTS,
                    "Rate limit exceeded.",
                )
                .await;
            }
            return Err(anyhow::anyhow!("rate limit exceeded"));
        }

        let bridge_tx = {
            let inner = self.inner.lock().await;
            inner
                .channels
                .get(key)
                .and_then(|channel| channel.bridge.as_ref().map(|record| record.tx.clone()))
        };

        let Some(bridge_tx) = bridge_tx else {
            if let BrowserToBridgeMessage::ApiRequest { id, .. } = &message {
                send_bridge_error(
                    browser_tx,
                    id,
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Bridge is offline.",
                )
                .await;
            }
            return Ok(());
        };

        let _ = bridge_tx.send(Message::Text(raw_text.into()));
        Ok(())
    }

    async fn route_bridge_message(&self, key: &str, message: BridgeToBrowserMessage, raw_text: String) {
        let browsers = {
            let mut inner = self.inner.lock().await;
            let Some(channel) = inner.channels.get_mut(key) else {
                return;
            };

            if let BridgeToBrowserMessage::BridgeStatus {
                hostname,
                os,
                connected,
            } = &message
            {
                channel.last_status = Some(BridgeStatus {
                    hostname: hostname.clone(),
                    os: os.clone(),
                    connected: *connected,
                });
            }

            channel
                .browsers
                .values()
                .map(|record| record.tx.clone())
                .collect::<Vec<_>>()
        };

        for browser in browsers {
            let _ = browser.send(Message::Text(raw_text.clone().into()));
        }
    }

    async fn broadcast_bridge_status(&self, key: &str, connected: bool) {
        let (status, browsers) = {
            let mut inner = self.inner.lock().await;
            let Some(channel) = inner.channels.get_mut(key) else {
                return;
            };

            let status = channel
                .last_status
                .clone()
                .map(|last| BridgeStatus {
                    hostname: last.hostname,
                    os: last.os,
                    connected,
                })
                .unwrap_or(BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected,
                });

            channel.last_status = Some(status.clone());
            let browsers = channel
                .browsers
                .values()
                .map(|record| record.tx.clone())
                .collect::<Vec<_>>();
            (status, browsers)
        };

        if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
            hostname: status.hostname,
            os: status.os,
            connected: status.connected,
        }) {
            for browser in browsers {
                let _ = browser.send(Message::Text(text.clone().into()));
            }
        }
    }

    async fn send_browser_status_snapshot(&self, key: &str, tx: &mpsc::UnboundedSender<Message>) {
        let status = {
            let inner = self.inner.lock().await;
            inner
                .channels
                .get(key)
                .and_then(|channel| channel.last_status.clone())
                .unwrap_or_else(|| BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected: false,
                })
        };

        if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
            hostname: status.hostname,
            os: status.os,
            connected: status.connected,
        }) {
            let _ = tx.send(Message::Text(text.into()));
        }
    }

    async fn consume_rate_limit(&self, user_id: &str, now: Instant) -> bool {
        let mut inner = self.inner.lock().await;
        let bucket = inner
            .rate_limits
            .entry(user_id.to_string())
            .or_insert_with(|| RateBucket::new(now));
        bucket.allow(now)
    }

    async fn disconnect_bridge(
        &self,
        bridge_id: &str,
    ) -> (Vec<mpsc::UnboundedSender<Message>>, Vec<mpsc::UnboundedSender<Message>>, bool) {
        let mut bridge_txs = Vec::new();
        let mut browser_txs = Vec::new();
        let mut removed = false;

        let mut inner = self.inner.lock().await;
        let keys: Vec<String> = inner
            .channels
            .iter()
            .filter(|(key, channel)| {
                channel
                    .bridge
                    .as_ref()
                    .is_some_and(|record| record.user_id == bridge_id || key.as_str() == bridge_id)
            })
            .map(|(key, _)| key.clone())
            .collect();

        for key in keys {
            if let Some(channel) = inner.channels.remove(&key) {
                removed = true;
                if let Some(bridge) = channel.bridge {
                    bridge_txs.push(bridge.tx);
                }
                browser_txs.extend(channel.browsers.into_values().map(|record| record.tx));
            }
        }

        (bridge_txs, browser_txs, removed)
    }

    async fn create_pairing_code(&self, user_id: String, _suggested_name: String) -> String {
        let mut inner = self.inner.lock().await;
        inner.prune_pairing_codes();

        let code = generate_pairing_code();
        let now = Instant::now();
        inner.pairing_codes.insert(
            code.clone(),
            PendingPairing {
                owner_user_id: user_id,
                expires_at: now + PAIRING_CODE_TTL,
            },
        );
        code
    }

    async fn pair_device(
        &self,
        request: DevicePairRequest,
    ) -> std::result::Result<DevicePairResponse, (StatusCode, &'static str)> {
        let code = request.code.trim().to_uppercase();
        if code.is_empty()
            || request.device_id.trim().is_empty()
            || request.hostname.trim().is_empty()
            || request.os.trim().is_empty()
            || request.arch.trim().is_empty()
        {
            return Err((StatusCode::BAD_REQUEST, "Missing required pairing fields."));
        }

        let mut inner = self.inner.lock().await;
        inner.prune_pairing_codes();

        let pairing = inner
            .pairing_codes
            .remove(&code)
            .ok_or((StatusCode::NOT_FOUND, "Pairing code is invalid or expired."))?;

        let previous_refresh_token = inner
            .devices
            .get(request.device_id.trim())
            .map(|device| device.refresh_token.clone());
        if let Some(previous_refresh_token) = previous_refresh_token {
            inner.refresh_tokens.remove(&previous_refresh_token);
        }

        let access_token = Uuid::new_v4().to_string();
        let refresh_token = Uuid::new_v4().to_string();
        let device_name = request.hostname.trim().to_string();
        let device = DeviceRecord {
            device_id: request.device_id.trim().to_string(),
            owner_user_id: pairing.owner_user_id,
            name: device_name.clone(),
            hostname: request.hostname.trim().to_string(),
            os: request.os.trim().to_string(),
            arch: request.arch.trim().to_string(),
            refresh_token: refresh_token.clone(),
        };

        inner
            .refresh_tokens
            .insert(refresh_token.clone(), device.device_id.clone());
        inner.devices.insert(device.device_id.clone(), device);

        Ok(DevicePairResponse {
            access_token,
            refresh_token,
            expires_in: DEVICE_ACCESS_TOKEN_TTL_SECS,
            device_name,
        })
    }

    async fn list_devices_for_user(&self, user_id: &str) -> Vec<DeviceListItem> {
        let inner = self.inner.lock().await;
        let mut devices = inner
            .devices
            .values()
            .filter(|device| device.owner_user_id == user_id)
            .map(|device| {
                let channel = inner.channels.get(&device.device_id);
                let connected = channel
                    .and_then(|entry| entry.bridge.as_ref())
                    .is_some()
                    && channel
                        .and_then(|entry| entry.last_status.as_ref())
                        .map(|status| status.connected)
                        .unwrap_or(true);
                let last_status = channel
                    .and_then(|entry| entry.last_status.clone())
                    .or_else(|| {
                        Some(BridgeStatus {
                            hostname: device.name.clone(),
                            os: format_device_os(&device.os, &device.arch),
                            connected: false,
                        })
                    });

                DeviceListItem {
                    device_id: device.device_id.clone(),
                    device_name: device.name.clone(),
                    hostname: device.hostname.clone(),
                    os: device.os.clone(),
                    arch: device.arch.clone(),
                    connected,
                    last_status,
                }
            })
            .collect::<Vec<_>>();

        devices.sort_by(|left, right| left.device_name.cmp(&right.device_name));
        devices
    }

    async fn delete_device(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> std::result::Result<bool, (StatusCode, &'static str)> {
        let (refresh_token, removed) = {
            let mut inner = self.inner.lock().await;
            match inner.devices.get(device_id) {
                Some(device) if device.owner_user_id == user_id => {}
                Some(_) => return Err((StatusCode::FORBIDDEN, "You do not own this device.")),
                None => return Ok(false),
            }

            let refresh_token = inner
                .devices
                .remove(device_id)
                .map(|device| device.refresh_token)
                .unwrap_or_default();
            inner.refresh_tokens.remove(&refresh_token);
            (refresh_token, true)
        };

        let (bridge_closes, browser_closes, _) = self.disconnect_bridge(device_id).await;
        close_senders(bridge_closes).await;
        close_senders(browser_closes).await;
        let _ = refresh_token;

        Ok(removed)
    }

    async fn resolve_device_auth(&self, refresh_token: &str) -> Option<DeviceRecord> {
        let inner = self.inner.lock().await;
        let device_id = inner.refresh_tokens.get(refresh_token)?;
        inner.devices.get(device_id).cloned()
    }
}

impl RelayInner {
    fn prune_pairing_codes(&mut self) {
        let now = Instant::now();
        self.pairing_codes
            .retain(|_, pairing| pairing.expires_at > now);
    }
}

async fn close_senders(senders: Vec<mpsc::UnboundedSender<Message>>) {
    for sender in senders {
        let _ = sender.send(Message::Close(None));
    }
}

fn is_safe_method(method: &str) -> bool {
    matches!(method.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS")
}

async fn send_bridge_error(
    tx: &mpsc::UnboundedSender<Message>,
    id: &str,
    status: StatusCode,
    message: &str,
) {
    let response = BridgeToBrowserMessage::ApiResponse {
        id: id.to_string(),
        status: status.as_u16(),
        body: json!({ "error": message }),
    };

    if let Ok(text) = serde_json::to_string(&response) {
        let _ = tx.send(Message::Text(text.into()));
    }
}

fn resolve_token(headers: &HeaderMap, query_token: Option<&str>) -> Option<String> {
    if let Some(token) = query_token.and_then(|token| {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }) {
        return Some(token);
    }

    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_proxy_user_id(headers: &HeaderMap) -> Option<String> {
    let authorized = headers
        .get(PROXY_AUTHORIZED_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !authorized {
        return None;
    }

    headers
        .get(PROXY_EMAIL_HEADER)
        .or_else(|| headers.get(PROXY_LOCAL_USER_HEADER))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_user_id(jwt: Option<&str>, fallback: Option<&str>) -> String {
    if let Some(jwt) = jwt.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }) {
        if let Ok(user_id) = decode_github_user_id(jwt, env::var(DEFAULT_JWT_SECRET_ENV).ok().as_deref()) {
            return user_id;
        }
    }

    fallback.unwrap_or("anonymous").to_string()
}

fn host_name() -> String {
    env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn format_device_os(os: &str, arch: &str) -> String {
    format!("{}/{}", os.trim(), arch.trim())
}

fn generate_pairing_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let bytes = Uuid::new_v4().into_bytes();
    (0..6)
        .map(|index| {
            let position = bytes[index] as usize % ALPHABET.len();
            ALPHABET[position] as char
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Claims {
    sub: Option<String>,
    user_id: Option<String>,
    exp: Option<usize>,
}

fn decode_github_user_id(jwt: &str, secret: Option<&str>) -> Result<String> {
    if let Some(secret) = secret {
        let key = jsonwebtoken::DecodingKey::from_secret(secret.as_bytes());
        let claims = jsonwebtoken::decode::<Claims>(
            jwt,
            &key,
            &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
        )?;
        return claims
            .claims
            .user_id
            .or(claims.claims.sub)
            .context("missing github user id in jwt");
    }

    let payload = jwt.split('.').nth(1).context("invalid jwt")?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.as_bytes())
        .context("invalid jwt payload")?;
    let claims: Claims = serde_json::from_slice(&decoded)?;
    claims.user_id.or(claims.sub).context("missing github user id in jwt")
}
